# ADR 0004: Game-Derived Color Palette for UI

## Status

Accepted

## Context

The UI redesign needs a color palette. The game world uses a specific set of colors across its rendering systems (attacks, explosions, zone effects, HUD, VFX). Introducing new colors for menus would create visual discontinuity between menu screens and gameplay.

Analysis of existing gameplay colors:
- **Orange/amber family** (dominant): `0xffaa00`, `0xff8800`, `0xffcc44`, `0xff4400` — attacks, explosions, zone warnings, active items
- **Blue family** (secondary): `0x4488ff`, `0x88bbff` — dash, barrier, shield effects
- **Green family**: `0x44ff44`, `0x37d98c`, `0x44ffaa` — health, fresh spawn, pickups
- **Gold**: `0xffd700` — chests, tier 3 weapons, 1st place
- **Neutral**: `0x333333`-`0x888888` — backgrounds, inactive states
- **Red/danger**: `0xff4444`, `0xff0000` — zone damage, low health, siege

## Decision

UI palette derives directly from gameplay colors. No new colors introduced.

| Token | Color | Source |
|-------|-------|--------|
| `paper` | `0xf5f0e8` | New — cream paper background |
| `ink` | `0x2d2d2d` | Aligned with existing `0x333333` dark tones |
| `accent` | `0xffaa00` | Existing — amber (most-used gameplay color) |
| `accentWarm` | `0xff8800` | Existing — warm orange (attacks, highlights) |
| `destructive` | `0xff4444` | Existing — damage/low health |
| `positive` | `0x44ff44` | Existing — health/pickups |
| `info` | `0x4488ff` | Existing — dash/shield blue |
| `gold` | `0xffd700` | Existing — rewards/1st place |
| `muted` | `0x888888` | Existing — inactive states |
| `surface` | `0xeeeeee` | New — panel/card background |
| `surfaceDark` | `0x333333` | Existing — dark panel backgrounds |

## Consequences

- Menus and gameplay share one visual language
- Player transitions seamlessly from menu to game — no palette shock
- New paper/surface colors are neutral enough to frame the warm gameplay palette without competing
