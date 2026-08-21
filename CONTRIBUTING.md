# Contributing to Sector Chaos

Thanks for your interest in improving this project. This document is the practical path to a change that lands green: the setup, the gates every commit passes, the testing conventions, and the rules the architecture depends on.

> **Read [`AGENTS.md`](AGENTS.md) first.** It is the working instruction set for this repository — architecture map, key files, the critical input path, known gotchas, and the per-feature verification checklist. [`CONTEXT.md`](CONTEXT.md) tracks current project state.

## Development setup

- **Node.js ≥ 20** and **pnpm ≥ 9** (CI runs Node 22; the repo pins `pnpm@10.x` via `packageManager`)
- Docker (optional, for containerized runs)

```bash
git clone <your-fork-url>
cd secto-chaos-neo
pnpm install # also installs the Husky git hooks via the prepare script
```

### Everyday commands

| Command                                      | What it does                                          |
| -------------------------------------------- | ----------------------------------------------------- |
| `pnpm --filter @sector-battle/server dev`    | Run the server on `ws://localhost:2567` (tsx watch)   |
| `pnpm --filter @sector-battle/client-v3 dev` | Run the client on `http://localhost:5174` (Vite)      |
| `pnpm test`                                  | All Vitest suites across the monorepo (Turborepo)     |
| `pnpm typecheck`                             | `tsc --noEmit` in every package                       |
| `pnpm lint`                                  | oxlint in every package                               |
| `pnpm format` / `pnpm format:check`          | Prettier write / check                                |
| `pnpm check:file-length`                     | Enforce the 500-line source-file limit                |
| `docker compose up -d --build`               | Full stack in Docker (client `:8080`, server `:2567`) |

If your server is not on the default port, set `VITE_SERVER_URL` before starting the client.

## The verification bar

A change is not done when it compiles. It is done when the gates below pass **and** you have verified the behavior end-to-end: input → network → server → network → client visual.

### Pre-commit hook (`.husky/pre-commit`)

Runs on every commit, across the whole monorepo:

1. `lint-staged` — Prettier formats staged `.ts/.tsx/.js/.jsx/.json/.css/.md` files
2. `pnpm lint` — oxlint, all packages
3. `pnpm typecheck` — `tsc --noEmit`, all packages
4. `pnpm check:file-length` — the file-length gate (below)

### CI (`.github/workflows/ci.yml`)

On pushes and PRs to `main`: Node 22, `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm lint`.
CI does **not** run the test suites — running them locally is part of your bar.

### Lint rules worth knowing (`oxlint.json`)

Beyond the basics (`eq-eq-eq`, `no-var`, `prefer-const`, `ts/no-unused-vars`):

- `max-lines: 500` — hard cap per source file
- `no-console` — use the logger (loglevel), not console
- `no-set-timeout` / `no-set-interval` — the simulation clock is tick-driven; wall-clock timers are restricted infrastructure (`**/logger.ts` and config/test files are ignored)
- `no-async-without-await`, `ts/no-explicit-any`, `ts/ban-ts-comment`
- `jsdoc/require-param` / `jsdoc/require-returns` — exported functions with JSDoc must document params/returns

Tests (`*.test.ts`, `__tests__/`) are excluded from lint.

### The 500-line file gate

[`scripts/check-file-length.ts`](scripts/check-file-length.ts) fails the commit if any non-test `.ts`/`.tsx` file under `packages/` exceeds **500 lines**. Keep files focused and extract partials — the codebase uses a `Foo.ts` + `FooSomething.ts` partial convention extensively (e.g. `GameSimulationCombat.ts`, `EntityRendererProjectiles.ts`). Four data files are exempt (asset manifest, weapon definitions, two arena-skeleton files); new exemptions are rare — prefer splitting.

## Testing

### Vitest suites

```bash
pnpm --filter @sector-battle/server test     # ~2,240 tests: GameRoom, simulation, services, bot AI
pnpm --filter @sector-battle/client-v3 test  # ~1,177 tests: renderers, prediction, bridges, HUD
pnpm test                                    # both, via Turborepo
```

### The fast-forward bot benchmark

The primary regression tool for the simulation and bot AI. It uses `@colyseus/testing` to instantiate the real `GameRoom` and drives `orchestrator.update(TICK_INTERVAL)` synchronously with a virtual clock, so a full 10-minute, 63-bot match completes in seconds of wall-clock:

```bash
pnpm --filter @sector-battle/server run bench:bot-ai
```

Tunable via env vars: `BENCH_BOTS`, `BENCH_DURATION`, `BENCH_SAMPLE`, `BENCH_SEED`, `BENCH_DIFFICULTY`, `BENCH_MAP`, and `BENCH_LAST_STANDING` (`-1` disables the alive-count end condition so late zone/siege/overtime phases are exercised). A JSON report is written to `packages/server/bench-results/`.

**Same-seed runs are deterministic**: two runs with the same `BENCH_SEED` produce byte-identical reports, modulo wall-clock fields. If you touch the simulation, movement, collision, or bot AI, run the benchmark before and after and diff the reports — kills, alive-over-time, and the death-cause histogram should match unless you intentionally changed behavior.

### Preferred test patterns

- **Verbatim-oracle parity tests** — when extracting or unifying logic (especially into `packages/shared`), keep the original implementation available to the test and assert the new one matches it exactly, bit-identically for float math. This is how the behavior-preserving refactors in the 2026-08 performance effort (see [`docs/performance.md`](docs/performance.md) and the `perf/optimization-queue` branch) were proven.
- **Freeze the clock** for timing-sensitive tests (see the `freezeServerWallClock` helper) instead of sleep-based assertions.
- **Assert against server-authoritative state** when testing netcode, not client visual state.

## Rules you must not break

1. **Server-authoritative, always.** The client never decides game state. Client prediction is movement-only; combat resolves on the server.
2. **The GDD is the business-rules source of truth** ([`docs/GDD.md`](docs/GDD.md)). Do not change gameplay numbers — damage values, timings, hitboxes, speeds, radii — without a GDD change backing it.
3. **Behavior-preserving refactors must be provably so.** That is what the parity tests and the deterministic benchmark are for. No visual downgrades.
4. **End-to-end verification.** A feature is not done until it works from input through the server and back to the client visual. A renderer that is never called is not a feature.
5. **Float determinism is sacred** ([ADR-0035](docs/adr/0035-determinism-contract.md)) — no `Math.random` in shared simulation primitives; RNG stays server-driven and seeded.

Where to orient yourself:

- [`AGENTS.md`](AGENTS.md) — the working instruction set (read first)
- [`docs/README.md`](docs/README.md) — the documentation suite index
- [`docs/architecture.md`](docs/architecture.md) — the codemap (packages, relationships, invariants)
- [`docs/adr/`](docs/adr/) — 38 ADRs; check whether your change collides with a recorded decision
- [`docs/GDD.md`](docs/GDD.md) — business rules
- [`docs/performance.md`](docs/performance.md) — enforced budgets + measurement recipes

## Commit style

Conventional-commit-style subjects with a scope, matching the existing history (`git log --oneline`):

```
perf(ticket-43): shared tile-collision primitive (verbatim-oracle parity, byte-identical bench)
debt(F3): server-suite-deflake — freezeServerWallClock for timing races
infra(F6): docker-build-repair — root compose shim, bare `docker compose` works
fix(input): edge-trigger PICKUP so held E doesn't spam
feat(zone): overtime siege cascade
```

Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, plus `debt(...)` and `infra(...)` from the optimization effort. The scope is usually a ticket id or component. For behavior-preserving changes, state **how you proved it** in the body (parity sweep, verbatim-oracle tests, byte-identical benchmark report) — that is the house style.

## Pull requests

Keep PRs focused — one fix or ticket each. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) checklist mirrors this document: typecheck, lint, tests, the file-length gate, a benchmark before/after for simulation/AI changes, and an explicit statement that gameplay numbers and visuals are unchanged (or a GDD reference for intentional changes).
