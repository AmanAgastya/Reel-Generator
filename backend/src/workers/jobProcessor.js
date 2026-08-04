import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { downloadYouTubeVideo } from "../services/downloader.js";
import { transcribeVideo } from "../services/transcriber.js";
import { analyzeBestMoments } from "../services/analyzer.js";
import { renderClip } from "../services/clipper.js";
import { safeDeleteFile } from "../utils/cleanup.js";

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 4));
const queuedJobIds = [];
const activeJobIds = new Set();

// Keep expensive ffmpeg/transcription work off the request path while allowing
// multiple independently submitted jobs to progress at the same time.
export function enqueueJob(jobId) {
  const id = String(jobId);
  if (activeJobIds.has(id) || queuedJobIds.includes(id)) return;
  queuedJobIds.push(id);
  runQueuedJobs();
}

function runQueuedJobs() {
  while (activeJobIds.size < MAX_CONCURRENT_JOBS && queuedJobIds.length) {
    const jobId = queuedJobIds.shift();
    activeJobIds.add(jobId);
    processJob(jobId)
      .catch((err) => console.error("[job] unhandled error:", err))
      .finally(() => {
        activeJobIds.delete(jobId);
        runQueuedJobs();
      });
  }
}

/**
 * Runs the full pipeline for a single job. Called fire-and-forget from the
 * route handler after the job document is created. In production this
 * should be a proper queue (BullMQ/Redis) instead of an in-process async
 * function, so a server restart doesn't lose in-flight jobs.
 */
export async function processJob(jobId) {
  const job = await Job.findById(jobId);
  if (!job) return;

  // Hard stop: never process a job that hasn't had ownership/rights confirmed.
  if (!job.ownershipConfirmed) {
    job.status = "failed";
    job.error = "Ownership/rights confirmation is required before processing.";
    await job.save();
    return;
  }

  try {
    // 1. Get local video file
    job.status = "downloading";
    job.progress = 10;
    await job.save();

    const sourceFilePath =
      job.sourceType === "youtube_url"
        ? await downloadYouTubeVideo(job.sourceUrl)
        : job.sourceFilePath;

    job.workingFilePath = sourceFilePath;
    await job.save();

    // 2. Transcribe
    job.status = "transcribing";
    job.progress = 35;
    await job.save();
    const transcript = await transcribeVideo(sourceFilePath);
    job.transcript = transcript;
    await job.save();

    // 3. Analyze for best moments
    job.status = "analyzing";
    job.progress = 60;
    await job.save();
    const moments = await analyzeBestMoments(transcript, {
      ownerCreditName: job.ownerCreditName,
    });
    if (!moments.length) {
      throw new Error("No usable moments were found in the video transcript.");
    }

    // 4. Render each clip
    job.status = "clipping";
    job.progress = 70;
    await job.save();

    const total = moments.length || 1;
    let done = 0;
    let rendered = 0;
    const renderErrors = [];

    for (const moment of moments) {
      const clipDoc = await Clip.create({
        job: job._id,
        startSeconds: moment.start,
        endSeconds: moment.end,
        caption: moment.caption,
        hashtags: moment.hashtags || [],
        creditLine: moment.creditLine,
        rankScore: moment.rankScore,
        status: "pending",
      });

      try {
        const filePath = await renderClip(sourceFilePath, moment);
        clipDoc.filePath = filePath;
        clipDoc.status = "rendered";
        await clipDoc.save();
        rendered += 1;
      } catch (err) {
        clipDoc.status = "failed";
        await clipDoc.save();
        renderErrors.push(err.message);
        console.error(`[job] clip render failed: ${err.message}`);
      }

      done += 1;
      job.progress = 70 + Math.round((done / total) * 30);
      await job.save();
    }

    if (!rendered) {
      throw new Error(`Could not render any clips. ${renderErrors[0] || "Check the server logs for ffmpeg errors."}`);
    }

    // Clips are cut — the full source video is no longer needed. Remove it
    // from disk and clear its reference in the DB so it isn't kept around
    // (or re-servable) after the job finishes.
    await safeDeleteFile(sourceFilePath);
    job.workingFilePath = null;
    job.sourceFilePath = null;
    job.sourceFileRemoved = true;
    job.sourceFileRemovedAt = new Date();

    job.status = "completed";
    job.progress = 100;
    await job.save();
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    await job.save();
  }
}
