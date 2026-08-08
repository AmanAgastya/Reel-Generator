import { readFileSync } from "fs";
import os from "os";

// os.cpus().length reports the HOST machine's physical core count - it has
// no idea the process is running inside a container with a much smaller
// CPU share. On platforms like Render's free tier, the underlying host can
// report 2-8 cores while the container is actually throttled to a fraction
// of one (their published free-tier limit is 0.1 CPU). Every concurrency
// default in this codebase (CLIP_RENDER_CONCURRENCY, CLIP_RENDER_THREADS,
// AUDIO_ENERGY_CONCURRENCY) was built on os.cpus().length, so on a host like
// that it was sizing itself for 2-8 cores it never actually gets - e.g.
// launching 4 concurrent ffmpeg encodes, each also requesting its own
// thread, all fighting over ~0.1 of a real CPU. The OS scheduler thrashes
// between them instead of ever letting one finish, which is what turns a
// render that should take a few seconds into one that takes minutes, even
// though nothing about the encode itself changed. Reading the actual cgroup
// CPU quota (what container platforms use to enforce their limit) and
// sizing concurrency off that instead fixes this at the root, and is a
// no-op on a normal, unthrottled machine (dev laptop, a paid box with real
// cores) since the quota there is unset/unlimited and this just falls back
// to os.cpus().length like before.
let cachedEffectiveCpus;

function readCgroupV2Quota() {
  // Format: "<quota> <period>" in microseconds, or "max <period>" if
  // unlimited.
  const raw = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
  const [quotaStr, periodStr] = raw.split(/\s+/);
  if (quotaStr === "max") return null;
  const quota = Number(quotaStr);
  const period = Number(periodStr);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

function readCgroupV1Quota() {
  const quota = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
  const period = Number(readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
  // -1 quota means "no limit set" under cgroup v1.
  if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

/**
 * Returns the number of CPUs actually available to this process: the
 * container's cgroup CPU quota when one is set and tighter than the host's
 * physical core count, otherwise os.cpus().length. Always at least 1.
 * Computed once and cached - the quota doesn't change during the process's
 * lifetime.
 */
export function getEffectiveCpuCount() {
  if (cachedEffectiveCpus !== undefined) return cachedEffectiveCpus;

  const hostCores = Math.max(1, os.cpus().length);
  let quotaCores = null;
  try {
    quotaCores = readCgroupV2Quota();
  } catch {
    try {
      quotaCores = readCgroupV1Quota();
    } catch {
      quotaCores = null;
    }
  }

  cachedEffectiveCpus =
    quotaCores !== null && quotaCores > 0 ? Math.max(1, Math.min(hostCores, Math.floor(quotaCores))) : hostCores;

  return cachedEffectiveCpus;
}