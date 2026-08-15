import fs from "fs/promises";
import path from "path";
import Job from "../models/Job.js";

// In-process registry of pending "delete this group's source file" timers,
// keyed by sourceGroupId (a job's own _id if it's the original of its
// group). Deliberately in-memory, matching the rest of the job
// pipeline (jobProcessor.js's queue is in-process too, not a real job
// queue) - a server restart loses pending timers the same way it loses
// in-flight jobs, and the STORAGE_MAX_AGE_MINUTES sweep in server.js is the
// backstop that catches whatever this misses. Restart safety is why the
// default retention window (SOURCE_RETENTION_MS in jobProcessor.js) should
// stay comfortably shorter than STORAGE_MAX_AGE_MINUTES.
const pendingGroupCleanups = new Map();

/**
 * Deletes a file if it exists. Never throws — logs and returns false on
 * failure so cleanup never crashes the job pipeline.
 */
export async function safeDeleteFile(filePath) {
  if (!filePath) return false;
  try {
    await fs.unlink(filePath);
    console.log(`[cleanup] deleted ${filePath}`);
    return true;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[cleanup] failed to delete ${filePath}: ${err.message}`);
    }
    return false;
  }
}

/**
 * Cancels a previously scheduled group cleanup (see scheduleGroupCleanup)
 * without running it. Used when a reanalyze request claims the file before
 * its retention window lapses.
 */
export function cancelGroupCleanup(groupId) {
  const key = String(groupId);
  const timer = pendingGroupCleanups.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingGroupCleanups.delete(key);
  }
}

/**
 * Schedules the shared source file for a job group (the original job plus
 * any jobs reanalyzed from it - see sourceGroupId on the Job model) to be
 * deleted after delayMs, instead of deleting it the moment a job finishes.
 * This is what makes "reanalyze" possible: the file survives long enough
 * for a follow-up job to reuse it. Replaces any timer already pending for
 * this group rather than stacking a second one.
 *
 * When the timer fires, every Job document in the group (the original plus
 * any reanalyses) is marked as having its source file removed, since they
 * all pointed at the same physical path.
 */
export function scheduleGroupCleanup(groupId, filePath, delayMs) {
  const key = String(groupId);
  cancelGroupCleanup(key);
  const timer = setTimeout(async () => {
    pendingGroupCleanups.delete(key);
    await safeDeleteFile(filePath);
    try {
      await Job.updateMany(
        { $or: [{ _id: key }, { sourceGroupId: key }] },
        {
          $set: { workingFilePath: null, sourceFileRemoved: true, sourceFileRemovedAt: new Date() },
        }
      );
    } catch (err) {
      console.error(`[cleanup] failed to mark job group ${key} as cleaned up:`, err);
    }
  }, delayMs);
  // Don't let this timer keep the Node process alive on its own during
  // graceful shutdown.
  timer.unref?.();
  pendingGroupCleanups.set(key, timer);
}

/**
 * Recursively deletes every file under dirPath whose last-modified time is
 * older than maxAgeMs. This is the backstop cleanup for the free Render
 * plan: free web services get no persistent disk (local storage/ lives on
 * the container's small ephemeral filesystem — see DEPLOYMENT.md), so
 * anything the normal per-job cleanup misses (a crash mid-job, an
 * abandoned chunked upload, a source file left behind by an old bug) has
 * to be swept up on a timer instead of waiting for a redeploy to wipe it,
 * or a couple of large videos in a row can fill the disk and start
 * failing every job. Called on server startup and on an interval — see
 * server.js. Never throws.
 */
export async function purgeOldFiles(dirPath, maxAgeMs) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[cleanup] failed to read ${dirPath}: ${err.message}`);
    }
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g. uploads/.chunks/<uploadId> for
        // in-progress/abandoned chunked uploads) so stale parts inside
        // them get swept the same way as top-level files.
        await purgeOldFiles(fullPath, maxAgeMs);
        return;
      }
      try {
        const stats = await fs.stat(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          await fs.unlink(fullPath);
          console.log(`[cleanup] swept stale file ${fullPath}`);
        }
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error(`[cleanup] sweep failed for ${fullPath}: ${err.message}`);
        }
      }
    })
  );
}
