/**
 * The cache contract a review provider requires.
 *
 * ## Why this is declared HERE, and not in `@course-copilot/core`
 *
 * This is a **consumer-owned contract**. A provider needs somewhere to put fetched review rows so a repeated query does not
 * re-contact the site; what it needs is three operations and a statistics object. That requirement belongs to the module that has
 * it.
 *
 * `@course-copilot/core` is a domain package — normalization, matching, aspect analysis, scoring, ranking — whose own charter
 * says "Host-free — no DSH, no Cordis, no browser, no filesystem", and which today contains no infrastructure contract at all.
 * Putting an async cache interface there would have made it the home of every such abstraction, and the interface would have
 * arrived carrying a storage detail that is not true of caches in general (see below).
 *
 * ## Why structural typing is enough, and why the implementation stays unaware
 *
 * TypeScript checks assignability by SHAPE. An implementation therefore satisfies this contract without importing it and without
 * `implements`:
 *
 *     // in the consumer's own world, no import from this package:
 *     class SomeCache<T> { async get(..) ..  async set(..) ..  async clear() ..  readonly stats = {..}; }
 *     const cache: CacheLike<T> = new SomeCache<T>();   // accepted
 *
 * That is deliberate. The Node cache in the application is a GENERIC TTL cache: it should not have to depend on a particular
 * provider package — or on any provider at all — merely to prove it is compatible with one. `implements` here would be a
 * gratuitous dependency edge from a generic utility to a specific consumer.
 *
 * ## Failure behaviour is deliberately NOT specified
 *
 * This interface fixes method shapes and result shapes. It says NOTHING about whether an implementation may reject or throw.
 * A `Promise<T | undefined>` return type cannot promise that a call resolves.
 *
 * The behaviour that a cache failure is non-fatal belongs to specific implementations — the application's `TtlCache` swallows
 * its own disk and parse errors and degrades to a miss or a no-op, and that is its own semantic, not this contract's. No code may
 * assert "any `CacheLike` never throws"; that claim is not supported here.
 *
 * @module @course-copilot/provider/cache
 */

/**
 * Statistics a provider can meaningfully report about a cache.
 *
 * ## Why only these four fields
 *
 * Every one of them describes **any** cache, whatever it is built on:
 *
 * - `hits` / `misses` — whether a lookup was served,
 * - `writes` — whether a value was stored,
 * - `disabled` — whether the cache was switched off.
 *
 * ## What is deliberately absent
 *
 * No `diskReads`, `diskWrites`, `memoryReads`, `indexedDbReads`, `storageType` or `path`. Those name a **storage medium**, and a
 * medium is a property of one implementation rather than of caching. An earlier version of this contract carried disk counters,
 * and the cost was visible: a purely in-memory test double had to fabricate `diskReads: 0` fields it could never populate.
 *
 * An implementation is still free to expose MORE than this — see {@link CacheLike}'s second type parameter. This contract
 * states the floor, not the ceiling.
 */
export interface CacheStats {
  /** Lookups served from the cache. */
  readonly hits: number;
  /** Lookups that found nothing. */
  readonly misses: number;
  /** Values stored. */
  readonly writes: number;
  /** Whether this cache is switched off, in which case it stores and serves nothing. */
  readonly disabled: boolean;
}

/**
 * The cache a provider needs: read a value, store a value, drop everything, report statistics.
 *
 * @typeParam T - the value being cached (for reviews, the provider's raw row type).
 * @typeParam S - the implementation's statistics object. It must AT LEAST satisfy {@link CacheStats}, and may add its own
 *   counters on top. The constraint is what keeps `CacheLike<T, string>` from being a well-formed type: a statistics object has
 *   to carry the four counters above, because a provider reports them.
 */
export interface CacheLike<T, S extends CacheStats = CacheStats> {
  /**
   * Read a value.
   *
   * @param key - cache key.
   * @returns the cached value, or `undefined` when there is none (or when caching is disabled).
   */
  get(key: string): Promise<T | undefined>;

  /**
   * Store a value.
   *
   * @param key - cache key.
   * @param value - the value to store.
   */
  set(key: string, value: T): Promise<void>;

  /** Drop every stored value. Values may also expire on their own, which is not this method's concern. */
  clear(): Promise<void>;

  /** The implementation's statistics. */
  readonly stats: S;
}
