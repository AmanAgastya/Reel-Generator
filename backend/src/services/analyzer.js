import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ANALYSIS_MODEL = process.env.GROQ_ANALYSIS_MODEL || "llama-3.3-70b-versatile";

const MIN_CLIP_SECONDS = Number(process.env.MIN_CLIP_SECONDS || 15);
const MAX_CLIP_SECONDS = Number(process.env.MAX_CLIP_SECONDS || 60);
const MAX_CLIPS_PER_JOB = Number(process.env.MAX_CLIPS_PER_JOB || 20);

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
  const transcriptText = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const systemPrompt = `You are an expert short-form video editor. You are given a
timestamped transcript of a single long-form video. Identify the strongest,
self-contained moments that would work as standalone short clips (${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS} seconds each).

Rules:
- Pick up to ${requestedClipCount} moments, ranked best first. Return at least
  one if the transcript contains a suitable moment.
- Each moment must make sense on its own without earlier context.
- start/end must be real timestamps drawn from the transcript, snapped to
  natural sentence boundaries.
- Write a short, punchy caption (under 100 characters) for each clip.
- Suggest 3-5 relevant hashtags per clip (no # symbol, just the words).
- Do not fabricate timestamps or text that isn't supported by the transcript.

Respond ONLY with JSON, no prose, in this exact shape:
{
  "clips": [
    { "start": 12.4, "end": 45.1, "caption": "...", "hashtags": ["...","..."], "rankScore": 0.95 }
  ]
}`;

  const completion = await groq.chat.completions.create({
    model: ANALYSIS_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: transcriptText },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const clips = (Array.isArray(parsed.clips) ? parsed.clips : [])
    .map((clip) => ({
      start: Number(clip.start),
      end: Number(clip.end),
      caption: String(clip.caption || "").trim(),
      hashtags: Array.isArray(clip.hashtags)
        ? clip.hashtags.map((hashtag) => String(hashtag).replace(/^#/, "").trim()).filter(Boolean)
        : [],
      rankScore: Number(clip.rankScore),
    }))
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
      rankScore: Number.isFinite(clip.rankScore) ? clip.rankScore : 0.5,
      creditLine: `Original video by ${ownerCreditName}`,
    }));

  if (clips.length) return clips;

  // Models occasionally return an empty list for a valid short transcript.
  // Keep the pipeline useful by cutting one bounded, timestamped moment rather
  // than marking the job completed with no clips.
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
