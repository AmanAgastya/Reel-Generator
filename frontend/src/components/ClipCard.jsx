import React, { useEffect, useState } from "react";
import { clipDownloadUrl, clipStreamUrl, regenerateClipCaption } from "../api/client.js";

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ClipCard({ jobId, clip, index }) {
  const isRendered = clip.status === "rendered";
  const [caption, setCaption] = useState(clip.caption);
  const [hashtags, setHashtags] = useState(clip.hashtags || []);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCaption(clip.caption);
    setHashtags(clip.hashtags || []);
  }, [clip.caption, clip.hashtags]);

  async function handleRegenerateCaption() {
    setIsRegenerating(true);
    setError("");
    try {
      const updated = await regenerateClipCaption(jobId, clip._id);
      setCaption(updated.caption || caption);
      setHashtags(Array.isArray(updated.hashtags) ? updated.hashtags : hashtags);
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Failed to regenerate caption.");
    } finally {
      setIsRegenerating(false);
    }
  }

  async function handleCopyCaption() {
    const postText = [caption, hashtags.map((tag) => `#${tag}`).join(" ")]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to clipboard — select and copy the caption manually.");
    }
  }

  return (
    <article className="clip-card generated-clip">
      <div className="clip-index">Frame {String(index + 1).padStart(2, "0")}</div>
      <div className="clip-body">
        {isRendered ? (
          <div className="phone-frame">
            <div className="phone-notch" aria-hidden="true" />
            <div className="clip-player">
              {/* preload="none" — with up to 30 clips per job, eagerly loading
                  every video at once would be slow and bandwidth-heavy.
                  Each player only fetches once the user hits play. */}
              <video
                className="clip-video"
                controls
                preload="none"
                playsInline
                src={clipStreamUrl(jobId, clip._id)}
              >
                Your browser doesn't support inline video playback.
              </video>
            </div>
          </div>
        ) : (
          <div className={`clip-player clip-player-placeholder ${clip.status}`}>
            {clip.status === "failed" ? (
              <span>Render failed</span>
            ) : (
              <>
                <span className="spinner" aria-hidden="true" />
                <span>Rendering&hellip;</span>
              </>
            )}
          </div>
        )}

        <div className="clip-badge-row">
          <div className="clip-badges">
            <span className="generated-badge">Generated</span>
            <span className={`status-badge ${clip.status}`}>{isRendered ? "Ready" : clip.status}</span>
          </div>
          <div className="clip-time">
            {formatTime(clip.startSeconds)} &ndash; {formatTime(clip.endSeconds)}
          </div>
        </div>
        <p className="clip-credit">{clip.creditLine}</p>

        {/* Nothing is burned into the video frame — this is the caption to
            paste into the post text when you publish the clip. */}
        <div className="clip-caption-block">
          <p className="clip-caption-label">Caption for posting</p>
          <p className="clip-caption-text">{caption || "No caption generated for this clip yet."}</p>
        </div>

        <div className="clip-hashtags">
          {hashtags.map((tag) => (
            <span key={tag} className="hashtag">
              #{tag}
            </span>
          ))}
        </div>
        {isRendered && (
          <div className="clip-actions">
            <a className="download" href={clipDownloadUrl(jobId, clip._id)} download>
              &darr; Download clip
            </a>
            <button type="button" className="copy-caption" onClick={handleCopyCaption} disabled={!caption}>
              {copied ? "Copied!" : "Copy caption"}
            </button>
            <button
              type="button"
              className="regenerate"
              onClick={handleRegenerateCaption}
              disabled={isRegenerating}
            >
              {isRegenerating ? "Regenerating…" : "Regenerate caption"}
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  );
}