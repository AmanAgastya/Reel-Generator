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
  const { data: session } = await retryNetworkRequest(() =>
    client.post("/jobs/uploads/init", { ownershipConfirmed, ownerCreditName, originalFileName: file.name })
  );
  const chunkSize = 20 * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);
  for (let index = 0; index < totalChunks; index += 1) {
    const form = new FormData();
    form.append("chunk", file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, file.size)), "chunk.part");
    form.append("index", String(index));
    await retryNetworkRequest(() => client.post(`/jobs/uploads/${session.uploadId}/chunks`, form));
    onProgress?.(Math.round(((index + 1) / totalChunks) * 100));
  }
  const { data } = await retryNetworkRequest(() =>
    client.post(`/jobs/uploads/${session.uploadId}/complete`, { totalChunks })
  );
  return data;
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
