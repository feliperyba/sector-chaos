## Summary

<!-- What changed and why. One paragraph, then bullets for the non-obvious parts. -->

## Type of change

<!-- Keep the one that applies -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `perf` — performance improvement (behavior-preserving)
- [ ] `refactor` — behavior-preserving restructuring
- [ ] `docs` / `test` / `chore` / `infra` / `debt`

## Behavior preservation

<!-- Required for perf/refactor/debt changes: state how you proved it
     (verbatim-oracle parity sweep, bit-identity proof, byte-identical bench report, ...) -->

- [ ] No GDD gameplay numbers changed (damage, timings, hitboxes, speeds, radii)
- [ ] No visual downgrade
- [ ] Server-authoritative design preserved (client prediction remains movement-only)

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test` (server + client suites)
- [ ] `pnpm check:file-length` (≤ 500 lines per source file)
- [ ] Pre-commit hook passes
- [ ] Simulation / bot AI / movement / collision touched → `pnpm --filter @sector-battle/server run bench:bot-ai` before and after; JSON report diff explains any intentional change
- [ ] Netcode / client visuals touched → verified end-to-end input → server → client visual (150 ms+ simulated latency, no raw-server-position flash)
- [ ] Infra touched → `docker compose build` + `docker compose up -d` reaches healthy

## Reference

<!-- ADRs consulted, ticket id (docs/perf-optimization/tickets/...), GDD section, related issues -->
