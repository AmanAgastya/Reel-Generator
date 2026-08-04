import express from "express";
import path from "path";
import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { upload } from "../middleware/upload.js";
import { processJob } from "../workers/jobProcessor.js";

const router = express.Router();

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
