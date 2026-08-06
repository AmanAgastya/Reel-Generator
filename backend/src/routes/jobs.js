import express from "express";
import path from "path";
import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { v4 as uuid } from "uuid";
import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { upload, uploadChunk, MAX_UPLOAD_FILE_SIZE, CHUNK_SIZE } from "../middleware/upload.js";
import { enqueueJob } from "../workers/jobProcessor.js";
import { generateCaptionForClip } from "../services/analyzer.js";

const router = express.Router();
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const CHUNK_ROOT = path.join(STORAGE_DIR, "uploads", ".chunks");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post("/uploads/init", asyncHandler(async (req, res) => {
  const { ownershipConfirmed, ownerCreditName, originalFileName, originalFileSize } = req.body;
  if (!ownershipConfirmed || !ownerCreditName || !originalFileName) {
    return res.status(400).json({ error: "ownership confirmation, credit name, and file name are required" });
  }
  const fileSize = Number(originalFileSize);
  // The frontend already refuses to select a file over MAX_UPLOAD_FILE_SIZE,
  // but that's client-side only — validate the real size here too so a
  // chunked session (which multer's normal fileSize limit never sees,
  // since each chunk is well under it) can't be used to smuggle an
  // oversized file onto disk.
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return res.status(400).json({ error: "originalFileSize is required" });
  }
  if (fileSize > MAX_UPLOAD_FILE_SIZE) {
    return res.status(413).json({
      error: `Video file is too large. Maximum upload size is ${Math.floor(MAX_UPLOAD_FILE_SIZE / (1024 * 1024 * 1024))}GB.`,
    });
  }
  const uploadId = uuid();
  const dir = path.join(CHUNK_ROOT, uploadId);
  await fs.mkdir(dir, { recursive: true });
  const expectedChunks = Math.ceil(fileSize / CHUNK_SIZE);
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ ownerCreditName, originalFileName, originalFileSize: fileSize, expectedChunks })
  );
  res.status(201).json({ uploadId });
}));

router.post("/uploads/:uploadId/chunks", uploadChunk.single("chunk"), asyncHandler(async (req, res) => {
  const { uploadId } = req.params;
  const index = Number(req.body.index);
  if (!/^[\w-]{36}$/.test(uploadId) || !req.file || !Number.isInteger(index) || index < 0) {
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: "invalid upload chunk" });
  }
  const dir = path.join(CHUNK_ROOT, uploadId);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    if (Number.isInteger(meta.expectedChunks) && index >= meta.expectedChunks) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: "chunk index out of range for this upload" });
    }
    await fs.rename(req.file.path, path.join(dir, `${String(index).padStart(6, "0")}.part`));
    res.status(204).end();
  } catch {
    await fs.unlink(req.file.path).catch(() => {});
    res.status(404).json({ error: "upload session not found" });
  }
}));

router.post("/uploads/:uploadId/complete", asyncHandler(async (req, res) => {
  const { uploadId } = req.params;
  const totalChunks = Number(req.body.totalChunks);
  if (!/^[\w-]{36}$/.test(uploadId) || !Number.isInteger(totalChunks) || totalChunks < 1) {
    return res.status(400).json({ error: "invalid upload completion" });
  }
  const dir = path.join(CHUNK_ROOT, uploadId);

  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return res.status(404).json({ error: "upload session not found" });
  }

  // If this exact upload was already completed — e.g. the browser sent
  // this request once, the server finished creating the job, but the
  // response never made it back (dropped connection, slow network) and
  // the client retried — return the existing job instead of assembling
  // and enqueuing the video a second time.
  if (meta.jobId) {
    const existingJob = await Job.findById(meta.jobId).catch(() => null);
    if (existingJob) return res.status(200).json(existingJob);
  }

  if (Number.isInteger(meta.expectedChunks) && totalChunks !== meta.expectedChunks) {
    return res.status(400).json({ error: "totalChunks does not match the number of chunks expected for this upload" });
  }

  // BUGFIX ("uploads a large video, then after a while it fails and the
  // video never loads"): this used to assemble the whole file (streaming
  // every one of potentially hundreds of chunk parts into the final file)
  // *before* responding at all. For a multi-gigabyte upload that assembly
  // step alone can take a long time, and the HTTP response sits open and
  // silent for all of it — long enough to trip a reverse proxy's idle-
  // connection timeout (Render, nginx, etc. commonly default to ~60-100s).
  // When that happened the browser saw a hard connection failure, the
  // frontend had no job to show, and the entire upload appeared to
  // "rollback" even though every chunk had already made it to the server.
  //
  // Fix: create the Job row and respond immediately, then do the
  // (potentially slow) file assembly in the background. The frontend gets
  // a job id right away and can navigate to the status page — which keeps
  // polling regardless of how long assembly takes — instead of holding one
  // long-lived request hostage to it.
  const job = await Job.create({
    sourceType: "upload",
    originalFileName: meta.originalFileName,
    ownershipConfirmed: true,
    ownerCreditName: meta.ownerCreditName,
  });

  meta.jobId = String(job._id);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta)).catch(() => {});

  res.status(201).json(job);

  assembleUploadInBackground({ dir, totalChunks, meta, jobId: job._id }).catch((err) => {
    console.error(`[jobs] background upload assembly failed for job ${job._id}:`, err);
  });
}));

/**
 * Streams every chunk part into the final output file, verifies the
 * assembled size, then points the job at it and kicks off processing.
 * Runs after the HTTP response for /complete has already been sent (see
 * above) so a slow assembly never holds a request open. Any failure here
 * marks the job "failed" with a clear error instead of surfacing as a
 * failed HTTP request the frontend has no job to poll for.
 */
async function assembleUploadInBackground({ dir, totalChunks, meta, jobId }) {
  const outputPath = path.join(STORAGE_DIR, "uploads", `${Date.now()}-${meta.originalFileName}`);
  try {
    // Stream each part into the output file instead of reading it fully
    // into memory and appendFile-ing it (which reopens the destination
    // file for every single chunk). Piping keeps one file descriptor open
    // for the whole assembly and never buffers more than a stream's
    // internal chunk size at once, which is both faster and lighter on
    // memory for large, many-chunk uploads.
    const outStream = createWriteStream(outputPath, { flags: "wx" });
    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const part = path.join(dir, `${String(index).padStart(6, "0")}.part`);
        await pipeline(createReadStream(part), outStream, { end: false });
      }
    } finally {
      outStream.end();
      await new Promise((resolve, reject) => {
        outStream.on("finish", resolve);
        outStream.on("error", reject);
      }).catch(() => {});
    }

    const assembledStats = await fs.stat(outputPath);
    if (meta.originalFileSize && assembledStats.size !== meta.originalFileSize) {
      throw new Error("Assembled file size does not match the uploaded file — one or more chunks may be missing.");
    }

    await Job.findByIdAndUpdate(jobId, { sourceFilePath: outputPath });
    await fs.rm(dir, { recursive: true, force: true });
    enqueueJob(jobId);
  } catch (err) {
    // Don't leave a truncated/corrupt partial file behind on disk if
    // assembly failed partway through.
    await fs.unlink(outputPath).catch(() => {});
    await Job.findByIdAndUpdate(jobId, {
      status: "failed",
      error: `Could not complete upload: ${err.message}`,
    }).catch(() => {});
  }
}

/**
 * Create a job from a YouTube URL (your own channel's video).
 * Requires ownershipConfirmed=true and an ownerCreditName.
 */
router.post("/from-url", asyncHandler(async (req, res) => {
  const { url, ownershipConfirmed, ownerCreditName } = req.body;

  if (!url) return res.status(400).json({ error: "url is required" });
  if (!ownershipConfirmed) {
    return res.status(400).json({
      error:
        "You must confirm you own this video or have explicit rights to reuse it before it can be processed.",
    });
  }
  if (!ownerCreditName) {
    return res.status(400).json({ error: "ownerCreditName is required for the credit line" });
  }

  const job = await Job.create({
    sourceType: "youtube_url",
    sourceUrl: url,
    ownershipConfirmed: true,
    ownerCreditName,
  });

  enqueueJob(job._id);

  res.status(201).json(job);
}));

/**
 * Create a job from a directly uploaded video file.
 */
router.post("/from-upload", upload.single("video"), asyncHandler(async (req, res) => {
  const { ownershipConfirmed, ownerCreditName } = req.body;

  if (!req.file) return res.status(400).json({ error: "video file is required" });
  if (ownershipConfirmed !== "true") {
    return res.status(400).json({
      error:
        "You must confirm you own this video or have explicit rights to reuse it before it can be processed.",
    });
  }
  if (!ownerCreditName) {
    return res.status(400).json({ error: "ownerCreditName is required for the credit line" });
  }

  const job = await Job.create({
    sourceType: "upload",
    sourceFilePath: req.file.path,
    originalFileName: req.file.originalname,
    ownershipConfirmed: true,
    ownerCreditName,
  });

  enqueueJob(job._id);

  res.status(201).json(job);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "job not found" });
    const clips = await Clip.find({ job: job._id }).sort({ rankScore: -1 });
    const statusOrder = { rendered: 0, pending: 1, failed: 2 };
    clips.sort((a, b) => {
      const statusComparison = statusOrder[a.status] - statusOrder[b.status];
      if (statusComparison !== 0) return statusComparison;
      return (b.rankScore || 0) - (a.rankScore || 0);
    });
    res.json({ job, clips });
  } catch (err) {
    console.error("[jobs] get job failed:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid job id" });
    }
    throw err;
  }
}));

router.post("/:id/clips/:clipId/regenerate-caption", asyncHandler(async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found." });

    const clip = await Clip.findById(req.params.clipId);
    if (!clip || String(clip.job) !== req.params.id) {
      return res.status(404).json({ error: "Clip not found." });
    }

    if (!Array.isArray(job.transcript) || job.transcript.length === 0) {
      return res.status(400).json({ error: "Transcript data is not available for this job." });
    }

    const { caption, hashtags } = await generateCaptionForClip(job.transcript, {
      start: clip.startSeconds,
      end: clip.endSeconds,
    });

    clip.caption = caption || clip.caption;
    clip.hashtags = Array.isArray(hashtags) && hashtags.length ? hashtags : clip.hashtags;
    await clip.save();

    res.json({ clip });
  } catch (err) {
    console.error("[jobs] regenerate caption failed:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid clip id" });
    }
    res.status(500).json({ error: err.message || "Failed to regenerate caption." });
  }
}));

router.get("/", asyncHandler(async (req, res) => {
  const jobs = await Job.find().sort({ createdAt: -1 }).limit(50);
  res.json(jobs);
}));

/**
 * Builds a friendly, filesystem-safe download filename from a clip's
 * caption (e.g. "clip-03-when-things-got-real.mp4") instead of exposing
 * the raw UUID the file is stored under on disk.
 */
function friendlyClipFileName(clip) {
  const slugSource = String(clip.caption || "clip").trim().toLowerCase();
  const slug =
    slugSource
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clip";
  return `${slug}.mp4`;
}

/**
 * Resolves a clip's on-disk file and confirms it actually exists before
 * express tries to stream it, so a missing/expired file produces a clear
 * JSON 404 instead of a raw ENOENT bubbling up as an ugly 500.
 */
async function resolveClipFile(req, res) {
  const clip = await Clip.findById(req.params.clipId);
  if (!clip || String(clip.job) !== req.params.id) {
    res.status(404).json({ error: "Clip not found." });
    return null;
  }
  if (clip.status !== "rendered" || !clip.filePath) {
    res.status(409).json({ error: "This clip hasn't finished rendering yet." });
    return null;
  }
  const filePath = path.resolve(clip.filePath);
  try {
    await fs.access(filePath);
  } catch {
    res.status(404).json({
      error: "This clip's file is no longer available on the server (it may have been cleaned up after a restart).",
    });
    return null;
  }
  return { clip, filePath };
}

// Streams the clip inline so it can be played in the in-page <video> player.
// Express's `send` (used under sendFile) natively honors Range headers, so
// scrubbing/seeking works without any extra code here.
router.get("/:id/clips/:clipId/stream", asyncHandler(async (req, res) => {
  try {
    const resolved = await resolveClipFile(req, res);
    if (!resolved) return;
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(resolved.filePath, { headers: { "Content-Type": "video/mp4" } });
  } catch (err) {
    console.error("[jobs] stream clip failed:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid clip id" });
    }
    throw err;
  }
}));

router.get("/:id/clips/:clipId/download", asyncHandler(async (req, res) => {
  try {
    const resolved = await resolveClipFile(req, res);
    if (!resolved) return;
    res.download(resolved.filePath, friendlyClipFileName(resolved.clip), (err) => {
      // res.download() streams asynchronously after this handler returns,
      // so a mid-stream failure (e.g. the file disappearing) has to be
      // handled in this callback — a try/catch around the call above would
      // never see it.
      if (err && !res.headersSent) {
        console.error("[jobs] download clip failed mid-stream:", err);
        res.status(500).json({ error: "Failed to download clip." });
      }
    });
  } catch (err) {
    console.error("[jobs] download clip failed:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid clip id" });
    }
    throw err;
  }
}));

export default router;