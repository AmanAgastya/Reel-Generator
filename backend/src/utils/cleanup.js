import fs from "fs/promises";
import path from "path";

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