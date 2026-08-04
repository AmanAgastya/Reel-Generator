import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getJob } from "../api/client.js";
import ClipCard from "../components/ClipCard.jsx";

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

  useEffect(() => {
    let active = true;
    let interval;
    let failureCount = 0;

    async function poll() {
      try {
        const data = await getJob(jobId);
        if (!active) return;
        setJob(data.job);
        setClips(data.clips);
        setError("");
        failureCount = 0;
        if (["completed", "failed"].includes(data.job.status)) {
          clearInterval(interval);
        }
      } catch (err) {
        console.error("[JobStatus] poll failed:", err);
        if (!active) return;
        failureCount += 1;
        setError(err.response?.data?.error || err.message || "Failed to load job status.");
        if (failureCount >= 5) {
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
  const totalClips = clips.length;

  return (
    <div className="page">
      <Link to="/" className="back">
        &larr; New video
      </Link>

      <header className="hero small">
        <span className="eyebrow">Job {job._id.slice(-6)}</span>
        <h1>
          {job.status === "completed"
            ? `${clips.length} clips ready`
            : job.status === "failed"
            ? "Something went wrong"
            : "Finding the best moments…"}
        </h1>
      </header>

      {error && <p className="error">{error}</p>}

      {job.status === "failed" ? (
        <p className="error">{job.error}</p>
      ) : (
        <>
          {job.status !== "completed" && (
            <div className="progress-track">
              {STAGES.slice(0, -1).map((stage, i) => (
                <div key={stage} className={`stage ${i <= stageIndex ? "done" : ""}`}>
                  {stage}
                </div>
              ))}
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${job.progress}%` }} />
              </div>
            </div>
          )}

          {job.startedAt && job.status !== "queued" && (
            <p className="sub">Started {formatElapsedTime(job.startedAt)} ago.</p>
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
