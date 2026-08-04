import axios from "axios";

// In local dev, VITE_API_URL is unset and requests to "/api" are proxied to
// the local backend by vite.config.js. In production (Vercel), set
// VITE_API_URL to your deployed Render backend URL, e.g.
// https://your-backend.onrender.com — Vercel doesn't proxy API calls for you.
const API_BASE = import.meta.env.VITE_API_URL || "/api";

const client = axios.create({ baseURL: API_BASE });

export async function createJobFromUrl({ url, ownershipConfirmed, ownerCreditName }) {
  const { data } = await client.post("/jobs/from-url", {
    url,
    ownershipConfirmed,
    ownerCreditName,
  });
  return data;
}

export async function createJobFromUpload({ file, ownershipConfirmed, ownerCreditName }) {
  const form = new FormData();
  form.append("video", file);
  form.append("ownershipConfirmed", ownershipConfirmed);
  form.append("ownerCreditName", ownerCreditName);
  const { data } = await client.post("/jobs/from-upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

export async function getJob(jobId) {
  const { data } = await client.get(`/jobs/${jobId}`);
  return data;
}

export function clipDownloadUrl(jobId, clipId) {
  return `${API_BASE}/jobs/${jobId}/clips/${clipId}/download`;
}
