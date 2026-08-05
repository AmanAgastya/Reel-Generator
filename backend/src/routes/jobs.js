import express from "express";
import path from "path";
import fs from "fs/promises";
import { v4 as uuid } from "uuid";
import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { upload, uploadChunk } from "../middleware/upload.js";
import { enqueueJob } from "../workers/jobProcessor.js";
import { generateCaptionForClip } from "../services/analyzer.js";

const router = express.Router();
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const CHUNK_ROOT = path.join(STORAGE_DIR, "uploads", ".chunks");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post("/uploads/init", asyncHandler(async (req, res) => {
  const { ownershipConfirmed, ownerCreditName, originalFileName } = req.body;
  if (!ownershipConfirmed || !ownerCreditName || !originalFileName) {
    return res.status(400).json({ error: "ownership confirmation, credit name, and file name are required" });
  }
  const uploadId = uuid();
  const dir = path.join(CHUNK_ROOT, uploadId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ ownerCreditName, originalFileName }));
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
    await fs.access(path.join(dir, "meta.json"));
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
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    const outputPath = path.join(STORAGE_DIR, "uploads", `${Date.now()}-${meta.originalFileName}`);
    for (let index = 0; index < totalChunks; index += 1) {
      const part = path.join(dir, `${String(index).padStart(6, "0")}.part`);
      await fs.appendFile(outputPath, await fs.readFile(part));
    }
    const job = await Job.create({ sourceType: "upload", sourceFilePath: outputPath, originalFileName: meta.originalFileName, ownershipConfirmed: true, ownerCreditName: meta.ownerCreditName });
    await fs.rm(dir, { recursive: true, force: true });
    enqueueJob(job._id);
    res.status(201).json(job);
  } catch (err) {
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