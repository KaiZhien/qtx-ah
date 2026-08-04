import { createHash } from 'node:crypto'

/**
 * An in-memory stand-in for Next's incremental cache, so `unstable_cache` runs
 * its REAL code path under vitest.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * `unstable_cache` needs a cache backend, and outside a Next request there is no
 * store to take one from — so it throws `Invariant: incrementalCache missing in
 * unstable_cache`. Every dashboard widget is wrapped in it, which made the whole
 * of `modules/shared/reporting/services/dashboardService.ts` untestable at the
 * integration level: 17 tests failed before this file existed, including the two
 * that exist specifically to prove one actor's cached widget is never served to
 * another. A cache you cannot test is a cache whose isolation you take on faith,
 * and a cross-user leak was already found in that exact file.
 *
 * ── WHY A BACKEND RATHER THAN A BYPASS ──────────────────────────────────────
 * The obvious alternatives were both worse:
 *
 *   - `vi.mock('next/cache')` to make the wrapper a pass-through, or an env flag
 *     that skips it. Either makes the TESTED path different from the SHIPPED
 *     path, so the security property under test — that `dashboardCacheKey`
 *     actually separates two actors inside `unstable_cache`'s own key
 *     construction — would no longer be tested by these tests at all.
 *   - Extracting each widget's uncached resolver and testing that. Same problem
 *     with a bigger diff: the integration suite would stop exercising the cache,
 *     leaving the key pinned only by the pure unit test it already has.
 *
 * `unstable_cache` reads `globalThis.__incrementalCache` when no request store is
 * present (next/dist/server/web/spec-extension/unstable-cache.js). Filling that
 * slot leaves Next's own code — `fixedKey` from `cb.toString()` + `keyParts`, the
 * `JSON.stringify`/`JSON.parse` round trip, the revalidate window — completely
 * unmodified. Only the storage is ours, which is precisely the layer Next itself
 * expects deployments to swap (`cacheHandler`). So a hit here is a real hit, and
 * the JSON round trip really happens — which is also what makes the "a cache hit
 * matches a cache miss" tests mean something.
 *
 * ── WHAT `unstable_cache` ACTUALLY CALLS ON IT ──────────────────────────────
 * In the no-store branch: `isOnDemandRevalidate`, `fetchCacheKey(invocationKey)`,
 * `get(key, ctx)` and `set(key, entry, ctx)`. Nothing else — deliberately not a
 * general-purpose CacheHandler.
 */

type StoredEntry = {
  body: string
  storedAtMs: number
  revalidateSeconds: number | false | undefined
}

const store = new Map<string, StoredEntry>()

type FetchCacheEntry = {
  kind: 'FETCH'
  data: { body: string; headers: Record<string, string>; status: number; url: string }
  revalidate?: number
}

const testIncrementalCache = {
  /** Never on-demand here; that path is a Next server concern. */
  isOnDemandRevalidate: false,

  /** Next hashes the invocation key into a filesystem-safe id; so do we. */
  async fetchCacheKey(invocationKey: string): Promise<string> {
    return createHash('sha256').update(invocationKey).digest('hex')
  },

  async get(cacheKey: string) {
    const entry = store.get(cacheKey)
    if (!entry) return null
    const { revalidateSeconds } = entry
    if (typeof revalidateSeconds === 'number') {
      const ageSeconds = (Date.now() - entry.storedAtMs) / 1000
      // Expired entries are dropped rather than returned as `isStale`: without a
      // request store there is nothing to schedule a background revalidation, so
      // "regenerate now" is the only honest answer.
      if (ageSeconds > revalidateSeconds) {
        store.delete(cacheKey)
        return null
      }
    }
    return {
      value: {
        kind: 'FETCH' as const,
        data: { body: entry.body, headers: {}, status: 200, url: '' },
      },
      isStale: false,
    }
  },

  async set(
    cacheKey: string,
    entry: FetchCacheEntry,
    ctx: { revalidate?: number | false },
  ): Promise<void> {
    store.set(cacheKey, {
      body: entry.data.body,
      storedAtMs: Date.now(),
      revalidateSeconds: ctx.revalidate,
    })
  },
}

type CacheGlobal = typeof globalThis & { __incrementalCache?: unknown }

/**
 * Installs the backend. Called once from setup.ts, so every integration file gets
 * a working `unstable_cache` whether or not it touches the dashboard.
 */
export function installIncrementalCache(): void {
  ;(globalThis as CacheGlobal).__incrementalCache = testIncrementalCache
  store.clear()
}

/**
 * Empties the cache between tests.
 *
 * A live 60-second cache is exactly what the isolation tests need WITHIN a test,
 * and exactly what makes a data test lie ACROSS tests: insert a row, re-read the
 * widget as the same actor, and you get the pre-insert entry back. So the rule is
 * `beforeEach(resetIncrementalCache)` — cleared between tests, live inside one.
 */
export function resetIncrementalCache(): void {
  store.clear()
}

/** Entries currently held — for a test that needs to prove a hit happened. */
export function incrementalCacheSize(): number {
  return store.size
}
