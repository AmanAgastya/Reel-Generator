import Groq from "groq-sdk";

// Supports multiple Groq API keys so work (transcription chunks, analysis
// chunks) can be spread across them. Each Groq key has its own separate
// rate limit / daily token quota, so splitting the chunk list across N
// keys roughly multiplies the effective throughput and daily quota by N
// instead of every request competing for one key's budget.
//
// Configure with a comma-separated GROQ_API_KEYS env var:
//   GROQ_API_KEYS=gsk_key_one,gsk_key_two,gsk_key_three
// If GROQ_API_KEYS isn't set, this falls back to the single GROQ_API_KEY
// var, so existing single-key setups keep working with no changes.
const rawKeys = process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || "";
const keys = rawKeys
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

if (!keys.length) {
  console.warn(
    "[groqKeyPool] No Groq API key configured. Set GROQ_API_KEY (single key) or " +
      "GROQ_API_KEYS (comma-separated, for multiple keys) in your .env."
  );
} else {
  console.log(
    `[groqKeyPool] ${keys.length} Groq API key${keys.length > 1 ? "s" : ""} configured` +
      (keys.length > 1 ? " - work will be split across them." : ".")
  );
}

const clients = keys.map((apiKey) => new Groq({ apiKey }));

let roundRobinCounter = 0;

// Turns a chunk index into a stable number even when it's a string (the
// transcriber sometimes builds string indices like "0120-a" when a chunk
// gets split further after a size error) so the same logical chunk always
// lands on the same key on retry.
function toStableIndex(index) {
  if (typeof index === "number" && Number.isFinite(index)) return index;
  const str = String(index ?? "");
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Returns a Groq client to use for a given piece of work.
 *
 * Pass the chunk/job index when one is available (e.g. the transcript
 * chunk number, the analysis chunk number) so related work is spread
 * deterministically across keys - with 2 keys, even-numbered chunks
 * always use key A and odd-numbered chunks always use key B, splitting
 * the work list ~evenly between them. Call with no argument for one-off
 * calls (not part of a chunk list) to fall back to simple round-robin.
 */
export function getGroqClient(index) {
  if (!clients.length) {
    throw new Error(
      "No Groq API key configured. Set GROQ_API_KEY (single key) or GROQ_API_KEYS " +
        "(comma-separated, for multiple keys) in your .env."
    );
  }
  if (clients.length === 1) return clients[0];

  const i = index === undefined ? roundRobinCounter++ : toStableIndex(index);
  return clients[i % clients.length];
}

export function getGroqKeyCount() {
  return clients.length;
}