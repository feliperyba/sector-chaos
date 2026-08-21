import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

const execFileAsync = promisify(execFile);

async function resolveFfmpegBinary(): Promise<string> {
  if (ffmpegStatic) {
    try {
      await fs.access(ffmpegStatic, fsConstants.X_OK);
      return ffmpegStatic;
    } catch {
      // Fall back to PATH-provided ffmpeg in environments where ffmpeg-static is not executable.
    }
  }

  return 'ffmpeg';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function convertWavToOgg(
  ffmpegBin: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    ffmpegBin,
    ['-i', inputPath, '-c:a', 'libvorbis', '-q:a', '4', '-y', outputPath],
    { timeout: 30000 },
  );
}

export async function copyAudio(
  source: string,
  output: string,
): Promise<{ count: number; savedBytes: number }> {
  const ffmpegBin = await resolveFfmpegBinary();

  let count = 0;
  let savedBytes = 0;

  const subdirs = ['sfx', 'music'];

  for (const subdir of subdirs) {
    const srcDir = path.join(source, 'audio', subdir);
    const outDir = path.join(output, 'audio', subdir);

    let files: string[];
    try {
      files = (await fs.readdir(srcDir)).filter(
        (f) => f.toLowerCase().endsWith('.wav') || f.toLowerCase().endsWith('.ogg'),
      );
    } catch {
      continue;
    }

    if (files.length === 0) continue;
    await fs.mkdir(outDir, { recursive: true });

    for (const file of files) {
      const src = path.join(srcDir, file);
      const srcStat = await fs.stat(src);
      const beforeSize = srcStat.size;
      const baseName = path.basename(file, path.extname(file));

      if (file.toLowerCase().endsWith('.wav')) {
        const dest = path.join(outDir, `${baseName}.ogg`);
        await convertWavToOgg(ffmpegBin, src, dest);
        const destStat = await fs.stat(dest);
        const afterSize = destStat.size;
        const diff = beforeSize - afterSize;
        savedBytes += diff;
        const savedPct = ((diff / beforeSize) * 100).toFixed(0);
        console.log(
          `  ${subdir}/${baseName}.wav → .ogg: ${formatBytes(beforeSize)} → ${formatBytes(afterSize)} (${savedPct}% saved)`,
        );
      } else {
        const dest = path.join(outDir, file);
        await fs.copyFile(src, dest);
        console.log(`  ${subdir}/${file} (copied)`);
      }

      count++;
    }
  }

  return { count, savedBytes };
}
