import Groq from "groq-sdk";
import ffmpeg from "fluent-ffmpeg";
import os from "os";
import { mapWithConcurrency } from "../utils/concurrency.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
// NOTE: "llama-3.3-small" is not a real Groq model id and was causing every
// analysis call to fail whenever GROQ_ANALYSIS_MODEL wasn't explicitly set.
// Default to the same model documented in .env.example.
const ANALYSIS_MODEL = process.env.GROQ_ANALYSIS_MODEL || "llama-3.3-70b-versatile";

const MIN_CLIP_SECONDS = Number(process.env.MIN_CLIP_SECONDS || 15);
const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 60);
// Every job should produce at least 8 clips and, for longer source videos,
// as many as 30 — the analyzer scales the actual requested count between
// these two bounds based on the source video's duration (see
// analyzeBestMoments below), it never overshoots MAX_CLIPS_PER_JOB.
const MIN_CLIPS_PER_JOB = Number(process.env.MIN_CLIPS_PER_JOB || 8);
const MAX_CLIPS_PER_JOB = Number(process.env.MAX_CLIPS_PER_JOB || 30);
// Smaller chunks use fewer tokens per Groq request (roughly half of the
// old 18000-char default) and produce more, finer-grained chunks for a
// given transcript - both stretch a limited daily token budget (Groq's
// free tier is 100k tokens/day) further and give selectDistributedClips
// more distinct chunks to spread MAX_CLIPS_PER_JOB clips across.
const MAX_ANALYSIS_CHARS = Number(process.env.MAX_ANALYSIS_CHARS || 9000);
// Needs enough headroom to still hit MAX_CLIPS_PER_JOB even when a video's
// whole transcript fits in a single chunk (short/medium videos). Kept equal
// to MAX_CLIPS_PER_JOB so a single-chunk transcript is never the bottleneck.
const MAX_CANDIDATE_CLIPS_PER_CHUNK = Number(process.env.MAX_CANDIDATE_CLIPS_PER_CHUNK || 30);
const CHUNK_OVERLAP_LINES = Number(process.env.CHUNK_OVERLAP_LINES || 3);
const MAX_ANALYSIS_RETRIES = Math.max(1, Number(process.env.MAX_ANALYSIS_RETRIES || 2));
const ANALYSIS_RETRY_DELAY_MS = Number(process.env.ANALYSIS_RETRY_DELAY_MS || 2000);
// If Groq reports a rate-limit reset longer than this, it's almost always
// a daily/monthly token quota (not a transient per-minute limit) - waiting
// it out inline would block the job for potentially over an hour with no
// chance of success. Fail that chunk immediately with a clear error
// instead of silently burning the retry budget on a wait that can't work.
const ANALYSIS_MAX_AUTO_RETRY_WAIT_SECONDS = Number(process.env.ANALYSIS_MAX_AUTO_RETRY_WAIT_SECONDS || 30);
const ANALYSIS_MIN_INTERVAL_MS = Number(process.env.ANALYSIS_MIN_INTERVAL_MS || 8000);
// Transcript chunks are analyzed in parallel. Most jobs only produce a
// handful of chunks, so a default of 1 (the old behavior) meant every extra
// chunk added a full LLM round-trip *plus* an 8s artificial delay
// sequentially — by far the slowest part of the "analyzing" stage for
// longer videos. 4 concurrent requests stays comfortably under Groq's TPM
// limits for typical transcript chunk sizes while cutting that stage's
// time roughly 4x; lower this back to 1 if you're on a low-tier Groq key.
const ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY || 4));
// The LLM only ever sees text - it has no way to tell a flat, low-energy
// retelling from a genuinely excited, high-energy moment that reads the
// same on the page. Weighing each candidate's actual audio loudness in
// alongside the LLM's own rankScore grounds "best moments" in something
// the transcript can't capture: how the moment actually sounds. Kept as a
// minority weight (see blendScores below) since the LLM's read on content
// quality still matters more than raw volume.
const AUDIO_ENERGY_WEIGHT = Math.max(0, Math.min(1, Number(process.env.AUDIO_ENERGY_WEIGHT ?? 0.3)));
const AUDIO_ENERGY_CONCURRENCY = Math.max(1, Number(process.env.AUDIO_ENERGY_CONCURRENCY || Math.min(6, os.cpus().length)));

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
      current = current.slice(Math.max(0, current.length - CHUNK_OVERLAP_LINES));
      currentLength = current.reduce((sum, item) => sum + item.length + 1, 0);
      current.push(line);
      currentLength += lineLength;
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
- Identify the strongest standalone moments in this transcript chunk, and return up to ${maxClips} of them.
- If the chunk contains enough strong moments, return the full ${maxClips}.
- Each moment must make sense on its own without earlier context.
- start/end must be real timestamps drawn from the transcript, snapped to natural sentence boundaries.
- Write a short, punchy caption (under 80 characters) for each clip. Make the caption feel like a strong social hook for a short-form video, specific to this exact moment, and avoid vague copy like "Key moment" or "Watch this".
- Suggest 3-5 relevant hashtags per clip (no # symbol, just the words).
- Do not fabricate timestamps or text that isn't supported by the transcript.

Respond ONLY with JSON, no prose, in this exact shape:
{
  "clips": [
    { "start": 12.4, "end": 45.1, "caption": "...", "hashtags": ["...","..."], "rankScore": 0.95 }
  ]
}`;

  try {
    // The completion has to hold up to `maxClips` full clip objects
    // (start/end/caption/hashtags/rankScore) as JSON. A flat 600-token cap
    // only has room for ~4-6 of those - once the model hits it mid-list,
    // JSON mode makes it close the array early to stay valid rather than
    // return a truncated/invalid document, so a chunk silently comes back
    // with only a couple of clips even though it was asked for up to 30.
    // This is what produced the "only 2 clips" result: the token budget,
    // not the transcript or the prompt, was capping clip count. Scale the
    // budget with maxClips instead of using a fixed value.
    const maxTokensForChunk = Math.min(6000, 300 + maxClips * 110);

    const completion = await retryAnalysisRequest(() =>
      groq.chat.completions.create({
        model: ANALYSIS_MODEL,
        messages: [
          { role: "system", content: chunkPrompt },
          { role: "user", content: transcriptText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: maxTokensForChunk,
      })
    );

    const parsed = JSON.parse(completion.choices[0].message.content || "{}");
    return (Array.isArray(parsed.clips) ? parsed.clips : []).map((clip) => ({
      chunkIndex,
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
      const isRateLimit = message.includes("rate limit");

      if (isRateLimit) {
        const wait = parseRateLimitWaitSeconds(message);
        if (wait !== undefined && wait > ANALYSIS_MAX_AUTO_RETRY_WAIT_SECONDS) {
          throw Object.assign(
            new Error(
              `Groq's token quota for "${ANALYSIS_MODEL}" is exhausted (this is usually the free tier's ` +
                `100k-tokens/day cap). It resets in about ${formatDuration(wait)}. Try again after that, or ` +
                `upgrade your Groq plan at https://console.groq.com/settings/billing.`
            ),
            { isQuotaExhausted: true, cause: error }
          );
        }
      }

      if (attempt === MAX_ANALYSIS_RETRIES) break;
      if (isRateLimit) {
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

// Groq formats rate-limit reset times as compound durations - a bare
// "4.2s" for short per-minute limits, but "1h18m11.52s" style for the
// much longer waits that come with a daily/monthly quota. The previous
// version of this regex only matched the bare-seconds form, so any longer
// wait silently fell through to `undefined` and the caller defaulted to a
// pointless 2-second retry delay that could never succeed against an
// exhausted daily quota.
function parseRateLimitWaitSeconds(message) {
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Measures a candidate clip's average loudness (mean_volume in dB) by
 * running ffmpeg's `volumedetect` filter over just that time range, audio
 * only (`-vn`, no video decode) - this is cheap even on long source videos
 * since it only reads/decodes the seconds inside the clip, not the whole
 * file. Returns null instead of throwing if ffmpeg fails for any reason,
 * so a probe issue degrades to "no energy signal" for that clip rather
 * than failing the whole analysis stage.
 */
function measureClipLoudness(sourceFilePath, start, end) {
  return new Promise((resolve) => {
    let stderrOutput = "";
    ffmpeg(sourceFilePath)
      .inputOptions([`-ss ${Math.max(0, start)}`])
      .outputOptions([`-t ${Math.max(0.5, end - start)}`, "-vn", "-af", "volumedetect", "-f", "null"])
      .output(process.platform === "win32" ? "NUL" : "/dev/null")
      .on("stderr", (line) => {
        stderrOutput += `${line}\n`;
      })
      .on("end", () => resolve(parseMeanVolumeDb(stderrOutput)))
      .on("error", () => resolve(null))
      .run();
  });
}

function parseMeanVolumeDb(stderrOutput) {
  const match = stderrOutput.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return match ? Number(match[1]) : null;
}

// Typical spoken audio sits roughly between -35dB (quiet/background) and
// 0dB (loud/excited, close to clipping) after normalization - clamping and
// rescaling into that band turns the raw dB reading into a comparable 0-1
// score alongside the LLM's own 0-1 rankScore.
function normalizeLoudnessScore(meanVolumeDb) {
  if (meanVolumeDb === null || !Number.isFinite(meanVolumeDb)) return null;
  const MIN_DB = -35;
  const MAX_DB = 0;
  return Math.max(0, Math.min(1, (meanVolumeDb - MIN_DB) / (MAX_DB - MIN_DB)));
}

/**
 * Enriches candidate clips with an audio-energy signal and blends it into
 * each clip's rankScore, so selection weighs actual vocal energy alongside
 * the LLM's text-only read of the moment. Mutates and returns the same
 * array. If sourceFilePath isn't available (e.g. legacy callers), this is
 * a no-op - selection just falls back to the LLM's rankScore alone.
 */
async function applyAudioEnergyScores(candidateClips, sourceFilePath) {
  if (!sourceFilePath || !candidateClips.length) return candidateClips;

  await mapWithConcurrency(candidateClips, AUDIO_ENERGY_CONCURRENCY, async (clip) => {
    try {
      const meanVolumeDb = await measureClipLoudness(sourceFilePath, clip.start, clip.end);
      const energyScore = normalizeLoudnessScore(meanVolumeDb);
      const llmScore = Number.isFinite(clip.rankScore) ? clip.rankScore : 0.5;
      clip.energyScore = energyScore;
      clip.llmScore = llmScore;
      clip.rankScore =
        energyScore === null ? llmScore : llmScore * (1 - AUDIO_ENERGY_WEIGHT) + energyScore * AUDIO_ENERGY_WEIGHT;
    } catch {
      // Leave rankScore as the LLM's original value for this clip.
    }
  });

  return candidateClips;
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
      caption: String(clip.caption || ""),
      hashtags: Array.isArray(clip.hashtags) ? clip.hashtags : [],
      rankScore: Number.isFinite(clip.rankScore) ? clip.rankScore : 0.5,
      creditLine: `Original video by ${ownerCreditName}`,
    }));
}

export async function generateCaptionForClip(transcript, { start, end }) {
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
    throw new Error("No timestamped transcript is available for caption generation.");
  }

  const clipSegments = segments.filter(
    (segment) => segment.end >= start && segment.start <= end
  );
  const transcriptLines = buildTranscriptLines(
    clipSegments.length ? clipSegments : segments
  );
  const clipTranscript = transcriptLines.join("\n");

  const prompt = `You are an expert short-form video editor.
You are given a transcript excerpt for a short clip from a longer video.
The clip runs from ${start} to ${end} seconds.
Write a single, specific, social-media-ready caption for this clip.
Keep it under 80 characters, be urgent and compelling, and avoid vague phrases like \"Key moment\" or \"Watch this.\"
Also suggest 3-5 relevant hashtags (no # symbol) that help this clip perform on Shorts/Reels/TikTok.
Do not invent any details not supported by the transcript.

Respond ONLY with JSON in this exact shape:
{
  "caption": "...",
  "hashtags": ["...", "...", "..."]
}

Transcript:
${clipTranscript}`;

  const completion = await retryAnalysisRequest(() =>
    groq.chat.completions.create({
      model: ANALYSIS_MODEL,
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 180,
    })
  );

  const parsed = JSON.parse(completion.choices[0].message.content || "{}");
  return {
    caption: String(parsed.caption || "").trim(),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.map((hashtag) => String(hashtag).replace(/^#/, "").trim()).filter(Boolean)
      : [],
  };
}

/**
 * Given a timestamped transcript, asks an LLM to identify the strongest
 * standalone moments and produce a caption + hashtags for each.
 * Returns: [{ start, end, caption, hashtags: [...], rankScore }, ...]
 */
export async function analyzeBestMoments(transcript, { ownerCreditName, sourceFilePath }) {
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

  const possibleClipCount = Math.max(1, Math.floor(videoDuration / MIN_CLIP_SECONDS));
  const requestedClipCount = Math.min(
    MAX_CLIPS_PER_JOB,
    videoDuration >= MIN_CLIP_SECONDS * MIN_CLIPS_PER_JOB
      ? Math.max(MIN_CLIPS_PER_JOB, possibleClipCount)
      : possibleClipCount
  );

  const transcriptLines = buildTranscriptLines(segments);
  const fullTranscript = transcriptLines.join("\n");
  const transcriptChunks = fullTranscript.length <= MAX_ANALYSIS_CHARS ? [fullTranscript] : chunkTranscript(transcriptLines);

  // Tracks whether any chunk failed specifically because Groq's token quota
  // is exhausted (as opposed to a transient error) - see the check after
  // chunkResults below.
  let quotaExhaustedError = null;

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
        if (error?.isQuotaExhausted) quotaExhaustedError = error;
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
          if (error?.isQuotaExhausted) quotaExhaustedError = error;
          return [];
        }
      }
    );
  }
  const candidateClips = chunkResults.flat();

  // Ground the LLM's text-only rankScore in how each candidate actually
  // sounds before picking the final set - see applyAudioEnergyScores.
  await applyAudioEnergyScores(candidateClips, sourceFilePath);

  const rankedClips = normalizeClips(
    selectDistributedClips(candidateClips, requestedClipCount),
    ownerCreditName
  );

  // If a chunk hit an exhausted token quota AND that left us with fewer
  // clips than the job should have, surface the real reason as a failed
  // job instead of silently completing with a handful of clips and no
  // explanation - that's what produced a confusing "only 2 clips" result
  // with no visible error.
  if (quotaExhaustedError && rankedClips.length < MIN_CLIPS_PER_JOB) {
    throw quotaExhaustedError;
  }

  if (rankedClips.length) return rankedClips;

  return [
    {
      start: videoStart,
      end: Math.min(videoStart + MAX_CLIP_SECONDS, videoEnd),
      caption: "",
      hashtags: [],
      rankScore: 0.1,
      creditLine: `Original video by ${ownerCreditName}`,
    },
  ];
}

function selectDistributedClips(clips, requestedClipCount) {
  const clipsByChunk = new Map();
  for (const clip of clips) {
    if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end)) continue;
    if (!clipsByChunk.has(clip.chunkIndex)) clipsByChunk.set(clip.chunkIndex, []);
    clipsByChunk.get(clip.chunkIndex).push(clip);
  }

  for (const chunkClips of clipsByChunk.values()) {
    chunkClips.sort((a, b) => b.rankScore - a.rankScore);
  }

  const chunkIndices = [...clipsByChunk.keys()].sort((a, b) => a - b);
  const selected = [];
  const usedRanges = [];
  const maxPerChunk = Math.max(1, Math.ceil(requestedClipCount / Math.max(1, chunkIndices.length)));

  for (let pass = 0; pass < maxPerChunk && selected.length < requestedClipCount; pass += 1) {
    for (const chunkIndex of chunkIndices) {
      if (selected.length >= requestedClipCount) break;
      const chunkClips = clipsByChunk.get(chunkIndex) || [];
      const candidate = chunkClips[pass];
      if (!candidate) continue;
      if (usedRanges.some((range) => isClipOverlap(range, candidate))) continue;
      selected.push(candidate);
      usedRanges.push({ start: candidate.start, end: candidate.end });
    }
  }

  if (selected.length < requestedClipCount) {
    const filler = clips
      .slice()
      .sort((a, b) => b.rankScore - a.rankScore)
      .filter((clip) => !selected.includes(clip))
      .filter((clip) => !usedRanges.some((range) => isClipOverlap(range, clip)));
    for (const clip of filler) {
      if (selected.length >= requestedClipCount) break;
      selected.push(clip);
      usedRanges.push({ start: clip.start, end: clip.end });
    }
  }

  return selected.slice(0, requestedClipCount);
}

function isClipOverlap(existing, clip) {
  const overlapStart = Math.max(existing.start, clip.start);
  const overlapEnd = Math.min(existing.end, clip.end);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  const minDuration = Math.min(existing.end - existing.start, clip.end - clip.start);
  const minimumOverlap = Math.max(5, minDuration * 0.35);

  return (
    overlap >= minimumOverlap ||
    Math.abs(existing.start - clip.start) <= 5 ||
    Math.abs(existing.end - clip.end) <= 5
  );
}