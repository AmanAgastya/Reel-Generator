import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import os from "os";
import { v4 as uuid } from "uuid";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";

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

const ACCENT_COLOR = process.env.CLIP_ACCENT_COLOR || "#FF3B5C";

// --- Font resolution -------------------------------------------------
// Using `fontfile=` (an absolute path) instead of `font=` (a fontconfig
// family lookup) means rendering doesn't depend on fontconfig being
// configured correctly inside a minimal container - it either finds one of
// these files or throws a clear, actionable error instead of a cryptic
// "Cannot find a valid font" failure deep in an ffmpeg stderr stream.
const FONT_CANDIDATES = [
  process.env.FONT_PATH,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "C:\\Windows\\Fonts\\arialbd.ttf",
].filter(Boolean);

let cachedFontFile;
function resolveFontFile() {
  if (cachedFontFile !== undefined) return cachedFontFile;
  cachedFontFile = FONT_CANDIDATES.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!cachedFontFile) {
    console.warn(
      "[clipper] No bundled font found (checked: " +
        FONT_CANDIDATES.join(", ") +
        "). Captions will fail to render unless FONT_PATH is set or a font is " +
        "installed (e.g. `apt-get install fonts-dejavu-core`)."
    );
  }
  return cachedFontFile;
}

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
 * Cuts a single clip from the source video and composites it into an
 * attractive vertical 9:16 frame:
 *  - the full, uncropped source frame is scaled to fit entirely inside the
 *    canvas (nothing is cut off, unlike a hard center-crop)
 *  - a blurred, slightly darkened copy of the same footage fills the
 *    surrounding space instead of plain black bars
 *  - a thin frame line, top/bottom gradient scrims, and shadowed white
 *    text (credit line + wrapped caption) are burned in on top
 * Returns the output file path.
 */
export function renderClip(sourceFilePath, { start, end, caption, creditLine }, sourceDimensions) {
  return new Promise(async (resolve, reject) => {
    try {
      const outDir = path.join(STORAGE_DIR, "clips");
      fs.mkdirSync(outDir, { recursive: true });
      const outputPath = path.join(outDir, `${uuid()}.mp4`);

      const duration = Math.max(1, end - start);
      const fontFile = resolveFontFile();
      if (!fontFile) {
        throw new Error(
          "No usable font file found on this server. Set FONT_PATH to a .ttf file, " +
            "or install one (e.g. `apt-get install fonts-dejavu-core`)."
        );
      }

      const dims = sourceDimensions || (await probeVideoDimensions(sourceFilePath));
      const { fgWidth, fgHeight, fgX, fgY } = fitContentBox(dims.width, dims.height);

      const wrappedCaption = wrapCaption(caption, { maxFontSize: 58, minFontSize: 38 });
      const safeCredit = truncate(String(creditLine || "").trim(), 90) || "Shared with permission";

      // Text is passed to drawtext via `textfile=` rather than an inline
      // `text=...` value. Inline text requires manually escaping every
      // character that's meaningful to ffmpeg's filtergraph parser (\ ' :
      // , % [ ]) - easy to get subtly wrong (as the first version of this
      // function did), and LLM-generated captions routinely contain
      // several of those characters in ordinary sentences. A plain temp
      // file sidesteps that whole class of bug: its contents are read
      // verbatim, no escaping needed.
      const tmpDir = path.join(STORAGE_DIR, "tmp");
      fs.mkdirSync(tmpDir, { recursive: true });
      const captionFile = path.join(tmpDir, `${uuid()}-caption.txt`);
      const creditFile = path.join(tmpDir, `${uuid()}-credit.txt`);
      fs.writeFileSync(captionFile, wrappedCaption.text, "utf8");
      fs.writeFileSync(creditFile, safeCredit, "utf8");
      const cleanupTextFiles = () => {
        for (const f of [captionFile, creditFile]) {
          fs.unlink(f, () => {});
        }
      };

      const filterComplex = buildFilterComplex({
        fgWidth,
        fgHeight,
        fgX,
        fgY,
        fontFile,
        captionFile,
        captionFontSize: wrappedCaption.fontSize,
        creditFile,
      });

      if (process.env.CLIPPER_DEBUG) console.error("FILTER:", filterComplex);
      ffmpeg(sourceFilePath)
        .inputOptions([
          // Input-side seeking: ffmpeg jumps to the nearest keyframe and
          // decodes forward from there, instead of decoding the whole file
          // from t=0 for every single clip. For a job that cuts 15-20 clips
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
        .on("end", () => {
          cleanupTextFiles();
          resolve(outputPath);
        })
        .on("error", (err) => {
          cleanupTextFiles();
          reject(err);
        });
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

function buildFilterComplex({ fgWidth, fgHeight, fgX, fgY, fontFile, captionFile, captionFontSize, creditFile }) {
  const W = CANVAS_WIDTH;
  const H = CANVAS_HEIGHT;
  const font = escapeDrawtextPath(fontFile);
  const captionPath = escapeDrawtextPath(captionFile);
  const creditPath = escapeDrawtextPath(creditFile);

  const captionBoxHeight = Math.min(560, 260 + captionFontSize * 4);
  const topScrimHeight = 190;

  return [
    // Split the source once: one copy becomes the blurred backdrop, the
    // other is the full, undistorted foreground.
    `[0:v]split=2[bgsrc][fgsrc]`,

    // Backdrop: cover-crop to fill the canvas, then blur + darken + boost
    // saturation slightly so it reads as an intentional background rather
    // than a mistake, and never lets plain black bars show.
    `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30,eq=brightness=-0.08:saturation=1.3[bg]`,

    // Foreground: scaled to fit entirely inside the canvas - the full
    // frame is always visible, nothing is cropped off the sides or top.
    `[fgsrc]scale=${fgWidth}:${fgHeight}[fg]`,

    // Composite foreground centered over the blurred backdrop.
    `[bg][fg]overlay=${fgX}:${fgY}[framed]`,

    // Thin frame line around the content box for a "card" look.
    `[framed]drawbox=x=${fgX}:y=${fgY}:w=${fgWidth}:h=${fgHeight}:color=white@0.85:t=3[bordered]`,

    // Soft dark scrims top/bottom so white text stays legible regardless
    // of what's playing underneath it.
    `[bordered]drawbox=x=0:y=0:w=${W}:h=${topScrimHeight}:color=black@0.4:t=fill[topscrim]`,
    `[topscrim]drawbox=x=0:y=${H - captionBoxHeight}:w=${W}:h=${captionBoxHeight}:color=black@0.48:t=fill[botscrim]`,

    // Small accent bar above the caption for a bit of brand color.
    `[botscrim]drawbox=x=(${W}-120)/2:y=${H - captionBoxHeight + 34}:w=120:h=6:color=${ACCENT_COLOR}@0.95:t=fill[accent]`,

    // Credit line, top center.
    `[accent]drawtext=fontfile=${font}:textfile=${creditPath}:expansion=none:fontcolor=white@0.92:fontsize=30:x=(w-text_w)/2:y=64:line_spacing=8[credited]`,

    // Caption, bottom center, with a soft drop shadow for extra contrast.
    `[credited]drawtext=fontfile=${font}:textfile=${captionPath}:expansion=none:fontcolor=black@0.55:fontsize=${captionFontSize}:x=(w-text_w)/2+3:y=h-${captionBoxHeight}+90+3:line_spacing=14[shadow]`,
    `[shadow]drawtext=fontfile=${font}:textfile=${captionPath}:expansion=none:fontcolor=white:fontsize=${captionFontSize}:x=(w-text_w)/2:y=h-${captionBoxHeight}+90:line_spacing=14[out]`,
  ].join(";");
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}\u2026`;
}

/**
 * Word-wraps a caption to fit within the canvas width, picking a smaller
 * font size for longer captions so it still reads as a tidy block instead
 * of overflowing the frame or getting clipped off-screen (the previous
 * version drew captions as a single unwrapped line).
 */
function wrapCaption(rawCaption, { maxFontSize, minFontSize }) {
  const caption = truncate(String(rawCaption || "").trim(), 140) || "Key moment from this video";
  const sidePadding = 90;
  const safeWidth = CANVAS_WIDTH - sidePadding * 2;
  const maxLines = 4;

  const fontSize = caption.length > 90 ? minFontSize : caption.length > 55 ? 48 : maxFontSize;
  const avgCharWidth = fontSize * 0.56; // approximation for a bold sans font
  const maxCharsPerLine = Math.max(8, Math.floor(safeWidth / avgCharWidth));

  const lines = wrapText(caption, maxCharsPerLine, maxLines);
  return { text: lines.join("\n"), fontSize };
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) lines.length = maxLines;

  // If words remain unused because we hit maxLines, mark the last line as
  // truncated so it's clear the caption was shortened, not corrupted.
  const usedWordCount = lines.join(" ").split(/\s+/).length;
  if (usedWordCount < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.replace(/[.,;:\u2026]+$/, "")}\u2026`;
  }

  return lines;
}

// Font/text file paths still go through the filtergraph value parser (they
// sit in a `fontfile=`/`textfile=` option), so the small set of characters
// that are structurally meaningful there - backslash and colon (drive
// letters on Windows) - still need escaping. This is a much smaller,
// safer surface than escaping arbitrary caption content.
function escapeDrawtextPath(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/:/g, "\\:");
}