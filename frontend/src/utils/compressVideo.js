import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

// Loaded lazily and cached - most sessions never touch this (only the
// "compress before upload" path needs it), so there's no reason to pull
// ffmpeg.wasm's ~25MB core into the page until someone actually uses it.
// The unpkg CDN serves this with long-lived cache headers, so on a slow
// connection this is a one-time cost, not a per-upload one.
const FFMPEG_CORE_VERSION = "0.12.6";
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;

let ffmpegPromise = null;
function loadFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })().catch((error) => {
      // Don't cache a failed load - a transient network blip on the core
      // download shouldn't permanently break compression for the session.
      ffmpegPromise = null;
      throw error;
    });
  }
  return ffmpegPromise;
}

// The backend renders every clip into a 720x1280 canvas by default (see
// CLIP_WIDTH/CLIP_HEIGHT), scaling the full source frame to fit inside it -
// nothing sharper than that ever reaches the final output. Capping the
// source's longer side at MAX_DIMENSION before upload keeps clips visually
// identical while typically cutting file size 5-10x for common 1080p/4K
// phone footage - by far the biggest lever for a slow upload connection,
// since it directly shrinks the number of bytes that have to cross the
// link at all (parallel connections can't do that - they just use
// whatever bandwidth is available more fully).
const MAX_DIMENSION = 1280;

/**
 * Re-encodes a video file in the browser to a smaller, upload-friendly
 * version, matched to what the renderer actually uses. Returns a new File
 * (video/mp4). onProgress receives 0-100. Throws on failure - callers
 * should fall back to uploading the original file.
 */
export async function compressVideoForUpload(file, onProgress) {
  const ffmpeg = await loadFFmpeg();

  const handleProgress = ({ progress }) => {
    if (Number.isFinite(progress)) {
      onProgress?.(Math.max(0, Math.min(99, Math.round(progress * 100))));
    }
  };
  ffmpeg.on("progress", handleProgress);

  const inputName = `input${(file.name.match(/\.[^./]+$/) || [".mp4"])[0]}`;
  const outputName = "output.mp4";

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    await ffmpeg.exec([
      "-i", inputName,
      // Only ever scales down (never upscales a smaller source); -2 keeps
      // the other dimension even, which libx264 requires.
      "-vf",
      `scale='if(gt(iw,ih),min(${MAX_DIMENSION},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_DIMENSION},ih))'`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "26",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    onProgress?.(100);
    const baseName = file.name.replace(/\.[^./]+$/, "") || "video";
    return new File([data.buffer], `${baseName}-compressed.mp4`, { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", handleProgress);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}