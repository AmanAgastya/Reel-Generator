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
// are assembled by the route only after every part has arrived.
export const uploadChunk = multer({
  dest: chunkDir,
  limits: { fileSize: 8 * 1024 * 1024 },
});
