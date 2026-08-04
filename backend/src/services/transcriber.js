import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-small";
const TRANSCRIPTION_FULL_DURATION_LIMIT_SECONDS = Math.max(60, Number(process.env.TRANSCRIPTION_FULL_DURATION_LIMIT_SECONDS || 1200));
const TRANSCRIPTION_FULL_FILE_SIZE_LIMIT_BYTES = Math.max(1, Number(process.env.TRANSCRIPTION_FULL_FILE_SIZE_LIMIT_BYTES || 25 * 1024 * 1024));
const TRANSCRIPTION_CHUNK_SECONDS = Math.max(600, Number(process.env.TRANSCRIPTION_CHUNK_SECONDS || 1200));
const TRANSCRIPTION_MIN_CHUNK_SECONDS = Math.max(300, Number(process.env.TRANSCRIPTION_MIN_CHUNK_SECONDS || 600));
const MAX_TRANSCRIPTION_CHUNKS = Math.max(1, Number(process.env.MAX_TRANSCRIPTION_CHUNKS || 2));
const TRANSCRIPTION_CONCURRENCY = Math.max(1, Number(process.env.TRANSCRIPTION_CONCURRENCY || 1));
const MAX_TRANSCRIPTION_RETRIES = Math.max(1, Number(process.env.MAX_TRANSCRIPTION_RETRIES || 1));
const TRANSCRIPTION_RETRY_DELAY_MS = Number(process.env.TRANSCRIPTION_RETRY_DELAY_MS || 3000);
const AUDIO_EXTRACTION_THREADS = Math.max(1, Number(process.env.AUDIO_EXTRACTION_THREADS || 1));
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || "16k";

/**
 * Transcribes a video/audio file using Groq's hosted Whisper and returns
 * timestamped segments.
 * Returns: [{ start, end, text }, ...]
 */
export async function transcribeVideo(filePath, onProgress = async () => {}) {
  const progressCallback = typeof onProgress === "function" ? onProgress : async () => {};
  const chunkRoot = path.join(path.dirname(filePath), `${uuid()}-chunks`);
  await fs.promises.mkdir(chunkRoot, { recursive: true });
  await progressCallback(0);

  const duration = await getMediaDuration(filePath);

  if (duration <= TRANSCRIPTION_FULL_DURATION_LIMIT_SECONDS) {
    const fullAudioPath = path.join(chunkRoot, "full.mp3");
    await extractAudioChunk(filePath, fullAudioPath, 0, duration);
    const stats = await fs.promises.stat(fullAudioPath);
    if (stats.size <= TRANSCRIPTION_FULL_FILE_SIZE_LIMIT_BYTES) {
      try {
        const result = await transcribeFullAudio(fullAudioPath, 0);
        await progressCallback(100);
        return result;
      } catch (error) {
        if (!isRecoverableTranscriptionError(error)) throw error;
        console.warn("[transcriber] full audio transcription failed, falling back to chunked transcription.");
      }
    }
  }

  const chunks = buildChunkRanges(duration, TRANSCRIPTION_CHUNK_SECONDS, MAX_TRANSCRIPTION_CHUNKS);

  try {
    const transcripts = await mapWithConcurrencySafe(chunks, TRANSCRIPTION_CONCURRENCY, async ({ start, duration }, index) => {
      const result = await transcribeVideoRange(filePath, chunkRoot, start, duration, index);
      await progressCallback(Math.round(((index + 1) / chunks.length) * 100));
      return result;
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

async function transcribeVideoRange(videoPath, chunkRoot, start, duration, index) {
  const chunkPath = path.join(chunkRoot, `${String(index).padStart(4, "0")}.mp3`);
  await extractAudioChunk(videoPath, chunkPath, start, duration);
  return await transcribeSegmentWithFallback(videoPath, chunkRoot, start, duration, chunkPath);
}

async function transcribeSegmentWithFallback(videoPath, chunkRoot, start, duration, audioPath) {
  try {
    const response = await retryTranscriptionChunk(audioPath);
    return parseTranscriptionResponse(response, start);
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const isSizeError = message.includes("request entity too large") || message.includes("413");
    if (duration > TRANSCRIPTION_MIN_CHUNK_SECONDS && isSizeError) {
      const half = Math.max(TRANSCRIPTION_MIN_CHUNK_SECONDS, Math.floor(duration / 2));
      const left = await transcribeVideoRange(videoPath, chunkRoot, start, half, `${String(start).padStart(4, "0")}-a`);
      const right = await transcribeVideoRange(videoPath, chunkRoot, start + half, duration - half, `${String(start + half).padStart(4, "0")}-b`);
      return [...left, ...right];
    }
    throw error;
  }
}

async function transcribeFullAudio(audioPath, offset) {
  const response = await retryTranscriptionChunk(audioPath);
  return parseTranscriptionResponse(response, offset);
}

function parseTranscriptionResponse(response, offset) {
  return (response?.segments || []).map((segment) => ({
    start: Number(segment.start || 0) + offset,
    end: Number(segment.end || 0) + offset,
    text: String(segment.text || "").trim(),
  }));
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

function buildChunkRanges(duration, chunkSeconds, maxChunks = MAX_TRANSCRIPTION_CHUNKS) {
  const effectiveChunkSeconds = Math.min(chunkSeconds, Math.max(1, Math.ceil(duration / maxChunks)));
  const chunks = [];
  let start = 0;
  while (start < duration) {
    const remaining = duration - start;
    chunks.push({ start, duration: Math.min(effectiveChunkSeconds, remaining) });
    start += effectiveChunkSeconds;
  }
  return chunks;
}

async function mapWithConcurrencySafe(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = error;
      }
    }
  });

  await Promise.all(workers);

  const firstError = results.find((result) => result instanceof Error);
  if (firstError) {
    throw firstError;
  }

  return results;
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
      const message = String(error?.message || "").toLowerCase();
      if (attempt === MAX_TRANSCRIPTION_RETRIES) break;
      if (message.includes("rate limit")) {
        const wait = parseRateLimitWaitSeconds(message) || TRANSCRIPTION_RETRY_DELAY_MS / 1000;
        console.warn(`[transcriber] rate limit hit, waiting ${wait}s before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      } else {
        console.warn(`[transcriber] transcription attempt ${attempt} failed: ${error.message}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, TRANSCRIPTION_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

function parseRateLimitWaitSeconds(message) {
  const match = message.match(/please try again in (\d+(?:\.\d+)?)s/i);
  return match ? Number(match[1]) : undefined;
}

function isRecoverableTranscriptionError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("internal server error") ||
    message.includes("request entity too large") ||
    message.includes("timeout") ||
    message.includes("413")
  );
}

async function cleanupDirectory(directory) {
  if (!directory) return;
  try {
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[transcriber] failed to remove temp directory ${directory}: ${error.message}`);
  }
}
