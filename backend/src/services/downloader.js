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

  try {
    await youtubedl(url, {
      output: outputTemplate,
      format: "mp4[height<=1080]/best[height<=1080]/best",
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      noPlaylist: true,
      // Fetch multiple fragments of the video in parallel instead of one
      // stream at a time — the single biggest download-speed lever yt-dlp
      // exposes, especially on DASH/HLS-served formats.
      concurrentFragments: Math.max(1, Number(process.env.YTDLP_CONCURRENT_FRAGMENTS || 8)),
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