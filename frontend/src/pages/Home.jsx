import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJobFromUrl, createJobFromUpload } from "../api/client.js";

const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024; // 1GB

export default function Home() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("url"); // 'url' | 'upload'
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [ownerCreditName, setOwnerCreditName] = useState("");
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [error, setError] = useState("");

  const canSubmit =
    ownershipConfirmed &&
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
      const job =
        mode === "url"
          ? await createJobFromUrl({ url, ownershipConfirmed, ownerCreditName })
          : await createJobFromUpload({
              file,
              ownershipConfirmed,
              ownerCreditName,
              onProgress: setUploadProgress,
            });
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
          <label className="field">
            <span>Video file</span>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => {
                const selectedFile = e.target.files[0];
                if (selectedFile && selectedFile.size > MAX_UPLOAD_BYTES) {
                  setError("File is too large. Pick a video smaller than 1GB.");
                  setFile(null);
                } else {
                  setError("");
                  setFile(selectedFile);
                }
              }}
            />
          </label>
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

        <label className="field checkbox">
          <input
            type="checkbox"
            checked={ownershipConfirmed}
            onChange={(e) => setOwnershipConfirmed(e.target.checked)}
          />
          <span>
            I own this video, or I have explicit rights/permission to cut and
            repost it. Clips can't be generated without this.
          </span>
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
