import multer from "multer";
import path from "path";
import fs from "fs";

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const uploadDir = path.join(STORAGE_DIR, "uploads");
const chunkDir = path.join(uploadDir, ".chunks");
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(chunkDir, { recursive: true });

const MAX_UPLOAD_FILE_SIZE = 1 * 1024 * 1024 * 1024; // 1GB
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

// Keep each browser request safely below common proxy upload limits. Chunks
// are assembled by the route only after every part has arrived. Sized to
// match the frontend's chunk size (see CHUNK_SIZE in frontend/src/api/client.js) -
// large enough to keep request-count/overhead low, small enough that
// several chunks can transfer over separate connections at once and a
// failed chunk only has to retry itself, not the whole file.
export const uploadChunk = multer({
  dest: chunkDir,
  limits: { fileSize: 16 * 1024 * 1024 },
});