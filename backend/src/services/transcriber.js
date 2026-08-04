import fs from "fs";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3";

/**
 * Transcribes a video/audio file using Groq's hosted Whisper and returns
 * timestamped segments.
 * Returns: [{ start, end, text }, ...]
 */
export async function transcribeVideo(filePath) {
  const response = await groq.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: WHISPER_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  const segments = (response.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return segments;
}
