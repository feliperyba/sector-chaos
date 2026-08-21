/**
 * Seedable swap-in source for sim-side randomness — benchmark determinism (F4).
 *
 * A handful of simulation call sites historically drew from the global,
 * unseeded `Math.random()` (spawn jitter, ground-weapon rolls, teleport
 * destinations, bot-name pool). In production that is correct and stays
 * untouched: with NO override installed, {@linkcode simRandom} calls the exact
 * same `Math.random()` — same call sites, same call counts, same
 * distribution, zero behavior change.
 *
 * The bot-AI benchmark harness (`tests/helpers/bot-benchmark-harness.ts`)
 * installs a seeded source before creating the room, which makes every
 * sim-side roll a pure function of the bench seed. The override is
 * process-local test tooling and is NEVER installed by the production server
 * (ADR-0035 keeps RNG server-driven; this module lives in server, not shared).
 *
 * Algorithm: mulberry32 — the same PRNG already proven in-tree by
 * `ai/BotContextRng.ts` (`BotRNG`), so benchmark seeding uses one familiar,
 * well-distributed generator everywhere.
 *
 * Streams: each call site passes a stable site tag and gets its OWN
 * sub-stream, seeded `rootSeed ^ hash(siteTag)`. Per-site streams decouple
 * unrelated call sites — a change in one site's call count (e.g. a new spawn
 * path) does not shift the draw sequence of every other site, which a single
 * shared stream would. Same tag → same deterministic sequence.
 */

/** Seeded uniform [0, 1) generator (mulberry32). */
type SeededGenerator = () => number;

/** Root bench seed installed by the harness; `null` in production. */
let seededRoot: number | null = null;

/** Lazily-created per-site mulberry32 streams derived from {@linkcode seededRoot}. */
const siteStreams = new Map<string, SeededGenerator>();

/** FNV-1a string hash → 32-bit uint (mirrors `hashToSeed` in BotContextRng.ts). */
function hashSiteTag(tag: string): number {
  let h = 2166136261;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32 — byte-identical recurrence to `BotRNG.next` in
 * `ai/BotContextRng.ts`, factored as a closure so each site owns its own state.
 */
function mulberry32(seed: number): SeededGenerator {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform float in [0, 1) for sim-side rolls. Pass a stable site tag (e.g.
 * `'spawn-jitter'`) identifying the call site.
 *
 * - Production (no override installed): returns `Math.random()` — the exact
 *   call the site made before this module existed.
 * - Bench (override installed): returns the next draw from the site's seeded
 *   mulberry32 sub-stream — deterministic for a given bench seed.
 */
export function simRandom(site: string): number {
  if (seededRoot === null) return Math.random();
  let stream = siteStreams.get(site);
  if (stream === undefined) {
    stream = mulberry32(seededRoot ^ hashSiteTag(site));
    siteStreams.set(site, stream);
  }
  return stream();
}

/**
 * Install a seeded source for the whole process (bench-harness only).
 * Subsequent `simRandom` draws are a pure function of `seed` + call sequence
 * per site. Installing twice re-derives all streams from the new seed.
 */
export function installSeededSimRandom(seed: number): void {
  seededRoot = seed >>> 0;
  siteStreams.clear();
}

/** Remove the seeded source (bench teardown). Restores the `Math.random()` path. */
export function uninstallSeededSimRandom(): void {
  seededRoot = null;
  siteStreams.clear();
}
