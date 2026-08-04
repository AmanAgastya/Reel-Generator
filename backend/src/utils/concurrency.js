/**
 * Runs `worker` over `items` with at most `limit` in flight at once,
 * preserving result order. Used to parallelize independent, slow
 * operations (LLM calls, ffmpeg renders) instead of awaiting them
 * one-by-one in a for loop.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runNext));
  return results;
}