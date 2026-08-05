import youtubedl from "youtube-dl-exec";
import path from "path";
import fs from "fs";
import { v4 as uuid } from "uuid";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";

/**
 * Downloads a YouTube video to local disk.
 * NOTE: only use this for videos the user owns or has explicit rights to
 * process — the job.ownershipConfirmed flag is enforced upstream in the
 * route/worker before this ever runs.
 */
export async function downloadYouTubeVideo(url) {
  const outDir = path.join(STORAGE_DIR, "downloads");
  fs.mkdirSync(outDir, { recursive: true });

  const fileId = uuid();
  const outputTemplate = path.join(outDir, `${fileId}.%(ext)s`);
  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();

  if (cookiesFile && !fs.existsSync(cookiesFile)) {
    throw new Error(
      "YTDLP_COOKIES_FILE is configured, but the cookies file is not available on the server."
    );
  }

  // The render pipeline scales everything down to fit inside the output
  // canvas (see clipper.js CANVAS_WIDTH/CANVAS_HEIGHT), so pulling a
  // 1080p/4K master when the canvas only needs e.g. 720px is wasted
  // bandwidth and wasted decode time for every single clip cut from it.
  // Derive the download cap from the same CLIP_WIDTH/CLIP_HEIGHT env vars
  // the renderer uses (falling back to the same 720x1280 default), so the
  // two stay in sync automatically instead of needing a second number
  // tuned by hand. This is the single biggest lever on total job time for
  // anything sourced from a high-res YouTube upload. Override with
  // YTDLP_MAX_HEIGHT directly if a sharper source is ever needed.
  // Source footage is almost always landscape, so its *height* is the
  // dimension that ends up constrained by the canvas's width once the full
  // frame is scaled to fit inside the portrait box (see fitContentBox in
  // clipper.js) — e.g. a 720-wide canvas never benefits from more than
  // ~720p source height.
  const canvasWidth = Number(process.env.CLIP_WIDTH || 720);
  const maxHeight = Math.max(360, Number(process.env.YTDLP_MAX_HEIGHT || canvasWidth));

  try {
    await youtubedl(url, {
      output: outputTemplate,
      format: `mp4[height<=${maxHeight}]/best[height<=${maxHeight}]/best`,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      noPlaylist: true,
      // Fetch multiple fragments of the video in parallel instead of one
      // stream at a time — the single biggest download-speed lever yt-dlp
      // exposes, especially on DASH/HLS-served formats.
      concurrentFragments: Math.max(1, Number(process.env.YTDLP_CONCURRENT_FRAGMENTS || 16)),
      retries: 5,
      fragmentRetries: 5,
      ...(cookiesFile ? { cookies: cookiesFile } : {}),
    });
  } catch (err) {
    const errorOutput = [err.message, err.stderr, err.stdout].filter(Boolean).join("\n");
    if (/sign in to confirm you're not a bot|use --cookies/i.test(errorOutput)) {
      throw new Error(
        "YouTube blocked this server download as automated traffic. Add a valid Netscape-format cookies file on the server and set YTDLP_COOKIES_FILE to its path, or use the Upload a file option for this video."
      );
    }
    throw err;
  }

  const files = fs.readdirSync(outDir).filter((f) => f.startsWith(fileId));
  if (!files.length) throw new Error("Download completed but output file not found");

  return path.join(outDir, files[0]);
}