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

// Per-key pacing gate. Each key gets its own promise chain that tracks
// "when did the last request on this key fire" - concurrent callers that
// land on the same key queue up on this chain instead of each reading a
// stale "last request time" and firing together, which is exactly what let
// concurrency=4 slam 2 requests onto the same key back-to-back with zero
// spacing (see the analyzer/transcriber comments for the incident this
// fixes). This is shared by transcriber.js and analyzer.js since both draw
// from the same key pool and compete for the same per-key budget.
const keyGate = clients.map(() => Promise.resolve(0));

async function paceKey(clientIndex, minIntervalMs) {
  if (!minIntervalMs) return;
  const myTurn = keyGate[clientIndex].then(async (previousRequestAt) => {
    const now = Date.now();
    const earliestAllowed = previousRequestAt + minIntervalMs;
    if (earliestAllowed > now) {
      await new Promise((resolve) => setTimeout(resolve, earliestAllowed - now));
    }
    return Date.now();
  });
  // Swallow rejection here so one caller's downstream error can't wedge the
  // gate for everyone queued behind it on this key - the actual error still
  // propagates to that caller via `await myTurn` below.
  keyGate[clientIndex] = myTurn.catch(() => Date.now());
  await myTurn;
}

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
 * the work list ~evenly between them. Call with no index (undefined) for
 * one-off calls (not part of a chunk list) to fall back to simple
 * round-robin.
 *
 * Pass `minIntervalMs` to also gate the call behind that key's pacing
 * queue - the returned promise won't resolve until at least that long has
 * passed since the *previous* request on this same key, however many
 * chunks are running concurrently. Omit it (or pass 0) to skip pacing
 * entirely, e.g. for callers that already pace themselves.
 */
export async function getGroqClient(index, minIntervalMs) {
  if (!clients.length) {
    throw new Error(
      "No Groq API key configured. Set GROQ_API_KEY (single key) or GROQ_API_KEYS " +
        "(comma-separated, for multiple keys) in your .env."
    );
  }

  const clientIndex =
    clients.length === 1
      ? 0
      : (index === undefined ? roundRobinCounter++ : toStableIndex(index)) % clients.length;

  if (minIntervalMs) await paceKey(clientIndex, minIntervalMs);

  return clients[clientIndex];
}

export function getGroqKeyCount() {
  return clients.length;
}