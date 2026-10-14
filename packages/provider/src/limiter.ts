/**
 * Concurrency limiting and rate limiting for outbound review requests.
 *
 * The upstream review site is a student-run service. Crawling it aggressively would be both rude and fragile, so every provider
 * fetch goes through:
 *
 * - a **semaphore** bounding in-flight requests (default 3), and
 * - a **minimum interval** between request *starts* to the same host.
 *
 * Both are deterministic and testable through injected clocks/sleepers.
 *
 * It lives in `@course-copilot/provider` because the only production consumer is a provider, and because the implementation is
 * host-free: `setTimeout`, `Date.now` and `Promise` are all a browser has.
 *
 * @module @course-copilot/provider/limiter
 */

/** Options for {@link RequestLimiter}. */
export interface RequestLimiterOptions {
  /** Maximum concurrent tasks. */
  concurrency: number;
  /** Minimum milliseconds between task starts. */
  minIntervalMs: number;
  /** Sleep implementation, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Default sleep using a real timer. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Serializes the *start* of tasks while allowing a bounded number in flight. */
export class RequestLimiter {
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private active = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly waiting: Array<() => void> = [];

  constructor(options: RequestLimiterOptions) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency));
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of tasks currently holding a slot. */
  get inFlight(): number {
    return this.active;
  }

  /** Acquire a slot, waiting for capacity and for the rate interval. */
  private async acquire(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;

    const elapsed = this.now() - this.lastStart;
    const wait = this.minIntervalMs - elapsed;
    if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
  }

  /** Release a slot and wake one waiter. */
  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next !== undefined) next();
  }

  /**
   * Run a task under the limits.
   *
   * @param task - the work to perform.
   * @returns the task's result.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /**
   * Run several tasks under the limits.
   *
   * @param tasks - thunks to execute.
   * @returns results in input order.
   */
  async map<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.run(task)));
  }
}
