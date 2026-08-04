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
  const transcriptText = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n");

  const systemPrompt = `You are an expert short-form video editor. You are given a
timestamped transcript of a single long-form video. Identify the strongest,
self-contained moments that would work as standalone short clips (${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS} seconds each).

Rules:
- Pick between 10 and ${MAX_CLIPS_PER_JOB} moments, ranked best first.
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
  const clips = (parsed.clips || [])
    .filter((c) => c.end > c.start && c.end - c.start >= MIN_CLIP_SECONDS - 2)
    .slice(0, MAX_CLIPS_PER_JOB)
    .map((c) => ({
      ...c,
      creditLine: `Original video by ${ownerCreditName}`,
    }));

  return clips;
}
