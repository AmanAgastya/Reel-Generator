import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import os from "os";
import { v4 as uuid } from "uuid";

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");

// "ultrafast" trades a little compression efficiency for the fastest
// possible encode — worth it since clips are short (15-60s) and total job
// turnaround matters more here than shaving a few KB off file size.
const CLIP_VIDEO_PRESET = process.env.CLIP_VIDEO_PRESET || "ultrafast";
const CLIP_VIDEO_CRF = Number(process.env.CLIP_VIDEO_CRF || 28);
// Renders run CLIP_RENDER_CONCURRENCY at a time (see jobProcessor.js), so
// giving every single render all of the machine's cores would oversubscribe
// the CPU and slow every render down together. Split the cores evenly
// across the expected concurrency instead of hardcoding 1 thread — a real
// speedup on any multi-core host, while still capping out safely on a
// single-core box.
const DEFAULT_RENDER_CONCURRENCY = Math.max(1, Number(process.env.CLIP_RENDER_CONCURRENCY || Math.min(4, os.cpus().length)));
const CLIP_RENDER_THREADS = Math.max(
  1,
  Number(process.env.CLIP_RENDER_THREADS || Math.floor(os.cpus().length / DEFAULT_RENDER_CONCURRENCY))
);
const CLIP_AUDIO_BITRATE = process.env.CLIP_AUDIO_BITRATE || "64k";

const CANVAS_WIDTH = Number(process.env.CLIP_WIDTH || 720);
const CANVAS_HEIGHT = Number(process.env.CLIP_HEIGHT || 1280);

/**
 * Reads the source video's true visual dimensions (accounting for rotation
 * metadata from phone footage) once per job, so every clip render for that
 * job can reuse it instead of re-probing the file per clip.
 */
export function probeVideoDimensions(sourceFilePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(sourceFilePath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.codec_type === "video");
      if (!stream || !stream.width || !stream.height) {
        return reject(new Error("Could not read video dimensions from the source file."));
      }
      let { width, height } = stream;
      const rotation = Number(
        stream.tags?.rotate ??
          stream.side_data_list?.find((sd) => typeof sd.rotation === "number")?.rotation ??
          0
      );
      if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
        [width, height] = [height, width];
      }
      resolve({ width, height });
    });
  });
}

function evenFloor(n) {
  const rounded = Math.round(n);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/**
 * Cuts a single clip from the source video and composites it into a clean
 * vertical 9:16 frame:
 *  - the full, uncropped source frame is scaled to fit entirely inside the
 *    canvas (nothing is cut off, unlike a hard center-crop)
 *  - a blurred, slightly darkened copy of the same footage fills the
 *    surrounding space instead of plain black bars
 * Nothing else is drawn into the video itself — no title, caption, credit
 * line, border, or scrim gets burned into the frame. The caption/hashtags/
 * credit for a clip are caption metadata only (see Clip model), meant to be
 * copied into the post text when publishing, not composited onto the video.
 * Returns the output file path.
 */
export function renderClip(sourceFilePath, { start, end }, sourceDimensions) {
  return new Promise(async (resolve, reject) => {
    try {
      const outDir = path.join(STORAGE_DIR, "clips");
      fs.mkdirSync(outDir, { recursive: true });
      const outputPath = path.join(outDir, `${uuid()}.mp4`);

      const duration = Math.max(1, end - start);

      const dims = sourceDimensions || (await probeVideoDimensions(sourceFilePath));
      const { fgWidth, fgHeight, fgX, fgY } = fitContentBox(dims.width, dims.height);

      const filterComplex = buildFilterComplex({ fgWidth, fgHeight, fgX, fgY });

      if (process.env.CLIPPER_DEBUG) console.error("FILTER:", filterComplex);
      ffmpeg(sourceFilePath)
        .inputOptions([
          // Input-side seeking: ffmpeg jumps to the nearest keyframe and
          // decodes forward from there, instead of decoding the whole file
          // from t=0 for every single clip. For a job that cuts many clips
          // out of a long source video this is the single biggest speed win
          // in the whole pipeline (was: output-side seeking via
          // setStartTime(), which re-decoded from the start every time).
          `-ss ${start}`,
        ])
        .outputOptions([
          `-t ${duration}`,
          "-filter_complex",
          filterComplex,
          "-map",
          "[out]",
          "-map",
          "0:a?", // optional: don't fail on silent/video-only sources
          "-c:v",
          "libx264",
          "-preset",
          CLIP_VIDEO_PRESET,
          "-crf",
          String(CLIP_VIDEO_CRF),
          "-c:a",
          "aac",
          "-b:a",
          CLIP_AUDIO_BITRATE,
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          `-threads ${CLIP_RENDER_THREADS}`,
        ])
        .save(outputPath)
        .on("end", () => resolve(outputPath))
        .on("error", (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Computes the largest box that fits the source's full aspect ratio inside
 * the canvas without cropping anything ("contain" scaling), centered, with
 * even pixel dimensions (required by libx264's 4:2:0 chroma subsampling).
 */
function fitContentBox(srcWidth, srcHeight) {
  const scale = Math.min(CANVAS_WIDTH / srcWidth, CANVAS_HEIGHT / srcHeight);
  const fgWidth = Math.max(2, evenFloor(srcWidth * scale));
  const fgHeight = Math.max(2, evenFloor(srcHeight * scale));
  const fgX = evenFloor((CANVAS_WIDTH - fgWidth) / 2);
  const fgY = evenFloor((CANVAS_HEIGHT - fgHeight) / 2);
  return { fgWidth, fgHeight, fgX, fgY };
}

function buildFilterComplex({ fgWidth, fgHeight, fgX, fgY }) {
  const W = CANVAS_WIDTH;
  const H = CANVAS_HEIGHT;

  // Backdrop blur cost in ffmpeg scales with pixel count, and gblur at a
  // large sigma is by far the most expensive step in this whole filter
  // graph - it was blurring the full canvas (W x H, unchanged) at
  // sigma=30 on every single frame of every clip. Blurring a heavily
  // downscaled copy of the same cropped frame and scaling the *blurred*
  // result back up to the same final W x H gives a visually equivalent
  // (in fact smoother) backdrop for a fraction of the cost - gblur now
  // runs on a ~quarter-size image instead of the full canvas, cutting the
  // backdrop blur's per-frame work by roughly 20x. Nothing about the
  // output changes: final canvas size, crop, foreground scaling, CRF,
  // preset, and audio settings are all untouched - only how the blurred
  // backdrop pixels get computed.
  const bgBlurWidth = Math.max(2, evenFloor(W / 4));
  const bgBlurHeight = Math.max(2, evenFloor(H / 4));

  return [
    // Split the source once: one copy becomes the blurred backdrop, the
    // other is the full, undistorted foreground.
    `[0:v]split=2[bgsrc][fgsrc]`,

    // Backdrop: cover-crop to fill the canvas, downscale before blurring
    // (see comment above), blur, then scale back up to the same canvas
    // size and darken/boost saturation slightly so it reads as an
    // intentional background rather than a mistake, and never lets plain
    // black bars show.
    `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=${bgBlurWidth}:${bgBlurHeight},gblur=sigma=8,scale=${W}:${H},eq=brightness=-0.08:saturation=1.3[bg]`,

    // Foreground: scaled to fit entirely inside the canvas - the full
    // frame is always visible, nothing is cropped off the sides or top.
    `[fgsrc]scale=${fgWidth}:${fgHeight}[fg]`,

    // Composite foreground centered over the blurred backdrop. Nothing else
    // (no border, scrim, or text) is drawn on top — the frame only ever
    // contains the source footage itself.
    `[bg][fg]overlay=${fgX}:${fgY}[out]`,
  ].join(";");
}