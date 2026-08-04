import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { getJob } from "../api/client.js";
import ClipCard from "../components/ClipCard.jsx";

const STAGES = ["queued", "downloading", "transcribing", "analyzing", "clipping", "completed"];

export default function JobStatus() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [clips, setClips] = useState([]);

  useEffect(() => {
    let active = true;
    let interval;

    async function poll() {
      const data = await getJob(jobId);
      if (!active) return;
      setJob(data.job);
      setClips(data.clips);
      if (["completed", "failed"].includes(data.job.status)) {
        clearInterval(interval);
      }
    }

    poll();
    interval = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [jobId]);

  if (!job) return <div className="page">Loading…</div>;

  const stageIndex = STAGES.indexOf(job.status);

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

      {job.status === "failed" ? (
        <p className="error">{job.error}</p>
      ) : job.status !== "completed" ? (
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
      ) : null}

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
