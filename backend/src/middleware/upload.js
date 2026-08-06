import multer from "multer";
import path from "path";
import fs from "fs";

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const uploadDir = path.join(STORAGE_DIR, "uploads");
const chunkDir = path.join(uploadDir, ".chunks");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(chunkDir, { recursive: true });

// Uploads are never re-encoded/compressed — the original file is stored
// and processed as-is — so this cap is sized for raw, uncompressed-quality
// footage (long/high-res phone or screen recordings) rather than a
// pre-shrunk file. Exported so routes/jobs.js can apply the same limit to
// chunked uploads, which bypass multer's per-request fileSize check since
// each individual chunk is small.
export const MAX_UPLOAD_FILE_SIZE = Number(process.env.MAX_UPLOAD_FILE_SIZE || 5 * 1024 * 1024 * 1024); // 5GB

// Keep each browser request safely below common proxy upload limits. Chunks
// are assembled by the route only after every part has arrived. Large
// enough to keep request-count/overhead low, small enough that several
// chunks can transfer over separate connections at once and a failed
// chunk only has to retry itself, not the whole file. Exported so
// routes/jobs.js can compute the expected chunk count for a given file
// size — must match the frontend's CHUNK_SIZE (see frontend/src/api/client.js).
export const CHUNK_SIZE = Number(process.env.UPLOAD_CHUNK_SIZE || 16 * 1024 * 1024);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname}`;
    cb(null, unique);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ok = /mp4|mov|mkv|webm/i.test(file.mimetype) || /\.(mp4|mov|mkv|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error("Unsupported video format"), ok);
  },
});

export const uploadChunk = multer({
  dest: chunkDir,
  limits: { fileSize: CHUNK_SIZE },
});