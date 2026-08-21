/**
 * Audio spritesheet generator (bootstrap tool).
 *
 * Originally walked `packages/client-v3/public/assets/audio`, concatenated
 * every source `.ogg` into ONE sprite sheet, and emitted a Phaser-compatible
 * audio-sprite JSON manifest (the tonistiigi/audiosprite format — see
 * https://github.com/tonistiigi/audiosprite and Phaser's
 * `scene.load.audioSprite(key, jsonURL, [audioURL])`).
 *
 * NOTE: The 53 individual source files were deleted from the repo after the
 * sprite sheet was generated — the sprite sheet IS the audio asset now. This
 * script is retained as a regeneration path: if you need to rebuild the sheet
 * (e.g. to add new clips), drop the source files back into
 * `packages/client-v3/public/assets/audio/` (any subfolder layout works) and
 * re-run:
 *
 *     pnpm --filter @sector-battle/client-v3 run build:audio-sprite
 *
 * The marker for each clip is derived from its file path, made unique by
 * suffixing `_<index>` whenever two paths share the same stem. The companion
 * TypeScript file `audio-sprite-markers.ts` (next to the client manifest)
 * exports the typed marker names AND, crucially, the `sfx_key → [marker]`,
 * `music_key → marker`, and `voiceover_key → marker` maps derived from
 * AssetManifest.ts — so the runtime can keep its randomised-variant playback
 * without hardcoding any marker string.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// From scripts/asset-pipeline/, two levels up lands at the repo root
// (secto-chaos-neo). We resolve once relative to __dirname rather than
// process.cwd() so the script is robust to being invoked from anywhere.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIO_ROOT = path.join(REPO_ROOT, 'packages/client-v3/public/assets/audio');
const OUT_DIR = path.join(AUDIO_ROOT, 'spritesheet');
const OUT_OGG = path.join(OUT_DIR, 'audiosprite.ogg');
const OUT_JSON = path.join(OUT_DIR, 'audiosprite.json');
const OUT_TS = path.join(REPO_ROOT, 'packages/client-v3/src/assets/audio-sprite-markers.ts');
const MANIFEST_SRC = path.join(REPO_ROOT, 'packages/client-v3/src/assets/AssetManifest.ts');

/**
 * Phaser audio-sprite manifest shape. NOTE: Phaser reads `.spritemap` (NOT
 * `spritemeta` which the tonistiigi/audiosprite CLI tool emits) — see
 * Phaser's `BaseSoundManager.addAudioSprite` which does
 * `this.jsonCache.get(key).spritemap`. The `resources` array lists the audio
 * file path(s) relative to the public root (NOT relative to the JSON file),
 * so Phaser's loader can fetch them.
 */
interface AudioSpriteManifest {
  resources: string[];
  spritemap: Record<string, { start: number; end: number; loop: boolean }>;
}

function stemToMarker(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function resolveFfmpegBin(tool: 'ffmpeg' | 'ffprobe'): Promise<string> {
  if (tool === 'ffmpeg') {
    try {
      const ffmpegStatic = (await import('ffmpeg-static')).default as unknown;
      if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
        try {
          await fs.access(ffmpegStatic, fsConstants.X_OK);
          return ffmpegStatic;
        } catch {
          // fall through to PATH
        }
      }
    } catch {
      // ffmpeg-static not installed in this environment — use PATH.
    }
  }
  return tool;
}

async function probeDuration(ffprobeBin: string, file: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobeBin,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      file,
    ],
    { timeout: 15000 },
  );
  const value = parseFloat(stdout.trim());
  if (!Number.isFinite(value)) {
    throw new Error(`ffprobe returned non-numeric duration for ${file}`);
  }
  return value;
}

async function walkAudio(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (path.resolve(full) === path.resolve(OUT_DIR)) continue;
        await recurse(full);
      } else if (stat.isFile()) {
        const lower = entry.toLowerCase();
        if (
          lower.endsWith('.ogg') ||
          lower.endsWith('.mp3') ||
          lower.endsWith('.m4a') ||
          lower.endsWith('.wav')
        ) {
          out.push(full);
        }
      }
    }
  }
  await recurse(root);
  return out.sort();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Parse AssetManifest.ts to extract the `sfx`/`music`/`voiceover` literal
 * blocks. We only need the literal paths so we can map an `audioKey` to the
 * list of clip files backing it (and thus to markers). We do NOT execute the
 * module — a regex-based extraction keeps the generator independent of any
 * project TS toolchain configuration.
 */
interface ManifestAudioKeys {
  sfx: Record<string, string[]>;
  music: Record<string, string>;
  voiceover: Record<string, string>;
}

function extractManifestAudio(src: string): ManifestAudioKeys {
  // Grab the section between `sfx: {` … the matching close-brace before the
  // next top-level manifest key. Each top-level block is `key: { ... },` —
  // we slice generously and parse.
  const result: ManifestAudioKeys = { sfx: {}, music: {}, voiceover: {} };

  // sfx values are arrays of quoted paths.
  const sfxBlock = sliceBlock(src, /^\s*sfx:\s*\{/m);
  if (sfxBlock) {
    // Each line like: `hit_melee: ['...', '...', '...',],`
    const re = /^\s*([a-zA-Z0-9_]+)\s*:\s*\[([\s\S]*?)\],?\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sfxBlock)) !== null) {
      const key = m[1]!;
      const inner = m[2]!;
      const paths = [...inner.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
      if (paths.length > 0) result.sfx[key] = paths;
    }
  }

  // music + voiceover values are single quoted paths.
  for (const blockName of ['music', 'voiceover'] as const) {
    const block = sliceBlock(src, new RegExp(`^\\s*${blockName}:\\s*\\{`, 'm'));
    if (!block) continue;
    const re = /^\s*([a-zA-Z0-9_]+)\s*:\s*'([^']+)'\s*,?\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      result[blockName][m[1]!] = m[2]!;
    }
  }

  return result;
}

/** Returns the inner text of a `{ ... }` block whose opening line matches. */
function sliceBlock(src: string, openRe: RegExp): string | null {
  const open = openRe.exec(src);
  if (!open) return null;
  let i = open.index! + open[0].length;
  let depth = 1;
  let out = '';
  while (i < src.length && depth > 0) {
    const ch = src[i]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
    i++;
  }
  return out;
}

function relToAudioRoot(absPath: string): string {
  const rel = path.relative(AUDIO_ROOT, absPath).replace(/\\/g, '/');
  return `assets/audio/${rel}`;
}

async function main(): Promise<void> {
  console.log('▶ Audio spritesheet generator');
  console.log(`  Source: ${AUDIO_ROOT}`);

  const ffmpegBin = await resolveFfmpegBin('ffmpeg');
  const ffprobeBin = await resolveFfmpegBin('ffprobe');
  console.log(`  ffmpeg:  ${ffmpegBin}`);
  console.log(`  ffprobe: ${ffprobeBin}`);

  const manifestSrc = await fs.readFile(MANIFEST_SRC, 'utf-8');
  const manifestKeys = extractManifestAudio(manifestSrc);

  const files = await walkAudio(AUDIO_ROOT);
  if (files.length === 0) {
    console.error(`✗ No audio files found under ${AUDIO_ROOT}`);
    process.exit(1);
  }
  console.log(`  Found ${files.length} source audio file(s)`);

  // 1. Probe each clip's duration and assign a unique marker name.
  //    The concat order is sorted-alphabetical — deterministic across runs.
  //    IMPORTANT: durations must be measured on lossless PCM (WAV) decodes,
  //    not the source OGGs — Vorbis container timestamps drift across a
  //    concat and the browser's Web Audio decodeAudioData rejects the
  //    resulting non-monotonic-DTS stream (Phaser surfaces this as
  //    "Unable to decode audio data"). We decode each source to a temp WAV
  //    first, probe the WAV for a frame-accurate duration, then concat the
  //    WAVs (PCM has no codec timestamps to corrupt).
  await fs.mkdir(OUT_DIR, { recursive: true });
  const tmpDir = path.join(OUT_DIR, '_tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  const clips: {
    file: string;
    relPath: string;
    marker: string;
    wavFile: string;
    duration: number;
  }[] = [];
  const usedMarkers = new Set<string>();
  console.log(`▶ Decoding ${files.length} clips to lossless WAV…`);
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi]!;
    const wavFile = path.join(tmpDir, `clip_${String(fi).padStart(3, '0')}.wav`);
    await execFileAsync(
      ffmpegBin,
      ['-y', '-v', 'error', '-i', file, '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', wavFile],
      { timeout: 30000 },
    );
    const duration = await probeDuration(ffprobeBin, wavFile);
    const baseMarker = stemToMarker(file);
    let marker = baseMarker;
    let idx = 1;
    while (usedMarkers.has(marker)) {
      marker = `${baseMarker}_${idx}`;
      idx++;
    }
    usedMarkers.add(marker);
    clips.push({ file, relPath: relToAudioRoot(file), marker, wavFile, duration });
  }
  const clipByPath = new Map<string, (typeof clips)[number]>();
  for (const c of clips) clipByPath.set(c.relPath, c);

  // 2. Concatenate the WAV files via the ffmpeg `concat` FILTER. Because the
  //    inputs are now uniform PCM (same sample rate, channels, bit depth), the
  //    filter concatenates them sample-accurately with no codec timestamp
  //    issues. Output is also WAV at this stage.
  const concatWav = path.join(tmpDir, '_concat.wav');
  console.log(`▶ Concatenating ${clips.length} clips…`);
  const inputArgs = clips.flatMap((c) => ['-i', c.wavFile]);
  const filterInputs = clips.map((_, i) => `[${i}:a]`).join('');
  const filterChain = `${filterInputs}concat=n=${clips.length}:v=0:a=1[out]`;
  await execFileAsync(
    ffmpegBin,
    [
      '-y',
      '-v',
      'error',
      ...inputArgs,
      '-filter_complex',
      filterChain,
      '-map',
      '[out]',
      '-c:a',
      'pcm_s16le',
      concatWav,
    ],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
  );

  // 3. Encode the concatenated WAV to the final Ogg/Vorbis. Encoding from a
  //    single clean PCM source reconstructs all container timestamps from
  //    scratch — no non-monotonic-DTS drift for the browser to reject.
  console.log(`▶ Encoding ${path.basename(OUT_OGG)}…`);
  await execFileAsync(
    ffmpegBin,
    ['-y', '-v', 'error', '-i', concatWav, '-c:a', 'libvorbis', '-q:a', '4', OUT_OGG],
    { timeout: 120000 },
  );

  // 3. Verify total duration vs sum of per-clip durations (concat encoders
  //    introduce small per-segment rounding).
  const totalDuration = await probeDuration(ffprobeBin, OUT_OGG);
  const expectedTotal = clips.reduce((sum, c) => sum + c.duration, 0);
  const drift = Math.abs(totalDuration - expectedTotal);
  if (drift > 0.05) {
    console.warn(
      `⚠ Concat duration drift: measured ${totalDuration}s vs expected ${expectedTotal}s (drift ${drift}s). Marker offsets may be off.`,
    );
  }

  // 4. Marker offsets by accumulating per-clip durations.
  const spritemap: AudioSpriteManifest['spritemap'] = {};
  let offset = 0;
  for (const c of clips) {
    spritemap[c.marker] = {
      start: Number(offset.toFixed(4)),
      end: Number((offset + c.duration).toFixed(4)),
      loop: false,
    };
    offset += c.duration;
  }

  // 5. Emit the Phaser audio-sprite JSON. `resources` must be the audio path
  //    relative to the public root (the dir the HTML is served from), NOT
  //    relative to this JSON file — Phaser's loader resolves it against the
  //    page origin + loader path, not the JSON's location.
  const manifest: AudioSpriteManifest = {
    resources: ['assets/audio/spritesheet/audiosprite.ogg'],
    spritemap,
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(manifest, null, 2), 'utf-8');

  // 6. Build audioKey → marker[] maps from AssetManifest, mapping each
  //    manifest path to its marker via clipByPath. Any path in the manifest
  //    that has no backing file on disk is flagged loudly so the operator
  //    can decide whether to delete the manifest entry or restore the file.
  const sfxMap: Record<string, string[]> = {};
  let missingManifestPaths = 0;
  for (const [key, paths] of Object.entries(manifestKeys.sfx)) {
    sfxMap[key] = paths.map((p) => {
      const clip = clipByPath.get(p);
      if (!clip) {
        missingManifestPaths++;
        console.warn(`⚠ sfx.${key}: no backing file for manifest path "${p}"`);
        return p;
      }
      return clip.marker;
    });
  }
  const musicMap: Record<string, string> = {};
  for (const [key, p] of Object.entries(manifestKeys.music)) {
    const clip = clipByPath.get(p);
    if (!clip) {
      missingManifestPaths++;
      console.warn(`⚠ music.${key}: no backing file for manifest path "${p}"`);
      musicMap[key] = p;
    } else {
      musicMap[key] = clip.marker;
    }
  }
  const voiceoverMap: Record<string, string> = {};
  for (const [key, p] of Object.entries(manifestKeys.voiceover)) {
    const clip = clipByPath.get(p);
    if (!clip) {
      missingManifestPaths++;
      console.warn(`⚠ voiceover.${key}: no backing file for manifest path "${p}"`);
      voiceoverMap[key] = p;
    } else {
      voiceoverMap[key] = clip.marker;
    }
  }
  if (missingManifestPaths > 0) {
    console.warn(
      `⚠ ${missingManifestPaths} manifest path(s) had no backing file on disk; they were emitted as literal markers and will fail to play until resolved.`,
    );
  }

  // 7. Emit the companion TS file: typed marker constants + the key→marker
  //    maps so the client never hardcodes marker strings.
  const tsLines: string[] = [
    '/**',
    ' * AUTO-GENERATED by scripts/asset-pipeline/build-audio-spritesheet.ts.',
    ' * Do not edit by hand — re-run `pnpm --filter @sector-battle/client-v3',
    ' * run build:audio-sprite` after changing anything under',
    ' * `packages/client-v3/public/assets/audio`.',
    ' */',
    '',
    `/** Total number of audio markers in the sprite sheet: ${clips.length}. */`,
    `export const AUDIO_SPRITE_MARKER_COUNT = ${clips.length};`,
    '',
    '/** Sorted list of every marker name (clip stem) in the sprite sheet. */',
    'export const AUDIO_SPRITE_MARKERS = [',
    ...clips.map((c) => `  '${c.marker}',`),
    '] as const;',
    '',
    '/**',
    ' * Phaser audio-sprite manifest path (relative to the client public root).',
    ' * Load via `scene.load.audioSprite(AUDIO_SPRITE_KEY, AUDIO_SPRITE_JSON_PATH)`.',
    ' */',
    "export const AUDIO_SPRITE_JSON_PATH = 'assets/audio/spritesheet/audiosprite.json';",
    '',
    '/** Phaser audio-cache key for the loaded sprite sheet. */',
    "export const AUDIO_SPRITE_KEY = 'audio-sprite';",
    '',
    '/**',
    ' * SFX audio key → list of sprite markers (variants). Randomised at play.',
    ' * Derived from AssetManifest.sfx — same files, same order.',
    ' */',
    'export const SFX_MARKER_MAP: Record<string, string[]> = {',
    ...Object.entries(sfxMap).map(
      ([k, v]) => `  ${JSON.stringify(k)}: [${v.map((m) => `'${m}'`).join(', ')}],`,
    ),
    '};',
    '',
    '/** Music key → single sprite marker. Played with `loop: true`. */',
    'export const MUSIC_MARKER_MAP: Record<string, string> = {',
    ...Object.entries(musicMap).map(([k, v]) => `  ${JSON.stringify(k)}: '${v}',`),
    '};',
    '',
    '/** Voiceover key → single sprite marker. */',
    'export const VOICEOVER_MARKER_MAP: Record<string, string> = {',
    ...Object.entries(voiceoverMap).map(([k, v]) => `  ${JSON.stringify(k)}: '${v}',`),
    '};',
    '',
  ];
  await fs.writeFile(OUT_TS, tsLines.join('\n'), 'utf-8');

  // 8. Report.
  const oggStat = await fs.stat(OUT_OGG);
  const jsonStat = await fs.stat(OUT_JSON);
  console.log('');
  console.log('✓ Sprite sheet built');
  console.log(`  ${OUT_OGG} (${formatBytes(oggStat.size)})`);
  console.log(`  ${OUT_JSON} (${formatBytes(jsonStat.size)}, ${clips.length} markers)`);
  console.log(
    `  ${OUT_TS} (sfx=${Object.keys(sfxMap).length}, music=${Object.keys(musicMap).length}, vo=${Object.keys(voiceoverMap).length})`,
  );
  console.log(`  Total duration: ${totalDuration.toFixed(3)}s`);
  console.log(`  ffmpeg concat drift: ${drift.toFixed(4)}s`);

  // Clean up the temp WAV directory (per-clip WAVs + concat WAV).
  await fs.rm(tmpDir, { recursive: true, force: true });
}

main().catch(async (err) => {
  console.error('✗ Audio spritesheet generation failed:', err);
  // Best-effort temp cleanup on failure too.
  try {
    await fs.rm(path.join(OUT_DIR, '_tmp'), { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(1);
});
