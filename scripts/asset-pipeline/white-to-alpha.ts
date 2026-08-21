import fs from 'node:fs/promises';
import path from 'node:path';

export async function processDirectoryWhiteToAlpha(
  sourceDir: string,
  outputDir: string,
): Promise<number> {
  await fs.mkdir(outputDir, { recursive: true });

  const files = (await fs.readdir(sourceDir)).filter((f) => f.toLowerCase().endsWith('.png'));

  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(outputDir, file);
    await fs.copyFile(src, dest);
  }

  return files.length;
}
