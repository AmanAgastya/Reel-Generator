import multer from "multer";
import path from "path";
import fs from "fs";

const STORAGE_DIR = process.env.STORAGE_DIR || "./storage";
const uploadDir = path.join(STORAGE_DIR, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${file.originalname}`;
    cb(null, unique);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const ok = /mp4|mov|mkv|webm/i.test(file.mimetype) || /\.(mp4|mov|mkv|webm)$/i.test(file.originalname);
    cb(ok ? null : new Error("Unsupported video format"), ok);
  },
});
