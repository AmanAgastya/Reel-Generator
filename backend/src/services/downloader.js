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

  await youtubedl(url, {
    output: outputTemplate,
    format: "mp4[height<=1080]/best",
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
  });

  const files = fs.readdirSync(outDir).filter((f) => f.startsWith(fileId));
  if (!files.length) throw new Error("Download completed but output file not found");

  return path.join(outDir, files[0]);
}
