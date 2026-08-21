import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

async function collectPngs(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectPngs(fullPath);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
      results.push(fullPath);
    }
  }

  return results;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function convertPngsToWebp(
  outputDir: string,
): Promise<{ converted: number; savedBytes: number }> {
  const pngFiles = await collectPngs(outputDir);

  let converted = 0;
  let savedBytes = 0;

  for (const filePath of pngFiles) {
    const isVfxParticle = filePath.includes(`${path.sep}vfx${path.sep}particles${path.sep}`);
    const beforeStat = await fs.stat(filePath);
    const beforeSize = beforeStat.size;

    const webpPath = filePath.replace(/\.png$/i, '.webp');

    if (isVfxParticle) {
      await sharp(filePath).webp({ quality: 85 }).toFile(webpPath);
    } else {
      await sharp(filePath).webp({ lossless: true }).toFile(webpPath);
    }

    const afterStat = await fs.stat(webpPath);
    const afterSize = afterStat.size;

    await fs.unlink(filePath).catch(() => {});

    const diff = beforeSize - afterSize;
    savedBytes += diff;
    converted++;

    const relative = path.relative(outputDir, filePath);
    const savedPct = ((diff / beforeSize) * 100).toFixed(0);
    console.log(
      `  ${relative} → ${formatBytes(beforeSize)} → ${formatBytes(afterSize)} (${savedPct}% saved)`,
    );
  }

  return { converted, savedBytes };
}
