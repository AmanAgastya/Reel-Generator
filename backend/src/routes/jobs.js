import express from "express";
import path from "path";
import fs from "fs/promises";
import { v4 as uuid } from "uuid";
import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { upload, uploadChunk } from "../middleware/upload.js";
import { enqueueJob } from "../workers/jobProcessor.js";

const router = express.Router();
const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
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

router.get("/", asyncHandler(async (req, res) => {
  const jobs = await Job.find().sort({ createdAt: -1 }).limit(50);
  res.json(jobs);
}));

router.get("/:id/clips/:clipId/download", asyncHandler(async (req, res) => {
  try {
    const clip = await Clip.findById(req.params.clipId);
    if (!clip || !clip.filePath) return res.status(404).json({ error: "clip not found" });
    res.download(path.resolve(clip.filePath));
  } catch (err) {
    console.error("[jobs] download clip failed:", err);
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid clip id" });
    }
    throw err;
  }
}));

export default router;
