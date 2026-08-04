import Groq from "groq-sdk";
import { mapWithConcurrency } from "../utils/concurrency.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ANALYSIS_MODEL = process.env.GROQ_ANALYSIS_MODEL || "llama-3.3-small";

const MIN_CLIP_SECONDS = Number(process.env.MIN_CLIP_SECONDS || 15);
const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 60);
const MAX_CLIPS_PER_JOB = Number(process.env.MAX_CLIPS_PER_JOB || 4);
const MAX_ANALYSIS_CHARS = Number(process.env.MAX_ANALYSIS_CHARS || 48000);
const MAX_CANDIDATE_CLIPS_PER_CHUNK = Number(process.env.MAX_CANDIDATE_CLIPS_PER_CHUNK || 1);
const MAX_ANALYSIS_RETRIES = Math.max(1, Number(process.env.MAX_ANALYSIS_RETRIES || 2));
const ANALYSIS_RETRY_DELAY_MS = Number(process.env.ANALYSIS_RETRY_DELAY_MS || 2000);
const ANALYSIS_MIN_INTERVAL_MS = Number(process.env.ANALYSIS_MIN_INTERVAL_MS || 8000);
// Transcript chunks are analyzed conservatively to stay under Groq TPM limits.
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY || 1));

function buildTranscriptLines(segments) {
  return segments.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
}

function chunkTranscript(lines) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const lineLength = line.length + 1;
    if (currentLength + lineLength > MAX_ANALYSIS_CHARS && current.length) {
      chunks.push(current.join("\n"));
      current = [line];
      currentLength = lineLength;
    } else {
      current.push(line);
      currentLength += lineLength;
    }
  }

  if (current.length) {
    chunks.push(current.join("\n"));
  }

  return chunks;
}

async function analyzeTranscriptChunk(transcriptText, chunkIndex, maxClips) {
  const chunkPrompt = `You are an expert short-form video editor. You are given a
timestamped transcript chunk from a longer video. Identify the strongest,
self-contained moments that would work as standalone short clips (${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS} seconds each).

Rules:
- Pick up to ${maxClips} moments, ranked best first. Return at least one if the transcript chunk contains a suitable moment.
- Each moment must make sense on its own without earlier context.
- start/end must be real timestamps drawn from the transcript, snapped to natural sentence boundaries.
- Write a short, punchy caption (under 100 characters) for each clip.
- Suggest 3-5 relevant hashtags per clip (no # symbol, just the words).
- Do not fabricate timestamps or text that isn't supported by the transcript.

Respond ONLY with JSON, no prose, in this exact shape:
{
  "clips": [
    { "start": 12.4, "end": 45.1, "caption": "...", "hashtags": ["...","..."], "rankScore": 0.95 }
  ]
}`;

  try {
    const completion = await retryAnalysisRequest(() =>
      groq.chat.completions.create({
        model: ANALYSIS_MODEL,
        messages: [
          { role: "system", content: chunkPrompt },
          { role: "user", content: transcriptText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_output_tokens: 600,
      })
    );

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    return (Array.isArray(parsed.clips) ? parsed.clips : []).map((clip) => ({
      start: Number(clip.start),
      end: Number(clip.end),
      caption: String(clip.caption || "").trim(),
      hashtags: Array.isArray(clip.hashtags)
        ? clip.hashtags.map((hashtag) => String(hashtag).replace(/^#/, "").trim()).filter(Boolean)
        : [],
      rankScore: Number(clip.rankScore),
    }));
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const isSizeError = message.includes("request too large") || message.includes("413");

    if (isSizeError && transcriptText.length > 1000) {
      const splitPoint = Math.max(transcriptText.lastIndexOf("\n", transcriptText.length / 2), transcriptText.length / 4);
      const left = transcriptText.slice(0, splitPoint);
      const right = transcriptText.slice(splitPoint);
      const [leftClips, rightClips] = await Promise.all([
        analyzeTranscriptChunk(left, chunkIndex, maxClips),
        analyzeTranscriptChunk(right, chunkIndex + 1, maxClips),
      ]);
      return [...leftClips, ...rightClips].slice(0, maxClips);
    }

    throw error;
  }
}

async function retryAnalysisRequest(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ANALYSIS_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "").toLowerCase();
      if (attempt === MAX_ANALYSIS_RETRIES) break;
      if (message.includes("rate limit")) {
        const wait = parseRateLimitWaitSeconds(message) || ANALYSIS_RETRY_DELAY_MS / 1000;
        console.warn(`[analyzer] rate limit hit, waiting ${wait}s before retrying...`);
        await delay(wait * 1000);
      } else {
        console.warn(`[analyzer] analysis attempt ${attempt} failed: ${error.message}. Retrying...`);
        await delay(ANALYSIS_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function parseRateLimitWaitSeconds(message) {
  const match = message.match(/please try again in (\d+(?:\.\d+)?)s/i);
  return match ? Number(match[1]) : undefined;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeClips(clips, ownerCreditName) {
  return clips
    .filter(
      (clip) =>
        Number.isFinite(clip.start) &&
        Number.isFinite(clip.end) &&
        clip.end > clip.start &&
        clip.end - clip.start >= MIN_CLIP_SECONDS - 2
    )
    .slice(0, MAX_CLIPS_PER_JOB)
    .map((clip) => ({
      ...clip,
      caption: clip.caption || "Key moment from this video",
      hashtags: Array.isArray(clip.hashtags) ? clip.hashtags : [],
      rankScore: Number.isFinite(clip.rankScore) ? clip.rankScore : 0.5,
      creditLine: `Original video by ${ownerCreditName}`,
    }));
}

/**
 * Given a timestamped transcript, asks an LLM to identify the strongest
 * standalone moments and produce a caption + hashtags for each.
 * Returns: [{ start, end, caption, hashtags: [...], rankScore }, ...]
 */
export async function analyzeBestMoments(transcript, { ownerCreditName }) {
  const segments = transcript
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text || "").trim(),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.start &&
        segment.text
    );

  if (!segments.length) {
    throw new Error("No timestamped speech was detected in this video. Upload a video with audible speech.");
  }

  const videoStart = segments[0].start;
  const videoEnd = Math.max(...segments.map((segment) => segment.end));
  const videoDuration = videoEnd - videoStart;
  if (videoDuration < MIN_CLIP_SECONDS) {
    throw new Error(`Video is too short to create a ${MIN_CLIP_SECONDS}-second clip.`);
  }

  const requestedClipCount = Math.min(
    MAX_CLIPS_PER_JOB,
    Math.max(1, Math.floor(videoDuration / MIN_CLIP_SECONDS))
  );

  const transcriptLines = buildTranscriptLines(segments);
  const fullTranscript = transcriptLines.join("\n");
  const transcriptChunks = fullTranscript.length <= MAX_ANALYSIS_CHARS ? [fullTranscript] : chunkTranscript(transcriptLines);

  // Chunks are analyzed concurrently (was: sequential await in a for loop,
  // which meant a 4-chunk transcript took 4x as long as it needed to).
  let chunkResults;
  if (ANALYSIS_CONCURRENCY === 1) {
    chunkResults = [];
    for (let chunkIndex = 0; chunkIndex < transcriptChunks.length; chunkIndex += 1) {
      try {
        const chunkClips = await analyzeTranscriptChunk(
          transcriptChunks[chunkIndex],
          chunkIndex,
          MAX_CANDIDATE_CLIPS_PER_CHUNK
        );
        chunkResults.push(chunkClips.slice(0, MAX_CANDIDATE_CLIPS_PER_CHUNK));
      } catch (error) {
        console.error("[analyzer] chunk analysis failed:", error);
        chunkResults.push([]);
      }
      if (chunkIndex < transcriptChunks.length - 1) {
        await delay(ANALYSIS_MIN_INTERVAL_MS);
      }
    }
  } else {
    chunkResults = await mapWithConcurrency(
      transcriptChunks,
      ANALYSIS_CONCURRENCY,
      async (chunkText, chunkIndex) => {
        try {
          const chunkClips = await analyzeTranscriptChunk(chunkText, chunkIndex, MAX_CANDIDATE_CLIPS_PER_CHUNK);
          return chunkClips.slice(0, MAX_CANDIDATE_CLIPS_PER_CHUNK);
        } catch (error) {
          console.error("[analyzer] chunk analysis failed:", error);
          return [];
        }
      }
    );
  }
  const candidateClips = chunkResults.flat();

  const rankedClips = normalizeClips(
    candidateClips.sort((a, b) => b.rankScore - a.rankScore).slice(0, requestedClipCount),
    ownerCreditName
  );

  if (rankedClips.length) return rankedClips;

  return [
    {
      start: videoStart,
      end: Math.min(videoStart + MAX_CLIP_SECONDS, videoEnd),
      caption: "Key moment from this video",
      hashtags: [],
      rankScore: 0.1,
      creditLine: `Original video by ${ownerCreditName}`,
    },
  ];
}