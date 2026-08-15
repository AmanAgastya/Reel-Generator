import express from "express";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { once } from "events";
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

  // The uploadId is derived deterministically from the file's identity
  // (name + size + credit name) instead of a random uuid. That's what makes
  // uploads resumable: if the tab is refreshed, the network drops, or the
  // server restarts mid-upload (all of which show up in the Render logs as
  // a stall followed by SIGTERM), re-selecting the *same* file and calling
  // /uploads/init again lands on the same uploadId - and therefore the same
  // on-disk chunk directory - instead of starting a brand new empty session.
  // The chunk directory lives on the persistent Render disk (see
  // render.yaml), so parts saved before a restart are still there after it.
  const fingerprint = `${originalFileName}:${fileSize}:${ownerCreditName}`;
  const uploadId = crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 36);
  const dir = path.join(CHUNK_ROOT, uploadId);
  const expectedChunks = Math.ceil(fileSize / CHUNK_SIZE);

  // Look for a previous, unfinished session for this exact file and report
  // back which chunks it already has, so the client can skip re-sending
  // them instead of re-uploading the whole file from 0%.
  let uploadedChunks = [];
  try {
    const existingMeta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    if (existingMeta.originalFileSize === fileSize && existingMeta.originalFileName === originalFileName) {
      const files = await fs.readdir(dir);
      uploadedChunks = files
        .filter((name) => name.endsWith(".part"))
        .map((name) => Number(name.replace(".part", "")))
        .filter((index) => Number.isInteger(index));
    } else {
      // Fingerprint collision with a different file - extremely unlikely,
      // but start clean rather than mixing chunks from two different files.
      await fs.rm(dir, { recursive: true, force: true });
    }
  } catch {
    // No existing session for this file yet - that's fine, we create one below.
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ ownerCreditName, originalFileName, originalFileSize: fileSize, expectedChunks })
  );
  // Return the server's actual chunk size so the frontend never has to
  // guess/hardcode a value that could drift out of sync with this server's
  // configuration (that drift is what causes spurious "file too large"
  // errors on every chunk).
  res.status(201).json({ uploadId, chunkSize: CHUNK_SIZE, uploadedChunks });
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
    // multer's own limiter allows a small margin above CHUNK_SIZE (see
    // upload.js), so enforce the exact limit here — only the last chunk of
    // a file is allowed to be smaller, never any chunk larger than CHUNK_SIZE.
    if (req.file.size > CHUNK_SIZE) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(413).json({ error: "Chunk exceeds the server's configured chunk size." });
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
  let outputPath;
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    if (Number.isInteger(meta.expectedChunks) && totalChunks !== meta.expectedChunks) {
      return res.status(400).json({ error: "totalChunks does not match the number of chunks expected for this upload" });
    }
    outputPath = path.join(STORAGE_DIR, "uploads", `${Date.now()}-${meta.originalFileName}`);

    // Stream each part into the output file instead of reading it fully
    // into memory and appendFile-ing it (which reopens the destination
    // file for every single chunk). Piping keeps one file descriptor open
    // for the whole assembly and never buffers more than a stream's
    // internal chunk size at once, which is both faster and lighter on
    // memory for large, many-chunk uploads.
    //
    // stream/promises' pipeline() attaches its own 'error'/'close'/'finish'/
    // 'end' listeners to every stream it's given, including the
    // destination, to track completion - and with `end: false` (needed
    // here since the destination has to stay open across many source
    // parts) it never got the chance to tear those listeners back down
    // between calls. Calling pipeline() once per chunk against the same
    // long-lived outStream meant every chunk left another set of listeners
    // behind, which is exactly the MaxListenersExceededWarning ("11 error
    // listeners", "11 close listeners", ...) seen in production - not a
    // functional bug yet, but on a job with more than ~10 chunks it would
    // start silently swallowing events past Node's default cap.
    //
    // Writing directly with the destination's own backpressure signal
    // (write() / 'drain') never attaches anything to outStream at all, so
    // there's nothing to leak regardless of how many parts are assembled.
    const outStream = createWriteStream(outputPath, { flags: "wx" });
    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const part = path.join(dir, `${String(index).padStart(6, "0")}.part`);
        const partStream = createReadStream(part);
        for await (const chunk of partStream) {
          if (!outStream.write(chunk)) await once(outStream, "drain");
        }
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

    const job = await Job.create({ sourceType: "upload", sourceFilePath: outputPath, originalFileName: meta.originalFileName, ownershipConfirmed: true, ownerCreditName: meta.ownerCreditName });
    await fs.rm(dir, { recursive: true, force: true });
    enqueueJob(job._id);
    res.status(201).json(job);
  } catch (err) {
    // Don't leave a truncated/corrupt partial file behind on disk if
    // assembly failed partway through.
    if (outputPath) await fs.unlink(outputPath).catch(() => {});
    res.status(400).json({ error: `Could not complete upload: ${err.message}` });
  }
}));

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

/**
 * Collects every clip range already produced by any job in a source
 * video's group (the original job plus any prior reanalyses of it), so a
 * new reanalysis can steer around them. Only rendered/pending clips count -
 * a clip that failed to render was never actually delivered to the user, so
 * its moment is still fair game.
 */
async function collectUsedRanges(groupId) {
  const groupJobs = await Job.find({ $or: [{ _id: groupId }, { sourceGroupId: groupId }] }, { _id: 1 });
  const jobIds = groupJobs.map((j) => j._id);
  const clips = await Clip.find(
    { job: { $in: jobIds }, status: { $in: ["rendered", "pending"] } },
    { startSeconds: 1, endSeconds: 1 }
  );
  return clips.map((clip) => ({ start: clip.startSeconds, end: clip.endSeconds }));
}

/**
 * Re-runs analysis + clipping on the same source video to produce a
 * different set of clips, reusing the original's transcript and every
 * other setting (owner credit, clip length/count rules, etc.) unchanged.
 * Skips the download/upload and transcription steps entirely when the
 * source video is still retained on disk (see SOURCE_RETENTION_MS in
 * jobProcessor.js) - otherwise falls back to re-downloading it (YouTube
 * sources only; an uploaded video that's no longer retained has to be
 * re-uploaded, since there's no copy of it left anywhere to re-fetch).
 */
router.post("/:id/reanalyze", asyncHandler(async (req, res) => {
  let job;
  try {
    job = await Job.findById(req.params.id);
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid job id" });
    throw err;
  }
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "completed") {
    return res.status(409).json({ error: "This job hasn't finished generating clips yet." });
  }

  const groupId = job.sourceGroupId || job._id;
  const excludeRanges = await collectUsedRanges(groupId);

  let reuseFilePath = null;
  if (job.workingFilePath) {
    try {
      await fs.access(job.workingFilePath);
      reuseFilePath = job.workingFilePath;
    } catch {
      reuseFilePath = null;
    }
  }

  if (!reuseFilePath && job.sourceType === "upload") {
    return res.status(409).json({
      error:
        "The original video is no longer available on the server, so it can't be reanalyzed. " +
        "Upload the same video again to get a new set of clips.",
    });
  }

  const newJob = await Job.create({
    sourceType: job.sourceType,
    sourceUrl: job.sourceType === "youtube_url" ? job.sourceUrl : undefined,
    originalFileName: job.originalFileName,
    ownershipConfirmed: true,
    ownerCreditName: job.ownerCreditName,
    isReanalysis: true,
    reanalyzedFrom: job._id,
    sourceGroupId: groupId,
    excludeRanges,
    ...(reuseFilePath
      ? {
          workingFilePath: reuseFilePath,
          transcript: job.transcript,
          videoDurationSeconds: job.videoDurationSeconds,
        }
      : {}),
  });

  enqueueJob(newJob._id);

  res.status(201).json(newJob);
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
