import axios from "axios";

// In local dev, VITE_API_URL is unset and requests to "/api" are proxied to
// the local backend by vite.config.js. In production (Vercel), set
// VITE_API_URL to your deployed Render backend URL, e.g.
// https://your-backend.onrender.com — Vercel doesn't proxy API calls for you.
function getApiBase() {
  const configuredUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, "");

  if (!configuredUrl) return "/api";
  // Accept either the Render service root or an explicit /api URL.
  return configuredUrl.endsWith("/api") ? configuredUrl : `${configuredUrl}/api`;
}

const API_BASE = getApiBase();

const client = axios.create({ baseURL: API_BASE });

// A single multipart POST for a large file is limited to whatever
// throughput one TCP connection can get on the browser->server link -
// on a higher-latency connection that's often well under the link's real
// bandwidth. Splitting the file into chunks and sending several of them at
// once over separate connections uses more of the available bandwidth, and
// a chunk that fails only has to retry itself instead of restarting the
// whole (potentially multi-GB) transfer from zero.
// Only used to decide whether a file is small enough to skip chunking
// entirely (see createJobFromUpload below). The size actually used to
// slice chunks always comes from the server's /uploads/init response, so
// this value can never drift out of sync with the backend's real limit and
// cause every chunk to be rejected as "too large".
const CHUNK_SIZE_HINT = 32 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 6; // browsers allow ~6 connections per host
const CHUNK_MAX_RETRIES = 4;
// A chunk request that goes this long without a single upload-progress
// event is a dead/stalled connection, not just a slow one - this is what
// showed up in the Render logs as individual chunk requests hanging for
// ~864 seconds before eventually failing. Abort and retry it instead of
// waiting on a connection that isn't coming back. The timer resets on every
// progress event, so a genuinely slow-but-moving upload is never killed.
const CHUNK_STALL_TIMEOUT_MS = 20000;
// Covers a full server restart mid-upload (Render redeploy, container
// restart, OOM, etc - visible in the logs as "Detected service running on
// port 5000" appearing again partway through). That drops every in-flight
// chunk request at once with no response at all, which the per-chunk
// retries above (a few seconds apart) aren't long enough to ride out - a
// container typically takes 30-90s to come back up. Because the upload
// session is resumable (see /uploads/init), the right response to that is
// to wait for the server to come back and continue from the last
// successfully-saved chunk, not to fail the whole upload.
const SESSION_MAX_RETRIES = 6;
const SESSION_RETRY_DELAY_MS = 10000;

client.interceptors.response.use(
  (response) => response,
  (error) => {
    // Browsers intentionally surface CORS failures as Axios's generic
    // "Network Error", so provide the deployment action that fixes it.
    if (
      error.code === "ERR_NETWORK" &&
      import.meta.env.PROD &&
      !import.meta.env.VITE_API_URL
    ) {
      error.message =
        "The API is not configured. Set VITE_API_URL to your backend URL (for example, https://your-service.onrender.com/api) and redeploy the frontend.";
    } else if (error.code === "ERR_NETWORK") {
      error.message =
        "Cannot reach the API. Check that the backend is running and that CLIENT_ORIGIN includes this site's URL.";
    }
    return Promise.reject(error);
  }
);

export async function createJobFromUrl({ url, ownershipConfirmed, ownerCreditName }) {
  const { data } = await client.post("/jobs/from-url", {
    url,
    ownershipConfirmed,
    ownerCreditName,
  });
  return data;
}

export async function createJobFromUpload({ file, ownershipConfirmed, ownerCreditName, onProgress }) {
  // Small files: a single request has less overhead than setting up a
  // chunked session for it.
  if (file.size <= CHUNK_SIZE_HINT) {
    return uploadWholeFile({ file, ownershipConfirmed, ownerCreditName, onProgress });
  }
  return uploadFileInChunksWithSessionRetry({ file, ownershipConfirmed, ownerCreditName, onProgress });
}

async function uploadFileInChunksWithSessionRetry(params) {
  let lastError;
  for (let attempt = 1; attempt <= SESSION_MAX_RETRIES; attempt += 1) {
    try {
      return await uploadFileInChunks(params);
    } catch (error) {
      lastError = error;
      // Only retry the session for a dropped connection (no response came
      // back at all - a restart, a network blip, our own stall-abort). A
      // response that DID come back with a 4xx (bad request, session not
      // found, file too large) is a real, permanent problem - retrying
      // won't fix it, so surface it immediately instead of silently
      // retrying for a minute.
      if (error.response || attempt === SESSION_MAX_RETRIES) break;
      console.warn(
        `[upload] session interrupted (attempt ${attempt}/${SESSION_MAX_RETRIES}), ` +
          `retrying in ${SESSION_RETRY_DELAY_MS / 1000}s - the server may be restarting...`
      );
      await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function uploadWholeFile({ file, ownershipConfirmed, ownerCreditName, onProgress }) {
  const form = new FormData();
  form.append("video", file);
  form.append("ownershipConfirmed", ownershipConfirmed);
  form.append("ownerCreditName", ownerCreditName);

  const { data } = await retryNetworkRequest(() =>
    client.post("/jobs/from-upload", form, {
      onUploadProgress: (event) => {
        if (event.total) {
          onProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      },
    })
  );

  return data;
}

// A single multipart POST for a large file is limited to whatever
// throughput one TCP connection can get on the browser->server link -
// on a higher-latency connection that's often well under the link's real
// bandwidth. Splitting the file into chunks and sending several of them at
// once over separate connections uses more of the available bandwidth, and
// a chunk that fails only has to retry itself instead of restarting the
// whole (potentially multi-GB) transfer from zero.
async function uploadFileInChunks({ file, ownershipConfirmed, ownerCreditName, onProgress }) {
  const { data: initData } = await client.post("/jobs/uploads/init", {
    ownershipConfirmed,
    ownerCreditName,
    originalFileName: file.name,
    originalFileSize: file.size,
  });
  const { uploadId, chunkSize, uploadedChunks } = initData;
  // Trust the server's chunk size over any client-side assumption — this is
  // what keeps chunk slicing permanently in sync with the backend's limit.
  const CHUNK_SIZE = Number(chunkSize) > 0 ? Number(chunkSize) : CHUNK_SIZE_HINT;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadedBytesByChunk = new Array(totalChunks).fill(0);

  // If /uploads/init recognized this file (same name + size) as a session
  // that already has chunks saved on disk from a previous attempt - a page
  // refresh, a dropped connection, or a server restart - skip re-sending
  // those chunks entirely and start the progress bar from where it left off
  // instead of from 0%.
  const alreadyUploaded = new Set(Array.isArray(uploadedChunks) ? uploadedChunks : []);
  for (const index of alreadyUploaded) {
    if (index >= 0 && index < totalChunks) {
      const start = index * CHUNK_SIZE;
      uploadedBytesByChunk[index] = Math.min(CHUNK_SIZE, file.size - start);
    }
  }

  let lastReportedPct = -1;
  function reportProgress() {
    const uploaded = uploadedBytesByChunk.reduce((sum, bytes) => sum + bytes, 0);
    // Cap at 99% while chunks are in flight - the server still has to
    // assemble the parts in the "complete" step below, so 100% is reserved
    // for once the job actually exists.
    const pct = Math.min(99, Math.round((uploaded / file.size) * 100));
    if (pct !== lastReportedPct) {
      lastReportedPct = pct;
      onProgress?.(pct);
    }
  }
  reportProgress(); // reflect any resumed progress immediately, before the first byte of this session is sent

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < totalChunks) {
      const index = nextIndex++;
      if (alreadyUploaded.has(index)) continue;
      await uploadChunkWithRetry({ uploadId, file, index, chunkSize: CHUNK_SIZE, uploadedBytesByChunk, reportProgress });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, totalChunks) }, worker)
  );

  const { data: job } = await client.post(`/jobs/uploads/${uploadId}/complete`, { totalChunks });
  onProgress?.(100);
  return job;
}

async function uploadChunkWithRetry({ uploadId, file, index, chunkSize, uploadedBytesByChunk, reportProgress }) {
  const start = index * chunkSize;
  const blob = file.slice(start, Math.min(start + chunkSize, file.size));

  let lastError;
  for (let attempt = 1; attempt <= CHUNK_MAX_RETRIES; attempt += 1) {
    const form = new FormData();
    form.append("chunk", blob);
    form.append("index", String(index));

    const controller = new AbortController();
    let stallTimer;
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), CHUNK_STALL_TIMEOUT_MS);
    };
    armStallTimer();

    try {
      await client.post(`/jobs/uploads/${uploadId}/chunks`, form, {
        signal: controller.signal,
        onUploadProgress: (event) => {
          armStallTimer(); // any movement resets the stall clock - only true stalls get aborted
          uploadedBytesByChunk[index] = event.loaded;
          reportProgress();
        },
      });
      clearTimeout(stallTimer);
      return;
    } catch (error) {
      clearTimeout(stallTimer);
      lastError = error;
      uploadedBytesByChunk[index] = 0;
      reportProgress();
      if (attempt === CHUNK_MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function retryNetworkRequest(request, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (error.code !== "ERR_NETWORK" || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  if (lastError?.code === "ERR_NETWORK") {
    lastError.message = "Upload connection was interrupted after three retries. Check your internet connection and try again.";
  }
  throw lastError;
}

export async function getJob(jobId) {
  const { data } = await client.get(`/jobs/${jobId}`);
  return data;
}

export function clipDownloadUrl(jobId, clipId) {
  return `${API_BASE}/jobs/${jobId}/clips/${clipId}/download`;
}

export function clipStreamUrl(jobId, clipId) {
  return `${API_BASE}/jobs/${jobId}/clips/${clipId}/stream`;
}

export async function regenerateClipCaption(jobId, clipId) {
  const { data } = await client.post(`/jobs/${jobId}/clips/${clipId}/regenerate-caption`);
  return data.clip;
}