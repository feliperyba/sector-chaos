import fs from 'node:fs/promises';
import path from 'node:path';

export async function copyDirectory(sourceDir: string, outputDir: string): Promise<number> {
  await fs.mkdir(outputDir, { recursive: true });

  const files = (await fs.readdir(sourceDir)).filter((f) => f.toLowerCase().endsWith('.png'));

  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(outputDir, file);
    await fs.copyFile(src, dest);
  }

  return files.length;
}

export async function copyCharacterSprites(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'Characters'),
    path.join(output, 'characters'),
  );
  console.log(`  Characters: ${count} files copied`);
  return count;
}

export async function copyUiIcons(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'UI', 'icons'),
    path.join(output, 'ui', 'icons'),
  );
  console.log(`  UI icons: ${count} files copied`);
  return count;
}

export async function copyUiTextures(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'UI', 'textures'),
    path.join(output, 'ui', 'textures'),
  );
  console.log(`  UI textures: ${count} files copied`);
  return count;
}

export async function copyUiCursor(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'UI', 'cursor'),
    path.join(output, 'ui', 'cursor'),
  );
  console.log(`  UI cursor: ${count} files copied`);
  return count;
}

export async function copyVfxParticles(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'VFX', 'particles'),
    path.join(output, 'vfx', 'particles'),
  );
  console.log(`  VFX particles: ${count} files copied`);
  return count;
}

export async function copyVfxPatterns(source: string, output: string): Promise<number> {
  const count = await copyDirectory(
    path.join(source, 'VFX', 'patterns'),
    path.join(output, 'vfx', 'patterns'),
  );
  console.log(`  VFX patterns: ${count} files copied`);
  return count;
}
