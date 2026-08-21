import type Phaser from 'phaser';
import {
  SECTOR_IDENTITY,
  SECTOR_TILE_SIZE,
  fieldTileAlpha,
  type GatewayDressing,
  type SectorType,
  type VisualIdentityAssignment,
} from '@sector-battle/shared';

/**
 * Visual-identity baking (map-redesign ticket 07 / DEC-006 — Wei's contract:
 * bake-time only, zero per-frame cost, zero new render textures).
 *
 * Draws the server-authored identity data into the EXISTING static layers at
 * map load, immediately after their sprites are baked:
 *
 *   1. FLOOR TINT FIELDS — 2–3 seeded macro blobs per sector (base wash ±
 *      wear ring near doors, stain near hazard clusters) painted as soft
 *      translucent tile fills into the FLOOR render texture. Borders are
 *      jittered ±1 tile via the shared position hash (`fieldTileAlpha`), so
 *      biome seams read hand-painted, never as straight debug lines. The
 *      floor layer sits beneath the decoration/wall/interactive layers, so
 *      the fields can never touch collision or entity reads.
 *   2. GATEWAY LERP BANDS — a threshold strip across every sector corridor
 *      opening where the two districts' floor tints lerp into each other,
 *      also into the floor texture. VISUAL-ONLY: the corridor geometry (one
 *      3-tile opening per shared interior edge) is untouched.
 *   3. GATEWAY FRAME COMPOSITIONS — the visual-only arch/door-frame from
 *      existing `game`-atlas frames into the DECORATION texture (the same
 *      layer the landmark composites bake into). Each opening gets: a neutral
 *      arch on the seam, a BRACKET PAIR mounted beneath the two REAL doorway
 *      sconce lights (map-polish ticket 11 — the server's ticket-10 band-end
 *      pair, one bracket per light at each end of the opening band; the
 *      brackets are baked visual wall-mounts, the lights stay server
 *      placements), and an entering-shot accent prop on the side that
 *      frames the hero landmark (`alignedA`/`alignedB` — "where the seed
 *      allows").
 *
 * No-op when identity data is absent (demo-TMX maps) — never throws on art.
 */

/** Lerp-band overlay strength (soft, translucent — reads as a threshold). */
const GATEWAY_BAND_ALPHA = 0.3;
/** Band half-extent along the crossing axis, each side of the seam (tiles). */
const GATEWAY_BAND_DEPTH = 2;
/** Band half-width across the opening (3-tile opening + 1 shoulder per side). */
const GATEWAY_BAND_HALF_WIDTH = 2;

/**
 * Bracket-mount offset from the aperture centerline along the opening axis
 * (tiles) — the client mirror of the server's `DOORWAY_PAIR_BAND_END_OFFSET`
 * (`lightHierarchyConfig.ts`): the band-end tiles are the opening-band center
 * ±1, one mount per real ticket-10 doorway sconce.
 */
const GATEWAY_BRACKET_BAND_END_OFFSET = 1;
/** Entering-shot accent offset (tiles, perpendicular to travel). */
const GATEWAY_ACCENT_OFFSET = 2.4;

/** Linear blend between two packed 0xRRGGBB colours (t in [0,1]). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const r = Math.round(ar + (((b >> 16) & 0xff) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 0xff) - ag) * t);
  const bl = Math.round(ab + ((b & 0xff) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * Bake every floor tint field + gateway lerp band into the FLOOR render
 * texture (called once at map load, right after the floor layer's sprites).
 */
export function bakeFloorIdentity(
  scene: Phaser.Scene,
  floorRT: Phaser.GameObjects.RenderTexture | null,
  identity: VisualIdentityAssignment | null | undefined,
  tileSize: number,
): void {
  if (!floorRT || !identity) return;
  const g = scene.add.graphics();

  // 1. Floor tint fields — soft macro blobs, jittered borders (shared math).
  for (let sRow = 0; sRow < identity.fields.length; sRow++) {
    const rowFields = identity.fields[sRow];
    if (!rowFields) continue;
    for (let sCol = 0; sCol < rowFields.length; sCol++) {
      for (const field of rowFields[sCol] ?? []) {
        const baseX = sCol * SECTOR_TILE_SIZE;
        const baseY = sRow * SECTOR_TILE_SIZE;
        for (let ly = 0; ly < SECTOR_TILE_SIZE; ly++) {
          for (let lx = 0; lx < SECTOR_TILE_SIZE; lx++) {
            const alpha = fieldTileAlpha(field, lx, ly);
            if (alpha <= 0.004) continue; // sub-1% alpha is invisible — skip
            g.fillStyle(field.tint, alpha);
            g.fillRect((baseX + lx) * tileSize, (baseY + ly) * tileSize, tileSize, tileSize);
          }
        }
      }
    }
  }

  // 2. Gateway lerp bands — the threshold strip at every corridor opening.
  for (const gw of identity.gateways) {
    bakeGatewayBand(g, gw, tileSize);
  }

  floorRT.draw(g);
  floorRT.render();
  g.destroy();
}

/** One gateway lerp-band tile: position + lerp parameter + shoulder falloff. */
export interface GatewayBandTile {
  x: number;
  y: number;
  /** Lerp parameter across the seam: 0 at A's outer edge → 1 at B's. */
  t: number;
  /** Shoulder falloff: 1 across the opening center, 0 at the band's edges. */
  falloff: number;
}

/**
 * Enumerate one gateway's lerp-band tiles (PURE — unit-tested): the strip
 * runs `GATEWAY_BAND_DEPTH` tiles into each sector along the CROSSING axis
 * (h-connections cross x, v-connections cross y) and spans the 3-tile
 * opening + one shoulder tile per side. VISUAL-ONLY data — the corridor
 * geometry itself is untouched.
 */
export function gatewayBandTiles(gw: GatewayDressing): GatewayBandTile[] {
  const tiles: GatewayBandTile[] = [];
  const crossMid = gw.axis === 'h' ? gw.midX : gw.midY;
  const crossMin = Math.floor(crossMid) - GATEWAY_BAND_DEPTH;
  const crossMax = Math.floor(crossMid) + GATEWAY_BAND_DEPTH + 1; // exclusive
  const span = crossMax - crossMin; // 2*DEPTH + 1 tiles across the seam
  const widthMid = gw.axis === 'h' ? gw.midY : gw.midX;
  for (let cross = crossMin; cross < crossMax; cross++) {
    const t = (cross + 0.5 - crossMin) / span;
    for (let w = -GATEWAY_BAND_HALF_WIDTH; w <= GATEWAY_BAND_HALF_WIDTH; w++) {
      const across = w; // offset from the opening center along the width axis
      const falloff = Math.max(0, 1 - Math.abs(across) / (GATEWAY_BAND_HALF_WIDTH + 1));
      tiles.push({
        x: gw.axis === 'h' ? cross : Math.floor(widthMid) + w,
        y: gw.axis === 'h' ? Math.floor(widthMid) + w : cross,
        t,
        falloff,
      });
    }
  }
  return tiles;
}

/**
 * One gateway's two bracket MOUNT tiles (PURE — unit-tested): the band-end
 * tiles of the opening band, i.e. exactly beneath the two REAL doorway
 * sconces the server places there (map-polish ticket 10). This is the SAME
 * band-end geometry the server derives in `LightPlacerDoorway.doorwayPairGeometry`
 * (the `positionA` tile shifted `(width−1)/2` along the opening axis, then ±
 * the band-end offset — both members on sector A's threshold face),
 * re-expressed here from the dressing record's own `midX/midY/axis` so the
 * client bake and the server placement cannot drift:
 *
 *   h (band spans rows, seam is a vertical line): `midX` is the x.5 seam and
 *      `midY` the integer band-center row → mounts `(floor(midX), midY ∓ 1)`;
 *   v (band spans cols, seam is a horizontal line): mounts `(midX ∓ 1, floor(midY))`.
 *
 * Determinism (ADR-0035): zero RNG — a pure projection of `GatewayDressing`
 * alone, NEVER of the `lightPlacements` list (the bake stays an identity
 * projection). Consequence, accepted: at a rare fallback-degraded aperture
 * (blocked band ends — the seed-0xdeadbeef single-sconce mouth) the real
 * sconce may sit one ladder rung off its band end while the bracket keeps
 * the band-end mount; a wall-mount does not chase server light data.
 *
 * Returns opening-axis ascending `[mountA, mountB]` — the draw positions for
 * bracketA (sector A's sheet) and bracketB (sector B's sheet) respectively.
 */
export function gatewayBracketTiles(
  gw: GatewayDressing,
): [{ x: number; y: number }, { x: number; y: number }] {
  if (gw.axis === 'h') {
    const seamCol = Math.floor(gw.midX); // sector A's border column
    return [
      { x: seamCol, y: gw.midY - GATEWAY_BRACKET_BAND_END_OFFSET },
      { x: seamCol, y: gw.midY + GATEWAY_BRACKET_BAND_END_OFFSET },
    ];
  }
  const seamRow = Math.floor(gw.midY); // sector A's border row
  return [
    { x: gw.midX - GATEWAY_BRACKET_BAND_END_OFFSET, y: seamRow },
    { x: gw.midX + GATEWAY_BRACKET_BAND_END_OFFSET, y: seamRow },
  ];
}

/** One gateway's lerp band: tintA → tintB across the seam, fading shoulders. */
function bakeGatewayBand(
  g: Phaser.GameObjects.Graphics,
  gw: GatewayDressing,
  tileSize: number,
): void {
  for (const tile of gatewayBandTiles(gw)) {
    if (tile.x < 0 || tile.y < 0) continue;
    const alpha = GATEWAY_BAND_ALPHA * tile.falloff;
    if (alpha <= 0.004) continue;
    g.fillStyle(lerpColor(gw.tintA, gw.tintB, tile.t), alpha);
    g.fillRect(tile.x * tileSize, tile.y * tileSize, tileSize, tileSize);
  }
}

/**
 * Bake every gateway's visual-only frame composition (arch + sconce-bracket
 * pair + entering-shot accent) into the DECORATION render texture (above
 * floor, below walls — the landmark-composite layer). Best-effort per frame:
 * a missing atlas frame skips that part, never throws.
 */
export function bakeGatewayFrames(
  scene: Phaser.Scene,
  decorationRT: Phaser.GameObjects.RenderTexture | null,
  identity: VisualIdentityAssignment | null | undefined,
  sectorTypes: readonly (readonly SectorType[])[] | null | undefined,
  tileSize: number,
): void {
  if (!decorationRT || !identity) return;
  const gameAtlas = scene.textures.get('game');

  const tempSprites: Phaser.GameObjects.Sprite[] = [];
  const drawPart = (
    frame: string,
    worldX: number,
    worldY: number,
    tint: number,
    displaySize: number,
  ): void => {
    if (!gameAtlas || !gameAtlas.has(frame)) return; // never throw on art
    const sprite = scene.add
      .sprite(worldX, worldY, 'game', frame)
      .setOrigin(0.5)
      .setDisplaySize(displaySize, displaySize)
      .setTint(tint);
    decorationRT.draw(sprite);
    tempSprites.push(sprite);
  };

  for (const gw of identity.gateways) {
    const typeA = sectorTypes?.[gw.sectorA.row]?.[gw.sectorA.col];
    const typeB = sectorTypes?.[gw.sectorB.row]?.[gw.sectorB.col];
    const sheetA = typeA ? SECTOR_IDENTITY[typeA] : undefined;
    const sheetB = typeB ? SECTOR_IDENTITY[typeB] : undefined;
    const midPxX = (gw.midX + 0.5) * tileSize;
    const midPxY = (gw.midY + 0.5) * tileSize;
    // Unit vectors: `travel` = the crossing axis; `perp` = along the opening.
    const travelX = gw.axis === 'h' ? 1 : 0;
    const travelY = gw.axis === 'h' ? 0 : 1;
    const perpX = gw.axis === 'h' ? 0 : 1;
    const perpY = gw.axis === 'h' ? 1 : 0;

    // The arch: neutral stone frame on the seam (district-free at the border).
    const archSheet = sheetA ?? sheetB;
    if (archSheet) {
      drawPart(archSheet.gateway.archFrame, midPxX, midPxY, archSheet.gateway.archTint, tileSize);
    }

    // The sconce PAIR (map-polish ticket 11): one baked bracket mounted
    // beneath EACH of the two real ticket-10 doorway sconces — the band-end
    // tiles of the opening (see {@link gatewayBracketTiles}), not the old
    // travel-axis ±1.8 flanks at the band center. Each bracket keeps its own
    // side's district sheet + wall tint (identity meets identity at the
    // seam); both mounts sit on the threshold face where the lights are.
    const [bracketTileA, bracketTileB] = gatewayBracketTiles(gw);
    const bracketA = sheetA?.gateway.bracketFrame;
    const bracketB = sheetB?.gateway.bracketFrame;
    const bracketSize = tileSize * 0.9;
    if (bracketA) {
      drawPart(
        bracketA,
        (bracketTileA.x + 0.5) * tileSize,
        (bracketTileA.y + 0.5) * tileSize,
        sheetA!.wallTint,
        bracketSize,
      );
    }
    if (bracketB) {
      drawPart(
        bracketB,
        (bracketTileB.x + 0.5) * tileSize,
        (bracketTileB.y + 0.5) * tileSize,
        sheetB!.wallTint,
        bracketSize,
      );
    }

    // The entering-shot accent (DEC-006 #5): on the aligned side, an accent
    // prop biased toward the hero landmark — the frame leans toward where
    // the entering sightline points ("where the seed allows").
    const drawAccent = (
      sheet: typeof sheetA,
      hero: { x: number; y: number } | null,
      aligned: boolean,
      dir: -1 | 1,
    ): void => {
      if (!sheet || !aligned || !hero) return;
      // Perpendicular sign toward the hero (the leaning side of the frame).
      const perp = gw.axis === 'h' ? hero.y - gw.midY : hero.x - gw.midX;
      const side = perp >= 0 ? 1 : -1;
      drawPart(
        sheet.gateway.accentFrame,
        midPxX + perpX * side * GATEWAY_ACCENT_OFFSET * tileSize + travelX * dir * 0.5 * tileSize,
        midPxY + perpY * side * GATEWAY_ACCENT_OFFSET * tileSize + travelY * dir * 0.5 * tileSize,
        sheet.wallTint,
        tileSize * 0.75,
      );
    };
    drawAccent(sheetA, gw.heroA, gw.alignedA, -1);
    drawAccent(sheetB, gw.heroB, gw.alignedB, 1);
  }

  decorationRT.render();
  for (const s of tempSprites) s.destroy();
}
