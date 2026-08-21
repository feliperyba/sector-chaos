/**
 * Input-prompt atlas generator — packs the Kenney "Keyboard & Mouse" input
 * prompt PNGs used by the settings controls guide (plus any future prompt
 * surface) into ONE Phaser multipack atlas (`public/assets/prompts.png` +
 * `prompts.json`), the same atlas shape as `game`/`ui`/`vfx` so
 * `loadAtlases()` picks it up with zero extra load code.
 *
 * Source art lives OUTSIDE the repo (the shared Kenney asset drop), resolved
 * in this order:
 *   1. `SECTO_INPUT_PROMPTS_SRC` env var (portable/CI override)
 *   2. The default Kenney "Input Prompts / Keyboard & Mouse / Default" folder
 *
 * The generated `prompts.png`/`prompts.json` ARE committed (same convention as
 * `ui.png`/`ui.json`) — this script is the regeneration path, not a build step.
 *
 * Re-run after changing SPRITES:
 *
 *     pnpm --filter @sector-battle/client-v3 run build:input-prompts
 *
 * Frame keys are the Kenney filenames sans extension (`keyboard_w`,
 * `mouse_left`, …) — reference at use sites via
 * `add.image(x, y, 'prompts', 'keyboard_w')`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// From scripts/asset-pipeline/, two levels up lands at the repo root.
// Resolved relative to __dirname so the script is robust to invocation cwd.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'packages/client-v3/public/assets');
const OUT_PNG = path.join(OUT_DIR, 'prompts.png');
const OUT_JSON = path.join(OUT_DIR, 'prompts.json');

const DEFAULT_SOURCE = path.join(
  'C:',
  'Users',
  'Felip',
  'Projects',
  'gamedev',
  'assets',
  'Kenney Game Assets All-in-1 3.3.0',
  'Icons',
  'Input Prompts',
  'Keyboard & Mouse',
  'Default',
);

/**
 * The prompt set actually consumed by the client (settings controls guide).
 * Keep this list in sync with `SettingsControlsData.ts` frame references.
 */
const SPRITES = [
  'keyboard_w',
  'keyboard_a',
  'keyboard_s',
  'keyboard_d',
  'keyboard_e',
  'keyboard_space',
  'keyboard_1',
  'keyboard_2',
  'keyboard_3',
  'keyboard_4',
  'mouse',
  'mouse_left',
  'mouse_right',
  'mouse_scroll',
] as const;

/** Kenney prompt PNGs are uniform 64x64; 8px cell padding guards edge bleed. */
const CELL = 72;
const CELL_PAD = 8;
const COLS = 7;

interface AtlasFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  sourceSize: { w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
}

async function main(): Promise<void> {
  const sourceDir = process.env.SECTO_INPUT_PROMPTS_SRC ?? DEFAULT_SOURCE;

  const missing: string[] = [];
  for (const name of SPRITES) {
    try {
      await fs.access(path.join(sourceDir, `${name}.png`));
    } catch {
      missing.push(`${name}.png`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} source prompt(s) in "${sourceDir}": ${missing.join(', ')}. ` +
        'Set SECTO_INPUT_PROMPTS_SRC to the Kenney "Input Prompts/Keyboard & Mouse/Default" folder.',
    );
  }

  const rows = Math.ceil(SPRITES.length / COLS);
  const atlasW = COLS * CELL;
  const atlasH = rows * CELL;

  const frames: AtlasFrame[] = [];
  const compositeOps: sharp.OverlayOptions[] = [];
  for (let i = 0; i < SPRITES.length; i++) {
    const name = SPRITES[i]!;
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = col * CELL + CELL_PAD;
    const y = row * CELL + CELL_PAD;
    compositeOps.push({ input: path.join(sourceDir, `${name}.png`), left: x, top: y });
    frames.push({
      filename: name,
      frame: { x, y, w: 64, h: 64 },
      rotated: false,
      trimmed: false,
      sourceSize: { w: 64, h: 64 },
      spriteSourceSize: { x: 0, y: 0, w: 64, h: 64 },
    });
  }

  await sharp({
    create: {
      width: atlasW,
      height: atlasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeOps)
    .png()
    .toFile(OUT_PNG);

  // Phaser multipack atlas shape — the same structure as ui.json/game.json so
  // AssetManifest.loadAtlases() can load it via scene.load.multiatlas().
  const manifest = {
    textures: [{ image: path.basename(OUT_PNG), frames }],
    meta: { app: 'secto-chaos-neo/build-input-prompts', version: '1.0' },
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`[input-prompts] ${SPRITES.length} sprites → ${path.relative(REPO_ROOT, OUT_PNG)}`);
  console.log(`[input-prompts] atlas manifest → ${path.relative(REPO_ROOT, OUT_JSON)}`);
}

main().catch((err: unknown) => {
  console.error('[input-prompts] Failed:', err);
  process.exit(1);
});
