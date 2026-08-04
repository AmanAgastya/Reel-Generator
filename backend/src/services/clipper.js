import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import { v4 as uuid } from "uuid";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
const CLIP_VIDEO_PRESET = process.env.CLIP_VIDEO_PRESET || "superfast";
const CLIP_VIDEO_CRf = Number(process.env.CLIP_VIDEO_CRF || 23);
const CLIP_AUDIO_BITRATE = process.env.CLIP_AUDIO_BITRATE || "128k";

/**
 * Cuts a single clip from the source video and burns in the caption +
 * credit line as an overlay. Returns the output file path.
 */
export function renderClip(sourceFilePath, { start, end, caption, creditLine }) {
  return new Promise((resolve, reject) => {
    const outDir = path.join(STORAGE_DIR, "clips");
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `${uuid()}.mp4`);

    const duration = Math.max(1, end - start);
    const safeCaption = escapeDrawtext(caption);
    const safeCredit = escapeDrawtext(creditLine);

    // Vertical 9:16 crop for Shorts, caption burned near the bottom third,
    // credit line burned near the top.
    const filter = [
      "crop=ih*9/16:ih",
      "scale=1080:1920",
      `drawtext=text='${safeCaption}':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.5:boxborderw=20:x=(w-text_w)/2:y=h-400:line_spacing=10`,
      `drawtext=text='${safeCredit}':fontcolor=white:fontsize=30:box=1:boxcolor=black@0.4:boxborderw=12:x=(w-text_w)/2:y=80`,
    ].join(",");

    ffmpeg(sourceFilePath)
      .setStartTime(start)
      .setDuration(duration)
      .videoFilters(filter)
      .outputOptions([
        "-c:v libx264",
        `-preset ${CLIP_VIDEO_PRESET}`,
        `-crf ${CLIP_VIDEO_CRf}`,
        "-c:a aac",
        `-b:a ${CLIP_AUDIO_BITRATE}`,
        "-movflags +faststart",
        "-threads 0",
      ])
      .save(outputPath)
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err));
  });
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}
