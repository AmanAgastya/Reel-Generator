import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getJob, triggerClipDownload } from "../api/client.js";
import ClipCard from "../components/ClipCard.jsx";

// Space auto-triggered downloads apart instead of firing a burst all at
// once - most browsers throttle or prompt for permission ("This site is
// trying to download multiple files") when several downloads start in the
// same tick, which would either block them silently or interrupt the user
// for every job. A small stagger avoids that without meaningfully slowing
// things down.
const AUTO_DOWNLOAD_STAGGER_MS = 700;

const STAGES = ["queued", "downloading", "transcribing", "analyzing", "clipping", "completed"];

function formatElapsedTime(startedAt) {
  const started = new Date(startedAt);
  const seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export default function JobStatus() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [clips, setClips] = useState([]);
  const [error, setError] = useState("");
  // Persisted so a toggle flip doesn't restart the polling effect, and so
  // the choice survives across jobs on this device.
  const [autoDownload, setAutoDownload] = useState(
    () => localStorage.getItem("autoDownloadClips") !== "off"
  );
  const autoDownloadRef = useRef(autoDownload);
  useEffect(() => {
    autoDownloadRef.current = autoDownload;
    localStorage.setItem("autoDownloadClips", autoDownload ? "on" : "off");
  }, [autoDownload]);

  // Tracks which clips have already been auto-downloaded in this session so
  // a clip never re-downloads itself on a later poll (the job status is
  // polled every 3s for as long as the page stays open).
  const downloadedClipIdsRef = useRef(new Set());
  const downloadQueueLengthRef = useRef(0);

  useEffect(() => {
    let active = true;
    let interval;
    let failureCount = 0;

    // A Render free-tier backend that's spinning back up after a restart
    // (OOM, redeploy, cold start) takes 30-90s to answer again - see
    // client.js's SESSION_RETRY_DELAY_MS comment for the same situation on
    // the upload path. The old 5-failures-at-3s-each cutoff (15s) gave up
    // and showed "Cannot reach the API" well before the server came back,
    // even though the job itself was still running fine server-side.
    // 40 failures at 3s comfortably covers that window without leaving a
    // truly dead backend polling forever.
    const MAX_POLL_FAILURES = 40;
    // Don't flash the scary error banner on the first transient blip - only
    // surface it once a few in a row confirm this isn't just one dropped
    // request.
    const ERROR_DISPLAY_THRESHOLD = 3;

    async function poll() {
      try {
        const data = await getJob(jobId);
        if (!active) return;
        setJob(data.job);
        setClips(data.clips);
        setError("");
        failureCount = 0;

        if (autoDownloadRef.current) {
          const newlyRendered = data.clips.filter(
            (clip) => clip.status === "rendered" && !downloadedClipIdsRef.current.has(clip._id)
          );
          newlyRendered.forEach((clip) => {
            downloadedClipIdsRef.current.add(clip._id);
            const position = downloadQueueLengthRef.current++;
            setTimeout(() => {
              if (active) triggerClipDownload(data.job._id, clip._id);
            }, position * AUTO_DOWNLOAD_STAGGER_MS);
          });
        }

        if (["completed", "failed"].includes(data.job.status)) {
          clearInterval(interval);
        }
      } catch (err) {
        console.error("[JobStatus] poll failed:", err);
        if (!active) return;
        failureCount += 1;

        // A 404 means this job genuinely doesn't exist - no amount of
        // retrying fixes that, so stop immediately instead of burning the
        // full retry window on it.
        if (err.response?.status === 404) {
          setError(err.response?.data?.error || "Job not found.");
          clearInterval(interval);
          return;
        }

        if (failureCount >= ERROR_DISPLAY_THRESHOLD) {
          setError(err.response?.data?.error || err.message || "Failed to load job status.");
        }
        if (failureCount >= MAX_POLL_FAILURES) {
          clearInterval(interval);
        }
      }
    }

    poll();
    interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [jobId]);

  if (!job)
    return (
      <div className="page">
        {error ? <p className="error">{error}</p> : "Loading…"}
      </div>
    );

  const stageIndex = STAGES.indexOf(job.status);
  const renderedCount = clips.filter((clip) => clip.status === "rendered").length;
  const totalClips = job.clipRenderCount || clips.length;

  return (
    <div className="page">
      <Link to="/" className="back">
        &larr; New video
      </Link>

      <header className={`hero small ${job.status === "completed" ? "just-wrapped" : ""}`}>
        <span className="eyebrow">Job {job._id.slice(-6)}</span>
        <h1>
          {job.status === "completed"
            ? `${clips.length} clips ready`
            : job.status === "failed"
            ? "Something went wrong"
            : "Finding the best moments…"}
        </h1>
      </header>

      <label className="auto-download-toggle">
        <input
          type="checkbox"
          checked={autoDownload}
          onChange={(e) => setAutoDownload(e.target.checked)}
        />
        Auto-download each clip as it finishes (saved as its caption, e.g. "clip-caption.mp4")
      </label>
      {autoDownload && (
        <p className="sub auto-download-hint">
          Your browser may ask you to allow multiple downloads from this site the first time — allow it so every
          clip saves automatically.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      {job.status === "failed" ? (
        <p className="error">{job.error}</p>
      ) : (
        <>
          {job.status !== "completed" && (
            <div className="filmstrip">
              <div className="filmstrip-holes" aria-hidden="true" />
              <div className="filmstrip-frames">
                {STAGES.slice(0, -1).map((stage, i) => (
                  <div
                    key={stage}
                    className={`frame ${i < stageIndex ? "done" : ""} ${i === stageIndex ? "active" : ""}`}
                  >
                    <span className="frame-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="frame-label">{stage}</span>
                  </div>
                ))}
              </div>
              <div className="filmstrip-holes" aria-hidden="true" />
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          )}

          {job.startedAt && job.status !== "queued" && (
            <p className="sub timing">Started {formatElapsedTime(job.startedAt)} ago.</p>
          )}

          {job.status === "clipping" && (
            <>
              {totalClips > 0 ? (
                <p className="sub">Rendering clips in the background — {renderedCount}/{totalClips} ready so far.</p>
              ) : job.clipRenderCount ? (
                <p className="sub">Preparing to render {job.clipRenderCount} clips — this may take a few minutes.</p>
              ) : (
                <p className="sub">Preparing clips for rendering — this may take a few minutes.</p>
              )}
            </>
          )}
        </>
      )}

      {clips.length > 0 && (
        <div className="clip-grid">
          {clips.map((clip, i) => (
            <ClipCard key={clip._id} jobId={job._id} clip={clip} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
