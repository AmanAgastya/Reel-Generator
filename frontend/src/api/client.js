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
// Splitting many parallel connections across a link that doesn't actually
// have much bandwidth to begin with just fragments the little it has -
// each stream then trickles along slowly and is more likely to go quiet
// for longer stretches, which is exactly what was tripping the stall
// timeout below on every single chunk (see the "- - ms - -" pattern with
// zero successful chunks in the Render logs). A more conservative
// concurrency gives each connection a fairer share of a weak link.
const UPLOAD_CONCURRENCY = 4;
const CHUNK_MAX_RETRIES = 6;
// A chunk request that goes this long without a single upload-progress
// event is treated as dead and gets aborted/retried rather than waiting
// forever - this is what catches a genuinely dropped connection (e.g. a
// server restart). But on a weak/bursty connection, a real transfer can
// legitimately go quiet for a while between bursts and then resume - a
// timeout that's too short kills those before they get the chance, which
// is what turned "very slow" into "never succeeds at all". 45s is patient
// enough to ride out normal bursty gaps while still failing a genuinely
// dead connection reasonably quickly.
const CHUNK_STALL_TIMEOUT_MS = 45000;
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
      if (!isRetryableSessionError(error) || attempt === SESSION_MAX_RETRIES) break;
      const status = error?.response?.status;
      console.warn(
        `[upload] session interrupted${status ? ` (HTTP ${status})` : ""} ` +
          `(attempt ${attempt}/${SESSION_MAX_RETRIES}), retrying in ${SESSION_RETRY_DELAY_MS / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function isRetryableSessionError(error) {
  const status = error?.response?.status;
  // No response at all: a dropped connection, our own stall-abort, a
  // network blip. Always worth retrying.
  if (!status) return true;
  // 404 here specifically means /uploads/:id/chunks couldn't find the
  // session's on-disk folder — almost always because the server restarted
  // and either lost or never had a persistent disk for it. Calling
  // /uploads/init again (which uploadFileInChunks does on every retry)
  // creates a fresh session and picks the upload back up rather than
  // treating "the server forgot about this upload" as a reason to give up.
  // 408/429/502/503/504 are the server or Render's proxy being briefly
  // unavailable/overloaded — exactly what happens while a new instance is
  // still booting after a restart. Only a genuine validation problem (bad
  // request, file too large, missing ownership fields) is permanent.
  return status === 404 || status === 408 || status === 429 || status >= 500;
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
      // A 404 means the session's on-disk folder is gone (server
      // restarted) - retrying the exact same request against it will just
      // 404 again every time. Stop immediately so the session-level retry
      // in uploadFileInChunksWithSessionRetry can call /uploads/init and
      // get a real, fresh session instead of burning attempts here first.
      if (error?.response?.status === 404 || attempt === CHUNK_MAX_RETRIES) break;
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