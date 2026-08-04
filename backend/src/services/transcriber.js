import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import Groq from "groq-sdk";
import { mapWithConcurrency } from "../utils/concurrency.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-small";
const TRANSCRIPTION_CHUNK_SECONDS = Math.max(10, Number(process.env.TRANSCRIPTION_CHUNK_SECONDS || 60));
const TRANSCRIPTION_CONCURRENCY = Math.max(1, Number(process.env.TRANSCRIPTION_CONCURRENCY || 2));
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
  const chunkRoot = path.join(path.dirname(filePath), `${uuid()}-chunks`);
  fs.mkdirSync(chunkRoot, { recursive: true });

  const duration = await getMediaDuration(filePath);
  const chunks = buildChunkRanges(duration, TRANSCRIPTION_CHUNK_SECONDS);

  try {
    const chunkFiles = await mapWithConcurrency(chunks, TRANSCRIPTION_CONCURRENCY, async ({ start, duration }, index) => {
      const chunkPath = path.join(chunkRoot, `${String(index).padStart(4, "0")}.mp3`);
      await extractAudioChunk(filePath, chunkPath, start, duration);
      return { chunkPath, start };
    });

    const transcripts = await mapWithConcurrency(chunkFiles, TRANSCRIPTION_CONCURRENCY, async ({ chunkPath, start }) => {
      const response = await retryTranscriptionChunk(chunkPath);
      return (response?.segments || []).map((segment) => ({
        start: Number(segment.start || 0) + start,
        end: Number(segment.end || 0) + start,
        text: String(segment.text || "").trim(),
      }));
    });

    const segments = transcripts
      .flat()
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
      .sort((a, b) => a.start - b.start);

    if (!segments.length) {
      throw new Error("Transcription completed but no speech segments were returned.");
    }

    return segments;
  } finally {
    await cleanupDirectory(chunkRoot);
  }
}

function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      if (!duration || Number.isNaN(duration)) {
        return reject(new Error("Unable to determine media duration."));
      }
      resolve(Math.max(0, Number(duration)));
    });
  });
}

function buildChunkRanges(duration, chunkSeconds) {
  const chunks = [];
  let start = 0;
  while (start < duration) {
    const remaining = duration - start;
    chunks.push({ start, duration: Math.min(chunkSeconds, remaining) });
    start += chunkSeconds;
  }
  return chunks;
}

function extractAudioChunk(videoPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .setStartTime(start)
      .duration(duration)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("libmp3lame")
      .audioBitrate(AUDIO_BITRATE)
      .format("mp3")
      .outputOptions([`-threads ${AUDIO_EXTRACTION_THREADS}`])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function retryTranscriptionChunk(audioPath) {
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

async function cleanupDirectory(directory) {
  if (!directory) return;
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[transcriber] failed to remove temp directory ${directory}: ${error.message}`);
  }
}
