import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import ffmpeg from "fluent-ffmpeg";
import { getGroqClient, getGroqKeyCount } from "../utils/groqKeyPool.js";

// NOTE: "whisper-small" is not a valid Groq model id and was causing every
// transcription call to fail whenever GROQ_WHISPER_MODEL wasn't explicitly
// set. Default to the same model documented in .env.example.
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || "whisper-large-v3";
const TRANSCRIPTION_FULL_DURATION_LIMIT_SECONDS = Math.max(60, Number(process.env.TRANSCRIPTION_FULL_DURATION_LIMIT_SECONDS || 1200));
const TRANSCRIPTION_FULL_FILE_SIZE_LIMIT_BYTES = Math.max(1, Number(process.env.TRANSCRIPTION_FULL_FILE_SIZE_LIMIT_BYTES || 25 * 1024 * 1024));
const TRANSCRIPTION_CHUNK_SECONDS = Math.max(300, Number(process.env.TRANSCRIPTION_CHUNK_SECONDS || 600));
const TRANSCRIPTION_MIN_CHUNK_SECONDS = Math.max(180, Number(process.env.TRANSCRIPTION_MIN_CHUNK_SECONDS || 300));
// More, smaller chunks transcribed in parallel finish faster than a couple
// of huge ones — Groq's Whisper endpoint is network/API-bound, not local
// CPU-bound, so there's little cost to fanning a long video out into more
// concurrent requests.
// 30min-2hr source videos need more than a couple of chunks to stay under
// TRANSCRIPTION_CHUNK_SECONDS per request; 10 keeps chunk sizes reasonable
// across that whole range while staying well within Groq's rate limits at
// TRANSCRIPTION_CONCURRENCY=4.
const MAX_TRANSCRIPTION_CHUNKS = Math.max(1, Number(process.env.MAX_TRANSCRIPTION_CHUNKS || 10));
// Capped at the configured key count for the same reason as analyzer.js's
// ANALYSIS_CONCURRENCY: extra "concurrent" chunks beyond one per key just
// pile onto a key that's already being paced below and add nothing but
// rate-limit risk.
const TRANSCRIPTION_CONCURRENCY = Math.min(
  Math.max(1, Number(process.env.TRANSCRIPTION_CONCURRENCY || 4)),
  Math.max(1, getGroqKeyCount())
);
// Transcription and analysis draw from the same GROQ_API_KEYS pool, so a
// burst of transcription requests can crowd out the token/rate budget
// analysis needs on the same key right after. Whisper transcription is
// billed by audio-seconds rather than prompt tokens, so it can tolerate a
// shorter gap than analysis's 8s default - this just needs to be enough to
// smooth out bursts, not eliminate them.
const TRANSCRIPTION_MIN_INTERVAL_MS = Number(process.env.TRANSCRIPTION_MIN_INTERVAL_MS || 3000);
// Was defaulting to 1, which made this loop's "retry" a no-op: with
// `for (attempt = 1; attempt <= 1; ...)` it runs exactly once and exits, so
// a one-off transient blip - like Groq occasionally returning a bare
// `500 Internal Server Error` with no other detail, which normally just
// needs a second attempt to go through - failed the whole job immediately
// instead of ever getting retried. Matches MAX_ANALYSIS_RETRIES' default
// of 2 in analyzer.js, which has the identical retry-loop shape.
const MAX_TRANSCRIPTION_RETRIES = Math.max(1, Number(process.env.MAX_TRANSCRIPTION_RETRIES || 3));
const TRANSCRIPTION_RETRY_DELAY_MS = Number(process.env.TRANSCRIPTION_RETRY_DELAY_MS || 3000);
const TRANSCRIPTION_MAX_AUTO_RETRY_WAIT_SECONDS = Number(
  process.env.TRANSCRIPTION_MAX_AUTO_RETRY_WAIT_SECONDS || 30
);
const AUDIO_EXTRACTION_THREADS = Math.max(1, Number(process.env.AUDIO_EXTRACTION_THREADS || 1));
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || "16k";
// At 16kbps mono, even a couple of real seconds of audio is a few KB - an
// output this small is effectively guaranteed to be an empty/near-empty
// extraction, not genuine content, so it's not worth spending a Groq
// Whisper call on. See extractAudioChunk.
const MIN_VALID_AUDIO_CHUNK_BYTES = Math.max(256, Number(process.env.MIN_VALID_AUDIO_CHUNK_BYTES || 2048));

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
  return await transcribeSegmentWithFallback(videoPath, chunkRoot, start, duration, chunkPath, index);
}

async function transcribeSegmentWithFallback(videoPath, chunkRoot, start, duration, audioPath, index) {
  try {
    // Extraction lives inside this try (rather than being awaited by the
    // caller beforehand) so a failure here - including the empty-output
    // case handled in extractAudioChunk - gets the exact same per-chunk
    // tolerance as a Whisper API failure below, instead of bypassing it
    // and taking the whole job down.
    await extractAudioChunk(videoPath, audioPath, start, duration);
    // Each chunk is assigned to a Groq client by its chunk index (see
    // getGroqClient) - with multiple GROQ_API_KEYS configured, this is
    // what actually splits transcription work across keys instead of
    // every chunk competing for one key's rate limit/quota.
    const response = await retryTranscriptionChunk(audioPath, index);
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
    // A chunk that still fails after retryTranscriptionChunk's retries
    // used to take the whole job down with it - one bad ~10min stretch
    // (a Groq blip that outlasted the retry window, a chunk landing past
    // the video's real playable end, or a chunk hitting a moment of
    // near-silence the API chokes on) meant the user got "Something went
    // wrong" with nothing to show, even though every other chunk
    // transcribed fine. analyzeBestMoments already tolerates a single
    // failed analysis chunk the same way - skip it, keep going, and only
    // fail the whole job at the top level if EVERY chunk came back empty
    // (see the `!segments.length` check in transcribeVideo). A genuine
    // account-level failure (isQuotaExhausted - the whole key pool has no
    // tokens/audio-seconds left) is excluded from this: every other chunk
    // would fail identically anyway, so surfacing that clearly and failing
    // fast is more honest than silently returning a transcript with gaps.
    if (error?.isEmptyAudioChunk || (!error?.isQuotaExhausted && isRecoverableTranscriptionError(error))) {
      console.warn(
        `[transcriber] chunk ${index} (${start}s-${Math.round(start + duration)}s) still failed after retries and will be skipped: ${error.message}`
      );
      return [];
    }
    throw error;
  }
}

async function transcribeFullAudio(audioPath, offset) {
  const response = await retryTranscriptionChunk(audioPath, 0);
  return parseTranscriptionResponse(response, offset);
}

// Whisper's verbose_json segments carry a `no_speech_prob` field (Groq's
// output matches OpenAI's Whisper format) - the model's own confidence that
// a stretch of audio isn't speech at all (silence, room tone, pure music).
// This was previously discarded, so dead air/noise segments could still
// reach the analyzer and occasionally get treated as a "moment" worth
// clipping. Filtering them out here means the analyzer only ever sees
// segments Whisper itself is confident contain actual speech.
const NO_SPEECH_PROB_THRESHOLD = Number(process.env.NO_SPEECH_PROB_THRESHOLD || 0.6);

function parseTranscriptionResponse(response, offset) {
  return (response?.segments || [])
    .filter((segment) => Number(segment.no_speech_prob ?? 0) < NO_SPEECH_PROB_THRESHOLD)
    .map((segment) => ({
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
  // BUGFIX: this previously took Math.min(chunkSeconds, ceil(duration/maxChunks)),
  // which is backwards — for a long video where duration/maxChunks exceeds
  // chunkSeconds, that picked the *smaller* number and silently produced
  // more chunks than maxChunks allowed (e.g. a 2-hour video capped at 6
  // chunks actually produced 12). Using Math.max ensures the chunk size
  // only grows (never shrinks) to keep the chunk count at or under
  // maxChunks, while never going below the configured chunkSeconds.
  const effectiveChunkSeconds = Math.max(chunkSeconds, Math.max(1, Math.ceil(duration / maxChunks)));
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
      .on("end", async () => {
        // ffmpeg can report "end" (exit 0-ish / no "error" event) while
        // having encoded literally nothing - "Output file is empty,
        // nothing was encoded (check -ss / -t / -frames parameters if
        // used)". That happens when `start` (-ss) lands at or past the
        // source file's actual playable end: the requested chunk range was
        // built off the video's reported duration, but a download that's
        // truncated, or a container whose metadata overstates its real
        // length, can leave the tail past that point with no real frames
        // to extract. Uploading a 0-byte "audio" file to Groq's Whisper
        // endpoint next produces a bare, confusing `500 Internal Server
        // Error` with no indication anything was wrong with the input -
        // catching the empty file here, before it ever reaches Groq, turns
        // that into a clear, specific, and (per transcribeSegmentWithFallback)
        // safely skippable error instead.
        try {
          const stats = await fs.promises.stat(outputPath);
          if (stats.size < MIN_VALID_AUDIO_CHUNK_BYTES) {
            const error = new Error(
              `Extracted audio chunk is empty (${stats.size} bytes) - the source video may not extend this far, or has no audio in this range.`
            );
            error.isEmptyAudioChunk = true;
            reject(error);
            return;
          }
        } catch (statError) {
          reject(statError);
          return;
        }
        resolve();
      })
      .on("error", reject)
      .save(outputPath);
  });
}

async function retryTranscriptionChunk(audioPath, index) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRANSCRIPTION_RETRIES; attempt += 1) {
    try {
      const groqClient = await getGroqClient(index, TRANSCRIPTION_MIN_INTERVAL_MS);
      return await groqClient.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: WHISPER_MODEL,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "").toLowerCase();
      const isRateLimit = message.includes("rate limit");

      if (isRateLimit) {
        const wait = parseRateLimitWaitSeconds(message);
        // A multi-minute+ wait almost always means a daily/plan quota, not
        // a transient per-minute limit - fail fast instead of blocking the
        // job for a long time on a retry that can't possibly succeed yet.
        if (wait !== undefined && wait > TRANSCRIPTION_MAX_AUTO_RETRY_WAIT_SECONDS) {
          throw Object.assign(
            new Error(
              `Groq's quota for "${WHISPER_MODEL}" transcription is exhausted. It resets in about ` +
                `${formatDuration(wait)}. Try again after that, or upgrade your Groq plan at ` +
                `https://console.groq.com/settings/billing.`
            ),
            { isQuotaExhausted: true, cause: error }
          );
        }
      }

      if (attempt === MAX_TRANSCRIPTION_RETRIES) break;
      if (isRateLimit) {
        const wait = parseRateLimitWaitSeconds(message) || TRANSCRIPTION_RETRY_DELAY_MS / 1000;
        console.warn(`[transcriber] rate limit hit, waiting ${wait}s before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      } else {
        // Fixed 3s between attempts wasn't giving these enough room:
        // observed logs show the SAME chunk indices of the SAME video
        // failing identically across entirely separate job runs minutes
        // apart, which isn't what pure random network flakiness looks
        // like - it's consistent with Groq's backend having a harder time
        // with that specific audio content (long non-speech/musical
        // stretches, in this app's case) and needing more than a few
        // seconds before a retry has a real chance of landing differently.
        // Backing off exponentially (3s, 9s, 27s, ...) gives later
        // attempts meaningfully more separation without punishing the
        // common case where attempt 2 succeeds quickly anyway.
        const backoffMs = TRANSCRIPTION_RETRY_DELAY_MS * 3 ** (attempt - 1);
        console.warn(`[transcriber] transcription attempt ${attempt} failed: ${error.message}. Retrying in ${Math.round(backoffMs / 1000)}s...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError;
}

function parseRateLimitWaitSeconds(message) {
  // See the matching comment in analyzer.js: Groq formats longer waits
  // (daily/plan quota resets) as compound durations like "1h18m11.52s",
  // not the bare-seconds form the old regex here only handled.
  const match = message.match(/please try again in ((?:\d+h)?(?:\d+m(?!s))?(?:\d+(?:\.\d+)?s)?)/i);
  if (!match || !match[1]) return undefined;
  const duration = match[1];
  const hours = Number(duration.match(/(\d+)h/)?.[1] || 0);
  const minutes = Number(duration.match(/(\d+)m(?!s)/)?.[1] || 0);
  const seconds = Number(duration.match(/(\d+(?:\.\d+)?)s/)?.[1] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : undefined;
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || !parts.length) parts.push(`${seconds}s`);
  return parts.join(" ");
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
