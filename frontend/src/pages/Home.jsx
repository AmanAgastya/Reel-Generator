import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJobFromUrl, createJobFromUpload } from "../api/client.js";

// Videos are always uploaded exactly as selected — no client-side
// re-encoding/compression step. Large files are sent in parallel chunks
// (see api/client.js) instead of being shrunk, so quality is never
// touched and long/high-resolution videos still upload quickly.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

export default function Home() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("url"); // 'url' | 'upload'
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [ownerCreditName, setOwnerCreditName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [error, setError] = useState("");

  const canSubmit =
    ownerCreditName.trim().length > 0 &&
    ((mode === "url" && url.trim().length > 0) || (mode === "upload" && file));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setUploadProgress(mode === "upload" ? 0 : null);
    setError("");
    // Let React paint the 0% state before starting a potentially large
    // multipart request; otherwise some browsers show no update initially.
    if (mode === "upload") {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    try {
      let job;
      if (mode === "url") {
        job = await createJobFromUrl({ url, ownershipConfirmed: true, ownerCreditName });
      } else {
        job = await createJobFromUpload({
          file,
          ownershipConfirmed: true,
          ownerCreditName,
          onProgress: setUploadProgress,
        });
      }
      navigate(`/jobs/${job._id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <span className="eyebrow">Reel Cut</span>
        <h1>Turn one long video into your best 10&ndash;20 Shorts</h1>
        <p className="sub">
          Drop in a video you own the rights to. The editor finds the strongest
          moments, writes captions, credits you, and hands back vertical clips
          ready to post.
        </p>
        <div className="hero-stickers" aria-hidden="true">
          <span className="sticker" style={{ "--r": "-3deg", "--d": "0s" }}>AI cut</span>
          <span className="sticker" style={{ "--r": "2deg", "--d": "0.3s" }}>9:16 ready</span>
          <span className="sticker" style={{ "--r": "-2deg", "--d": "0.6s" }}>Auto captions</span>
        </div>
      </header>

      <form className="panel" onSubmit={handleSubmit}>
        <div className="tabs">
          <button
            type="button"
            className={mode === "url" ? "tab active" : "tab"}
            onClick={() => setMode("url")}
          >
            My YouTube link
          </button>
          <button
            type="button"
            className={mode === "upload" ? "tab active" : "tab"}
            onClick={() => setMode("upload")}
          >
            Upload a file
          </button>
        </div>

        {mode === "url" ? (
          <label className="field">
            <span>Video URL</span>
            <input
              type="url"
              placeholder="https://youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span>Video file</span>
              <input
                type="file"
                accept="video/*"
                onChange={(e) => {
                  const selectedFile = e.target.files[0];
                  if (selectedFile && selectedFile.size > MAX_UPLOAD_BYTES) {
                    setError("File is too large. Pick a video smaller than 5GB.");
                    setFile(null);
                  } else {
                    setError("");
                    setFile(selectedFile);
                  }
                }}
              />
            </label>
            <p className="field-hint">
              Uploaded exactly as-is — no compression or quality loss. Large
              files upload in parallel chunks to keep things fast.
            </p>
          </>
        )}

        <label className="field">
          <span>Credit name (your channel / name, shown on every clip)</span>
          <input
            type="text"
            placeholder="e.g. Aman's Channel"
            value={ownerCreditName}
            onChange={(e) => setOwnerCreditName(e.target.value)}
          />
        </label>

        {error && <p className="error">{error}</p>}

        {submitting && mode === "upload" && uploadProgress !== null && (
          <div className="upload-progress" aria-live="polite">
            <div className="upload-progress-label">
              <span>{uploadProgress < 100 ? "Uploading video" : "Starting analysis"}</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p>Large videos can take a few minutes to transfer before analysis begins.</p>
          </div>
        )}

        <button className="submit" type="submit" disabled={!canSubmit || submitting}>
          {submitting ? "Starting…" : "Find the best moments"}
        </button>
      </form>
    </div>
  );
}