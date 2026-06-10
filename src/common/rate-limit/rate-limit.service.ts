import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process sliding-window rate limiter.
 *
 * Each named bucket stores the timestamps of recent requests. `check()` is
 * test-and-record: it returns false (and records nothing) when the caller is
 * over the limit, or true after recording the current timestamp.
 *
 * Memory: a sweep runs every 60 s and drops buckets whose last request is
 * older than one hour, so abandoned IP entries don't accumulate forever.
 *
 * Thread-safety: Node.js is single-threaded, so no mutex is needed.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  /** bucket key → sorted array of request timestamps (ms since epoch) */
  private readonly windows = new Map<string, number[]>();

  private static readonly SWEEP_INTERVAL_MS = 60_000;
  private static readonly SWEEP_MAX_AGE_MS = 3_600_000; // 1 hour

  constructor() {
    const timer = setInterval(
      () => this.sweep(),
      RateLimitService.SWEEP_INTERVAL_MS,
    );
    // Don't hold the Node.js event loop open for sweeps alone.
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Test-and-record a request for the given bucket.
   *
   * @param bucket    Opaque string key (e.g. `"act:192.168.1.1"`)
   * @param limit     Max requests allowed inside the window
   * @param windowMs  Rolling window duration in milliseconds
   * @returns `true` if the request is allowed; `false` if throttled.
   */
  check(bucket: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    const prev = this.windows.get(bucket);

    // Filter to only timestamps inside the current window.
    const hits = prev ? prev.filter((t) => t > cutoff) : [];

    if (hits.length >= limit) {
      return false; // over-limit — do not record
    }

    hits.push(now);
    this.windows.set(bucket, hits);
    return true;
  }

  /**
   * Remaining capacity for a bucket without recording anything.
   * Useful for building Retry-After headers.
   */
  remaining(bucket: string, limit: number, windowMs: number): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = (this.windows.get(bucket) ?? []).filter((t) => t > cutoff);
    return Math.max(0, limit - hits.length);
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  private sweep(): void {
    const cutoff = Date.now() - RateLimitService.SWEEP_MAX_AGE_MS;
    let removed = 0;
    for (const [key, hits] of this.windows) {
      if (hits.length === 0 || hits[hits.length - 1] < cutoff) {
        this.windows.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Rate-limit sweep: removed ${removed} stale bucket(s)`);
    }
  }
}
