import fs from "fs/promises";

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
