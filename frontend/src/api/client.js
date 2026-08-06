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
  return uploadFileInChunks({ file, ownershipConfirmed, ownerCreditName, onProgress });
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
  const { uploadId, chunkSize } = initData;
  // Trust the server's chunk size over any client-side assumption — this is
  // what keeps chunk slicing permanently in sync with the backend's limit.
  const CHUNK_SIZE = Number(chunkSize) > 0 ? Number(chunkSize) : CHUNK_SIZE_HINT;

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadedBytesByChunk = new Array(totalChunks).fill(0);
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

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < totalChunks) {
      const index = nextIndex++;
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
    try {
      await client.post(`/jobs/uploads/${uploadId}/chunks`, form, {
        onUploadProgress: (event) => {
          uploadedBytesByChunk[index] = event.loaded;
          reportProgress();
        },
      });
      return;
    } catch (error) {
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