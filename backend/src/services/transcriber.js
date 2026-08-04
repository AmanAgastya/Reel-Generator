import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-small";
const MAX_TRANSCRIPTION_RETRIES = Math.max(1, Number(process.env.MAX_TRANSCRIPTION_RETRIES || 2));
const TRANSCRIPTION_RETRY_DELAY_MS = Number(process.env.TRANSCRIPTION_RETRY_DELAY_MS || 1200);
const AUDIO_EXTRACTION_THREADS = Math.max(1, Number(process.env.AUDIO_EXTRACTION_THREADS || 1));
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || "32k";

/**
 * Transcribes a video/audio file using Groq's hosted Whisper and returns
 * timestamped segments.
 * Returns: [{ start, end, text }, ...]
 */
export async function transcribeVideo(filePath) {
  const audioPath = path.join(path.dirname(filePath), `${uuid()}-speech.mp3`);
  await extractSpeechAudio(filePath, audioPath);

  let response;
  try {
    response = await retryTranscription(audioPath);
  } finally {
    fs.unlinkSync(audioPath, { force: true });
  }

  const segments = (response?.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: String(s.text || "").trim(),
  }));

  if (!segments.length) {
    throw new Error("Transcription completed but no speech segments were returned.");
  }

  return segments;
}

async function retryTranscription(audioPath) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRANSCRIPTION_RETRIES; attempt += 1) {
    try {
      return await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: WHISPER_MODEL,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_TRANSCRIPTION_RETRIES) break;
      console.warn(`[transcriber] transcription attempt ${attempt} failed: ${error.message}. Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIPTION_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

function extractSpeechAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("libmp3lame")
      .audioBitrate(AUDIO_BITRATE)
      .format("mp3")
      .outputOptions([`-threads ${AUDIO_EXTRACTION_THREADS}`])
      .on("end", resolve)
      .on("error", reject)
      .save(audioPath);
  });
}
