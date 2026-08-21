/**
 * Derive the NEUTRAL biome-crystal frames from the existing blue `biome-glow`
 * frames and append them into the `lightProps` atlas (PNG + JSON).
 *
 * WHY: the menu diorama's per-variant crystals (`forest` emerald, `crypt`
 * violet, …) share ONE neutral crystal frame + a per-placement `color` tint
 * (`LightPropRenderer.spawn` → `setTint`). The shipped `biome-glow_01/02` frames
 * are painted cool-blue, so tinting them multiplies into a muddy hue. This
 * script desaturates a COPY of those frames to a near-white crystal that tints
 * vividly to any hue, then writes the two new frames (`biome-crystal_01/02`)
 * onto a FRESH grid row of the atlas. The original blue frames stay intact for
 * untinted in-game biome-glow.
 *
 * Slot allocation (the overlap BUGFIX): the target row is computed from the
 * atlas's MAX occupied grid row + 1, and the canvas is grown to fit. The
 * previous version hardcoded slots at y=400 which COLLIDED with `lantern_06`
 * (same rect) — corrupting the lantern's 6th flicker frame. Computing the next
 * free row guarantees the crystals never land on an existing frame, regardless
 * of how many rows the base generators produce.
 *
 * Idempotent: if `biome-crystal_01` is already in the atlas JSON, it exits
 * without changes. Run via: `npx tsx scripts/asset-pipeline/build-neutral-crystal.ts`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const ATLAS_DIR = path.join(ROOT, 'packages', 'client-v3', 'public', 'assets');
const PNG_PATH = path.join(ATLAS_DIR, 'light_props.png');
const JSON_PATH = path.join(ATLAS_DIR, 'light_props.json');

// Grid layout — must match the Python generators (generate_light_props.py).
const SIZE = 128;
const PAD = 4;
const STRIDE = SIZE + PAD; // 132

const SOURCE_FRAMES = ['biome-glow_01'];
const NEW_FRAMES = ['biome-crystal_01'];

interface AtlasFrame {
  filename: string;
  rotated: boolean;
  trimmed: boolean;
  sourceSize: { w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  frame: { x: number; y: number; w: number; h: number };
}
interface AtlasJson {
  textures: { image: string; format: string; size: { w: number; h: number }; scale: number; frames: AtlasFrame[] }[];
}

/** Desaturate a 128×128 RGBA region toward a near-white crystal that STILL
 *  keeps its dark outline (alpha preserved). Dark pixels (the pixel-art outline)
 *  stay dark so the neutral frame reads as outlined pixel art, not a shapeless
 *  blob; mid/light pixels (the crystal facets) lift toward white so a per-placement
 *  `color` tint reads vividly. */
async function neutralize(region: sharp.Sharp): Promise<Buffer> {
  const { data, info } = await region.clone().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    if (a === 0) continue;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let v: number;
    if (lum < 50) {
      // outline / very dark → keep dark (preserve the pixel-art outline).
      v = Math.min(40, Math.round(lum * 0.5));
    } else {
      // facet → lift toward white (tints vividly via setTint).
      v = Math.min(255, Math.round(lum * 0.6 + 110));
    }
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    // alpha unchanged
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const jsonRaw = await fs.readFile(JSON_PATH, 'utf8');
  const atlas: AtlasJson = JSON.parse(jsonRaw);
  const tex = atlas.textures[0];
  if (!tex) throw new Error('build-neutral-crystal: atlas has no texture entry');

  const existing = new Set(tex.frames.map((f) => f.filename));
  if (existing.has(NEW_FRAMES[0]!)) {
    console.log(`[build-neutral-crystal] '${NEW_FRAMES[0]}' already present — nothing to do.`);
    return;
  }

  // Resolve the source frame coords from the JSON (don't hardcode — stay in sync).
  const srcFrames = SOURCE_FRAMES.map((name) => {
    const f = tex.frames.find((x) => x.filename === name);
    if (!f) throw new Error(`build-neutral-crystal: source frame '${name}' missing from atlas`);
    return f;
  });

  // Compute the FRESH target row = max occupied grid row + 1 (the next free row).
  // grid row of a frame = (frame.y - PAD) / STRIDE. Placing the crystals on a
  // brand-new row guarantees they never overlap an existing frame (the bug that
  // previously clobbered lantern_06).
  let maxRow = -1;
  for (const f of tex.frames) {
    const row = Math.round((f.frame.y - PAD) / STRIDE);
    if (row > maxRow) maxRow = row;
  }
  const targetRow = maxRow + 1;
  const targetY = PAD + targetRow * STRIDE;
  const targetXs = [PAD + 0 * STRIDE, PAD + 1 * STRIDE]; // cols 0 + 1 of the new row

  // Canvas size needed to hold the new row (width unchanged; grow height).
  const meta = await sharp(PNG_PATH).metadata();
  const curW = meta.width ?? 1024;
  const curH = meta.height ?? 0;
  const neededH = targetY + SIZE + PAD;
  const outW = curW;
  const outH = Math.max(curH, neededH);

  // Extend the canvas: flatten existing pixels onto a transparent sheet of the
  // new size, then composite the two neutral frames onto the fresh row.
  const composites: { input: Buffer; left: number; top: number }[] = [];
  if (outH > curH) {
    // A fully-transparent base the size of the grown canvas, then the existing
    // atlas pasted at (0,0) so all prior frames keep their coords.
    const transparent = await sharp({
      create: { width: outW, height: outH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    composites.push({ input: transparent, left: 0, top: 0 });
    const existingPng = await sharp(PNG_PATH).png().toBuffer();
    composites.push({ input: existingPng, left: 0, top: 0 });
  }

  for (let i = 0; i < srcFrames.length; i++) {
    const src = srcFrames[i]!;
    const region = sharp(PNG_PATH).extract({
      left: src.frame.x,
      top: src.frame.y,
      width: src.frame.w,
      height: src.frame.h,
    });
    const neutralPng = await neutralize(region);
    composites.push({ input: neutralPng, left: targetXs[i]!, top: targetY });
    tex.frames.push({
      filename: NEW_FRAMES[i]!,
      rotated: false,
      trimmed: false,
      sourceSize: { w: SIZE, h: SIZE },
      spriteSourceSize: { x: 0, y: 0, w: SIZE, h: SIZE },
      frame: { x: targetXs[i]!, y: targetY, w: SIZE, h: SIZE },
    });
    console.log(`[build-neutral-crystal] derived ${NEW_FRAMES[i]} ← ${src.filename} → slot (row ${targetRow}, ${targetXs[i]},${targetY})`);
  }

  tex.size.w = outW;
  tex.size.h = outH;

  const outPng = await sharp({ create: { width: outW, height: outH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png()
    .toBuffer();
  await fs.writeFile(PNG_PATH, outPng);
  await fs.writeFile(JSON_PATH, JSON.stringify(atlas, null, 2) + '\n', 'utf8');
  console.log(`[build-neutral-crystal] wrote ${srcFrames.length} frames → light_props.{png,json} (sheet ${outW}x${outH})`);
}

main().catch((err: unknown) => {
  console.error('[build-neutral-crystal] FAILED:', err);
  process.exit(1);
});
