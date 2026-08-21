# Bot Difficulty as Tactical Repertoire, Not Execution Handicap

## Status: Accepted

## Context

Bot difficulty was purely stat-based: easy bots had the same behavior tree, target selection, evasion logic, and movement patterns as hard bots, with random execution errors (aim jitter, timing delay) layered on top. Hard bots had zero-tick reaction times, perfect aim, and 90% melee windup dodge — capabilities no human could match.

For a **skill benchmark** (the primary bot AI goal — B > C > A), this is broken. The human can't learn from losses caused by superhuman reflexes. There's nothing to read or counter — the bot simply reacts faster than biologically possible.

## Decision

Difficulty is defined by **tactical repertoire size**, not execution precision. All bots — including elite — are capped at human-feasible reaction times, aim precision, and information access. The progression is:

- **Easy** (12-tick / 200ms reaction): Direct approach, trade hits, basic survival. Competent but predictable.
- **Medium** (10-tick / 167ms): Adds strafing, projectile evasion, weapon switching, cover retreats.
- **Hard** (8-tick / 133ms): Adds flanking, baiting, hit-and-run, melee dodging with mixed directions.
- **Elite** (6-tick / 100ms): Adds pattern reading, frame traps, combo setups, adaptive strategy.

Each level is a superset of the previous. The existing BT becomes the "easy" tree; medium/hard/elite add branches. The stat modifiers (aimJitterDegrees, attackTimingErrorTicks) become secondary polish, not the primary difficulty axis.

## Considered Options

**A) Keep superhuman execution, add behavioral variety.** Hard bots keep 0-tick reaction and 90% dodge. Difficulty changes which patterns they use. Rejected: unfair to humans. Losses feel cheated, not earned. Nothing to learn from.

**B) Cap execution at human-feasible levels, difficulty changes tactical depth.** All bots respect human limits. Difficulty comes from strategy sophistication. Chosen: aligns with skill benchmark goal. Losses are educational.

## Consequences

- The LOS grace period (bots briefly seeing through walls) must be revisited — it's an information cheat under this model.
- The 90% melee windup dodge must be replaced with a reaction-delay-gated dodge that hard bots can only execute against slow weapons.
- The benchmark scores will change significantly (lower combat/survival for all levels). The benchmark becomes a regression test, not an optimization target.
- Requires implementing a reaction delay system that gates reactive behaviors (dodge, target switch, retreat) without freezing proactive ones (approach, attack, strafe).
- Real validation requires human playtesting — the benchmark can only verify regression, not skill-benchmark quality.
