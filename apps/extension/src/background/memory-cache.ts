/**
 * An in-memory review cache for the extension.
 *
 * ## Where this lives, and why
 *
 * It is EXTENSION HOST infrastructure, so it lives beside the code that will use it rather than in a workspace package. There are
 * deliberately two cache implementations in this repository and they are not duplicates:
 *
 * - `src/store/cache.ts` is the **Node host** cache. It has a disk tier, because a Node process restarts and a persistent tier is
 *   worth having there.
 * - this module is the **extension host** cache. It is memory-only, because a Manifest V3 worker is suspended and restarted by the
 *   browser and there is no filesystem to write to.
 *
 * Unifying them would mean either giving this one a disk tier it cannot use, or giving that one a memory-only mode that loses the
 * behaviour Node callers depend on. They are host-specific implementations of one contract, and the contract is what keeps them
 * interchangeable: `test/step42ExtensionMemoryCache.test.ts` checks this class structurally against the provider's `CacheLike`.
 *
 * ## TTL is a mechanism here, not a policy
 *
 * The constructor REQUIRES `ttlMs` and there is no default. Choosing how long review data stays fresh — six hours, thirty
 * minutes, something else — is a product decision that belongs with the wiring that instantiates this cache, not with the cache
 * itself. Nothing in this file names a duration.
 *
 * The same reasoning is why there is **no module-level instance**. Whoever creates the cache also owns its lifetime, and a
 * singleton here would decide that quietly.
 *
 * ## Failure behaviour
 *
 * `CacheLike` fixes method and result shapes and says nothing about whether an implementation may reject or throw. This
 * implementation performs no I/O, so its `get`/`set`/`clear` cannot fail for an environmental reason — but that is a property of
 * THIS implementation, not a guarantee of the contract, and nothing may assert otherwise.
 *
 * @module course-selection-copilot/background/memory-cache
 */

import type { CacheLike, CacheStats } from '@course-copilot/provider';

/*
 * `CacheLike` is imported as a TYPE only, and the class does not use `implements`.
 *
 * The contract is structural, so this class satisfies it by SHAPE — the import is erased at compile time, so the extension never
 * pulls the provider package's runtime into its bundle. The assignability proof lives in
 * `test/step42ExtensionMemoryCache.test.ts`, which `tsc` checks and which ships nowhere.
 *
 * The one thing that DOES need the type here is `stats`: `CacheStats` marks its fields `readonly`, so the declared type has to be
 * named explicitly. A bare object literal would infer its own mutable type and reject the increments below.
 */

/** One stored value and the instant it goes stale. */
interface Entry<T> {
  readonly value: T;
  /** Epoch milliseconds at or after which the entry is stale. */
  readonly expiresAt: number;
}

/** Options for {@link MemoryCache}. */
export interface MemoryCacheOptions {
  /**
   * How long a stored value stays fresh, in milliseconds.
   *
   * REQUIRED. There is no default because the right duration is a product decision and not this module's to make.
   *
   * Must be finite and non-negative. `0` is valid and means "stale immediately" — see {@link MemoryCache.get}.
   */
  ttlMs: number;
  /**
   * Clock, in epoch milliseconds.
   *
   * Injectable so tests are deterministic; defaults to the real clock. No timers are involved: expiry is evaluated lazily when a
   * key is read.
   */
  now?: () => number;
}

/**
 * A memory-only, lazily-expiring cache.
 *
 * @typeParam T - the value being cached.
 */
export class MemoryCache<T> {
  /*
   * The counters are declared with their own mutable type rather than as `CacheStats`, because that interface marks every field
   * `readonly` — correct for a CONSUMER reading statistics, and impossible to increment from the implementation that owns them.
   *
   * The relationship to the contract is not lost: `MemoryCacheSatisfiesContract` below asserts that this class, including this
   * stats shape, is assignable where a `CacheLike` is expected.
   */
  readonly stats: { hits: number; misses: number; writes: number; disabled: boolean } = {
    hits: 0,
    misses: 0,
    writes: 0,
    disabled: false,
  };

  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  /**
   * @param options - the TTL, and optionally a clock.
   * @throws RangeError when `ttlMs` is not finite or is negative. The value is never silently clamped: a caller asking for a
   *   negative lifetime has a bug, and rounding it to zero would hide it.
   */
  constructor(options: MemoryCacheOptions) {
    const { ttlMs } = options;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new RangeError(`ttlMs 必须是有限且非负的毫秒数，实际收到 ${String(ttlMs)}`);
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Read a value.
   *
   * An entry is stale when `expiresAt <= now`, so with `ttlMs: 0` every entry is stale on the very next read at the same instant.
   * A stale entry is DELETED rather than merely ignored, so it cannot reappear and cannot accumulate.
   *
   * @param key - cache key.
   * @returns the stored value, or `undefined` when absent or stale.
   */
  async get(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return entry.value;
  }

  /**
   * Store a value.
   *
   * The value is held by reference. Nothing is serialized, copied or structured-cloned, so an object comes back as the same
   * object — which matters because these are review records, and a copy would quietly break identity comparisons downstream.
   *
   * @param key - cache key.
   * @param value - the value to store.
   */
  async set(key: string, value: T): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    this.stats.writes += 1;
  }

  /** Drop every entry. */
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/**
 * TYPE-ONLY assertions that this class satisfies the provider's contract.
 *
 * ## Why these are `const` declarations and not bare type aliases
 *
 * A bare `type X = Expect<...>` does NOT enforce the constraint: TypeScript defers that check for a type alias never used in a
 * value position, so `type P = Expect<never>` compiles cleanly — measured, not assumed. A `const` annotation is checked
 * immediately, which is what makes these real assertions rather than declarations that merely look like them.
 *
 * The initialisers are `true`, the value a SATISFIED condition produces. If a future edit breaks the class's shape, or its
 * counters' shape, the condition becomes `never` and the initialiser stops typechecking AT THIS LINE rather than at some call site
 * written later.
 *
 * Nothing is instantiated: these are compile-time constants, and the extension still has no cache instance until the wiring step
 * creates one.
 */
type Expect<T extends true> = T;

/** `MemoryCache` is assignable where the provider's contract is expected. */
export const memoryCacheSatisfiesContract: Expect<MemoryCache<unknown> extends CacheLike<unknown> ? true : never> = true;

/**
 * And its counters are assignable to the contract's view of them.
 *
 * The class declares its counters with their own mutable type — `CacheStats` marks every field `readonly`, which a consumer wants
 * and an implementation cannot increment through — so the claim recorded here is that those counters still MEET the contract.
 */
export const memoryCacheStatsSatisfyContract: Expect<MemoryCache<unknown>['stats'] extends CacheStats ? true : never> = true;
