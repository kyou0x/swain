/**
 * Token bucket with an injected clock (no timers, no `Date.now`): tokens are computed from the
 * elapsed time whenever the bucket is touched. `burst` is the capacity, `perSec` the refill rate.
 */
export class TokenBucket {
  readonly #burst: number;
  readonly #perMs: number;
  #tokens: number;
  #last: number;

  constructor(burst: number, perSec: number, nowMs: number) {
    this.#burst = burst;
    this.#perMs = perSec / 1000;
    this.#tokens = burst;
    this.#last = nowMs;
  }

  #refill(nowMs: number): void {
    // A clock that goes backwards never mints tokens.
    if (nowMs > this.#last) {
      this.#tokens = Math.min(this.#burst, this.#tokens + (nowMs - this.#last) * this.#perMs);
      this.#last = nowMs;
    }
  }

  /** True when at least `n` tokens are available. Does not consume. */
  has(nowMs: number, n = 1): boolean {
    this.#refill(nowMs);
    return this.#tokens >= n;
  }

  /** Consume `n` tokens; false (and nothing consumed) when fewer are available. */
  take(nowMs: number, n = 1): boolean {
    this.#refill(nowMs);
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }

  /** Whole seconds (at least 1) until `n` tokens are available, for `Retry-After`. */
  retryAfterSec(nowMs: number, n = 1): number {
    this.#refill(nowMs);
    const missing = Math.max(0, n - this.#tokens);
    return Math.max(1, Math.ceil(missing / this.#perMs / 1000));
  }
}
