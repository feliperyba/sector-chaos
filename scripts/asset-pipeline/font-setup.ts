import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

interface FontEntry {
  family: string;
  weight: string;
  style: string;
  file: string;
}

const FONTS: FontEntry[] = [
  {
    family: 'Kenney Bold',
    weight: '700',
    style: 'normal',
    file: 'kenney_bold-webfont.woff2',
  },
];

export async function setupFonts(source: string, output: string): Promise<number> {
  const fontsDir = path.join(source, 'UI', 'fonts');
  const outputDir = path.join(output, 'fonts');
  await fs.mkdir(outputDir, { recursive: true });

  const woff2Files = (await fs.readdir(fontsDir)).filter((f) => f.endsWith('.woff2'));

  for (const file of woff2Files) {
    await fs.copyFile(path.join(fontsDir, file), path.join(outputDir, file));
  }

  const cssLines: string[] = [];

  for (const font of FONTS) {
    cssLines.push('@font-face {');
    cssLines.push(`  font-family: '${font.family}';`);
    cssLines.push(`  font-style: ${font.style};`);
    cssLines.push(`  font-weight: ${font.weight};`);
    cssLines.push(`  src: url('./${font.file}') format('woff2');`);
    cssLines.push('}');
    cssLines.push('');
  }

  await fs.writeFile(path.join(outputDir, 'fonts.css'), cssLines.join('\n'), 'utf-8');

  console.log(`  Fonts: ${woff2Files.length} woff2 files + fonts.css`);
  return woff2Files.length;
}
