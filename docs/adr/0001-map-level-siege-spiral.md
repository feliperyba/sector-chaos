# Map-Level Concentric Rectangle Siege (replacing per-sector spiral)

The GDD originally specified per-sector siege: each 20×20 sector independently spiraled inward (N→S→E→W) when its center fell outside the safe zone circle. We replaced this with a **map-level concentric rectangle spiral** that closes from the map edges inward (N→E→S→W, clockwise). Each side tracks its own offset independently, and the spiral skips sides whose rows/columns overlap the zone circle — creating natural escape routes toward the zone center. DESTRUCTIBLE_WALL tiles in the siege line are skipped (not replaced), adding a combat-based escape option. Empty rows (all skip tiles) are fast-forwarded instantly rather than consuming a siege interval. In overtime, siege closes into the safe zone at 1.5s intervals to guarantee match resolution.

**Considered Options:**
- Per-sector spiral (original GDD) — jagged boundaries, unpredictable for players, caused "lines not spawning" when edge rows hit map borders
- Map-level concentric rectangles with per-tile zone circle checks (scalloped edges) — visually noisy, undermines readability
- Map-level concentric rectangles, whole rows only, skip at zone boundary (chosen)

**Consequences:**
- Sectors become a thin UI/announcement layer only, not a siege progression unit
- SiegeService still detects sectors outside the zone for "Sector under siege!" announcements
- The siege state sync simplifies from N×(side, offset) per sector to 4 per-side offsets for the whole map
- Siege progression is no longer tied to sector grid configuration — works identically for 80×80 production maps and 22×22 test maps
