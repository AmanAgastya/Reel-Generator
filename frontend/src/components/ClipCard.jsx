import React from "react";
import { clipDownloadUrl } from "../api/client.js";

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ClipCard({ jobId, clip, index }) {
  return (
    <article className="clip-card generated-clip">
      <div className="clip-index">{String(index + 1).padStart(2, "0")}</div>
      <div className="clip-body">
        <div className="clip-badge-row">
          <span className="generated-badge">Generated</span>
          <div className="clip-time">
            {formatTime(clip.startSeconds)} &ndash; {formatTime(clip.endSeconds)}
          </div>
        </div>
        <p className="clip-caption">{clip.caption}</p>
        <p className="clip-credit">{clip.creditLine}</p>
        <div className="clip-hashtags">
          {(clip.hashtags || []).map((tag) => (
            <span key={tag} className="hashtag">
              #{tag}
            </span>
          ))}
        </div>
        <div className="clip-status">{clip.status}</div>
        {clip.status === "rendered" && (
          <a className="download" href={clipDownloadUrl(jobId, clip._id)}>
            Download clip
          </a>
        )}
      </div>
    </article>
  );
}
