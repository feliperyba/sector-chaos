import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyCharacterSprites,
  copyUiIcons,
  copyUiTextures,
  copyUiCursor,
  copyVfxParticles,
  copyVfxPatterns,
} from './copy-assets.ts';
import { processDirectoryWhiteToAlpha } from './white-to-alpha.ts';
import { setupFonts } from './font-setup.ts';
import { generateManifest } from './manifest.ts';
import { copyAudio } from './copy-audio.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const SOURCE = path.join(ROOT, 'game-assets');
const OUTPUT = path.join(ROOT, 'packages', 'client', 'public', 'assets');

async function main(): Promise<void> {
  console.log('[Asset Pipeline] Starting...');
  console.log(`  Source: ${SOURCE}`);
  console.log(`  Output: ${OUTPUT}`);

  await fs.mkdir(OUTPUT, { recursive: true });

  console.log('\n[1/10] Copying character sprites...');
  await copyCharacterSprites(SOURCE, OUTPUT);

  console.log('\n[2/10] Processing environment (white-to-alpha)...');
  const envCount = await processDirectoryWhiteToAlpha(
    path.join(SOURCE, 'environment'),
    path.join(OUTPUT, 'environment'),
  );
  console.log(`  Environment: ${envCount} files processed`);

  console.log('\n[3/10] Processing items (white-to-alpha)...');
  const itemCount = await processDirectoryWhiteToAlpha(
    path.join(SOURCE, 'Items'),
    path.join(OUTPUT, 'items'),
  );
  console.log(`  Items: ${itemCount} files processed`);

  console.log('\n[4/10] Copying UI icons...');
  await copyUiIcons(SOURCE, OUTPUT);

  console.log('\n[5/10] Copying UI textures...');
  await copyUiTextures(SOURCE, OUTPUT);

  console.log('\n[6/10] Copying UI cursor...');
  await copyUiCursor(SOURCE, OUTPUT);

  console.log('\n[7/10] Setting up fonts...');
  await setupFonts(SOURCE, OUTPUT);

  console.log('\n[8/10] Copying VFX...');
  await copyVfxParticles(SOURCE, OUTPUT);
  await copyVfxPatterns(SOURCE, OUTPUT);

  console.log('\n[9/10] Copying audio (WAV → OGG)...');
  const { count: audioCount, savedBytes: audioSaved } = await copyAudio(SOURCE, OUTPUT);
  console.log(`  Audio: ${audioCount} files, ${(audioSaved / 1024 / 1024).toFixed(2)} MB saved`);

  console.log('\n[Manifest] Generating asset manifest...');
  await generateManifest(OUTPUT);

  console.log('\n[Asset Pipeline] Complete!');
}

main().catch((err: unknown) => {
  console.error('[Asset Pipeline] Failed:', err);
  process.exit(1);
});
