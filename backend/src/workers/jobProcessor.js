import Job from "../models/Job.js";
import Clip from "../models/Clip.js";
import { downloadYouTubeVideo } from "../services/downloader.js";
import { transcribeVideo } from "../services/transcriber.js";
import { analyzeBestMoments } from "../services/analyzer.js";
import { renderClip, probeVideoDimensions } from "../services/clipper.js";
import { safeDeleteFile } from "../utils/cleanup.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { getEffectiveCpuCount } from "../utils/cpuLimit.js";

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
// Each clip render is an independent ffmpeg encode of a short (15-60s)
// segment, so this is the biggest lever on total job time for jobs with
// many clips. Default to using most of the machine's cores (capped at 4 so
// a big box doesn't thrash on disk I/O) instead of the old hardcoded cap of
// 2 — see CLIP_RENDER_THREADS in clipper.js, which is sized to divide the
// remaining cores across these concurrent renders.
//
// getEffectiveCpuCount() (not the raw os.cpus() host count) is what this is
// sized off of - see cpuLimit.js for why. On a CPU-throttled deploy target
// like Render's free tier, os.cpus() was reporting the host's full core
// count while the container was actually capped at a sliver of one CPU, so
// this was launching several concurrent ffmpeg encodes that all had to
// fight over that same tiny slice - each one starved of CPU time by the
// others, which is what made rendering feel disproportionately slow. On an
// unthrottled machine (dev laptop, a paid box) getEffectiveCpuCount() just
// falls back to the host core count, so behavior there is unchanged.
const CLIP_RENDER_CONCURRENCY = Math.max(
  1,
  Number(process.env.CLIP_RENDER_CONCURRENCY || Math.min(4, getEffectiveCpuCount()))
);
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
    if (!job.startedAt) job.startedAt = new Date();
    await job.save();

    const sourceFilePath =
      job.sourceType === "youtube_url"
        ? await downloadYouTubeVideo(job.sourceUrl)
        : job.sourceFilePath;

    job.workingFilePath = sourceFilePath;
    await job.save();

    // 2. Transcribe
    job.status = "transcribing";
    job.progress = 15;
    await job.save();
    // transcribeVideo's progress callback fires once per transcription
    // chunk, and those chunks run TRANSCRIPTION_CONCURRENCY-at-a-time (see
    // transcriber.js) - so several chunks can finish within the same tick
    // and call this callback concurrently. Calling `job.save()` directly
    // here let multiple saves race on the same in-memory document, which
    // is exactly what Mongoose's "Can't save() the same doc multiple times
    // in parallel" (ParallelSaveError) is reporting. Chained through the
    // same saveChain pattern used for the clip-rendering loop below so
    // concurrent progress updates queue up and save one at a time instead.
    let transcribeSaveChain = Promise.resolve();
    const transcript = await transcribeVideo(sourceFilePath, async (percent) => {
      job.status = "transcribing";
      job.progress = 15 + Math.round(percent * 25);
      transcribeSaveChain = transcribeSaveChain
        .then(() => job.save())
        .catch((e) => console.error("[job] transcription progress save failed:", e));
      return transcribeSaveChain;
    });
    await transcribeSaveChain;
    job.transcript = transcript;
    job.videoDurationSeconds = Math.max(
      0,
      (transcript[transcript.length - 1]?.end || 0) - (transcript[0]?.start || 0)
    );
    job.progress = 40;
    await job.save();

    // 3. Analyze for best moments
    job.status = "analyzing";
    job.progress = 60;
    await job.save();
    const moments = await analyzeBestMoments(transcript, {
      ownerCreditName: job.ownerCreditName,
      sourceFilePath,
    });
    if (!moments.length) {
      throw new Error("No usable moments were found in the video transcript.");
    }

    // 4. Render each clip
    job.status = "clipping";
    job.progress = 70;
    job.clipRenderCount = moments.length;
    await job.save();

    // Probe the source video's dimensions once per job instead of once per
    // clip - every clip render needs it (to fit the full frame into the
    // vertical canvas without cropping), and it's the same file every time.
    const sourceDimensions = await probeVideoDimensions(sourceFilePath);

    const total = moments.length || 1;
    let done = 0;
    let rendered = 0;
    const renderErrors = [];

    // Serialize DB writes for progress even though renders run in parallel,
    // so concurrent `job.save()` calls on the same in-memory doc don't race.
    let saveChain = Promise.resolve();
    const queueProgressSave = () => {
      saveChain = saveChain.then(() => job.save()).catch((e) => console.error("[job] progress save failed:", e));
      return saveChain;
    };

    // Clips are rendered CLIP_RENDER_CONCURRENCY at a time instead of one at
    // a time (was: sequential await in a for loop — the dominant cost for
    // jobs with many clips, since each render is an independent ffmpeg run).
    await mapWithConcurrency(moments, CLIP_RENDER_CONCURRENCY, async (moment) => {
      const clipDoc = await Clip.create({
        job: job._id,
        startSeconds: moment.start,
        endSeconds: moment.end,
        caption: String(moment.caption || ""),
        hashtags: moment.hashtags || [],
        creditLine: moment.creditLine,
        rankScore: moment.rankScore,
        status: "pending",
      });

      try {
        const filePath = await renderClip(sourceFilePath, moment, sourceDimensions);
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
      queueProgressSave();
    });

    await saveChain;

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
    // Clear the source video on failure too — previously this only ran in
    // the success path, so a failed job (bad transcript, ffmpeg error,
    // blocked download, etc.) left its downloaded/uploaded video sitting
    // on disk forever. On the free Render plan there's no persistent disk
    // and no separate cleanup job, so a run of failed jobs would quietly
    // fill the container's disk until every subsequent job started
    // failing too.
    const leftoverPath = job.workingFilePath || job.sourceFilePath;
    if (leftoverPath) {
      await safeDeleteFile(leftoverPath);
      job.workingFilePath = null;
      job.sourceFilePath = null;
      job.sourceFileRemoved = true;
      job.sourceFileRemovedAt = new Date();
    }
    job.status = "failed";
    job.error = err.message;
    await job.save();
  }
}
