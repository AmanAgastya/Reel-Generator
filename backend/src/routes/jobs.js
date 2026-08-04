import express from "express";
import path from "path";
import fs from "fs/promises";
import { v4 as uuid } from "uuid";
import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { upload, uploadChunk } from "../middleware/upload.js";
import { processJob } from "../workers/jobProcessor.js";

const router = express.Router();
const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
const CHUNK_ROOT = path.join(STORAGE_DIR, "uploads", ".chunks");

router.post("/uploads/init", async (req, res) => {
  const { ownershipConfirmed, ownerCreditName, originalFileName } = req.body;
  if (!ownershipConfirmed || !ownerCreditName || !originalFileName) {
    return res.status(400).json({ error: "ownership confirmation, credit name, and file name are required" });
  }
  const uploadId = uuid();
  const dir = path.join(CHUNK_ROOT, uploadId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ ownerCreditName, originalFileName }));
  res.status(201).json({ uploadId });
});

router.post("/uploads/:uploadId/chunks", uploadChunk.single("chunk"), async (req, res) => {
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
});

router.post("/uploads/:uploadId/complete", async (req, res) => {
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
    processJob(job._id).catch((err) => console.error("[job] unhandled error:", err));
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: `Could not complete upload: ${err.message}` });
  }
});

/**
 * Create a job from a YouTube URL (your own channel's video).
 * Requires ownershipConfirmed=true and an ownerCreditName.
 */
router.post("/from-url", async (req, res) => {
  try {
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

    processJob(job._id).catch((err) => console.error("[job] unhandled error:", err));

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create a job from a directly uploaded video file.
 */
router.post("/from-upload", upload.single("video"), async (req, res) => {
  try {
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

    processJob(job._id).catch((err) => console.error("[job] unhandled error:", err));

    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  const clips = await Clip.find({ job: job._id }).sort({ rankScore: -1 });
  res.json({ job, clips });
});

router.get("/", async (req, res) => {
  const jobs = await Job.find().sort({ createdAt: -1 }).limit(50);
  res.json(jobs);
});

router.get("/:id/clips/:clipId/download", async (req, res) => {
  const clip = await Clip.findById(req.params.clipId);
  if (!clip || !clip.filePath) return res.status(404).json({ error: "clip not found" });
  res.download(path.resolve(clip.filePath));
});

export default router;
