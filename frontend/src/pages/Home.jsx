import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createJobFromUrl, createJobFromUpload } from "../api/client.js";
import { compressVideoForUpload } from "../utils/compressVideo.js";

const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024; // 1GB
// Below this, compression's fixed overhead (loading the ~25MB ffmpeg.wasm
// core, encode time) usually isn't worth it - the file is already small
// enough to upload quickly as-is.
const COMPRESSION_SUGGESTED_THRESHOLD_BYTES = 150 * 1024 * 1024; // 150MB

export default function Home() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("url"); // 'url' | 'upload'
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [compressBeforeUpload, setCompressBeforeUpload] = useState(true);
  const [ownerCreditName, setOwnerCreditName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState(null); // 'compressing' | 'uploading' | null
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
        let uploadFile = file;
        if (compressBeforeUpload) {
          setPhase("compressing");
          try {
            uploadFile = await compressVideoForUpload(file, setUploadProgress);
          } catch (compressionError) {
            // Compression is a nice-to-have, not a requirement - if the
            // browser can't run it (unsupported browser, out of memory on
            // a huge file, etc.), fall back to uploading the original
            // file rather than blocking the whole submission on it.
            console.warn("Client-side compression failed, uploading original file:", compressionError);
            uploadFile = file;
          }
          setUploadProgress(0);
        }
        setPhase("uploading");
        job = await createJobFromUpload({
          file: uploadFile,
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
      setPhase(null);
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
                    setError("File is too large. Pick a video smaller than 1GB.");
                    setFile(null);
                  } else {
                    setError("");
                    setFile(selectedFile);
                    setCompressBeforeUpload(
                      !selectedFile || selectedFile.size >= COMPRESSION_SUGGESTED_THRESHOLD_BYTES
                    );
                  }
                }}
              />
            </label>
            {file && (
              <label className="field checkbox">
                <input
                  type="checkbox"
                  checked={compressBeforeUpload}
                  onChange={(e) => setCompressBeforeUpload(e.target.checked)}
                />
                <span>
                  Compress before uploading (recommended on slow connections —
                  shrinks the file in your browser first, which can cut upload
                  time dramatically for large videos with little to no visible
                  quality loss in the final clips)
                </span>
              </label>
            )}
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
              <span>
                {phase === "compressing"
                  ? "Compressing video"
                  : uploadProgress < 100
                    ? "Uploading video"
                    : "Starting analysis"}
              </span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${uploadProgress}%` }} />
            </div>
            <p>
              {phase === "compressing"
                ? "Shrinking the video in your browser before sending it — this replaces a slower upload of the full-size file."
                : "Large videos can take a few minutes to transfer before analysis begins."}
            </p>
          </div>
        )}

        <button className="submit" type="submit" disabled={!canSubmit || submitting}>
          {submitting ? "Starting…" : "Find the best moments"}
        </button>
      </form>
    </div>
  );
}