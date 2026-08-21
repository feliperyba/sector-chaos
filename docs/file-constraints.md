# File Constraints Reference — GDD Section 19

All 8 file constraints enforced in this project.

## Automated Enforcement

### 1. Max file length: 500 lines

- **Rule:** `max-lines` in `oxlint.json` set to `["error", { "max": 500 }]`
- **CI backup:** `pnpm check:file-length` runs `scripts/check-file-length.ts`
- **Exemptions:** test files excluded via `ignore` pattern in `oxlint.json`; four data files exempt from the script (asset manifest, weapon definitions, two arena-skeleton files)
- **House pattern:** the `Foo.ts` + `FooSomething.ts` partial convention (`GameSimulationCombat.ts`, `EntityRendererProjectiles.ts`, …)

### 2. TypeScript strict mode: Enabled

- **Config:** `tsconfig.base.json` — `"strict": true`, `"noUncheckedIndexedAccess": true`
- **Inherited by:** all packages via `"extends": "../../tsconfig.base.json"`

### 3. No `any` types

- **Rule:** `ts/no-explicit-any: "error"` in `oxlint.json`

### 4. No `@ts-ignore`

- **Rule:** `ts/ban-ts-comment: "error"` in `oxlint.json` — blocks `@ts-ignore`, `@ts-expect-error`, and other TS directive comments

### 5. No `console.log` in production

- **Rule:** `no-console: "error"` in `oxlint.json` — use the shared logger (loglevel), not console

### 6. JSDoc on public APIs

- **Automated:** `jsdoc/require-param: "error"` and `jsdoc/require-returns: "error"` in `oxlint.json`
- Exported functions/classes must document params and returns

### 7. Shared stays framework-agnostic

- **Reality:** `packages/shared/package.json` declares exactly one runtime dependency — `loglevel`, the logger all three packages share (per the no-console rule). 
- **The rule it enforces:** no engine/framework dependencies — shared must never import Colyseus or Phaser. Server and client both trust shared byte-for-byte; an engine import poisons the contract (see [architecture.md](architecture.md#the-three-packages-and-their-relationship)).
- **Audit:** `grep` the `dependencies` block of `packages/shared/package.json` — anything beyond `loglevel` needs a justification.

### 8. Deterministic map from seed

- **Verified:** zero `Math.random()` calls in `packages/shared/src/map/` — all randomness via `packages/shared/src/map/rng/SeededRNG.ts` with isolated XOR-salted streams per concern (ADR-0035)
- **CI check:** `grep -r "Math.random" packages/shared/src/map/` must return zero results

## Verification Commands

```bash
pnpm typecheck          # strict mode + all TS checks
pnpm lint               # oxlint rules including max-lines, no-any, no-console
pnpm check:file-length  # standalone 500-line enforcement script
pnpm test               # full test suite
```
