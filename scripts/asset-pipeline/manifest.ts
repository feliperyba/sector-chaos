import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

async function collectFiles(dir: string, base: string): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(fullPath, path.posix.join(base, entry.name));
      for (const [k, v] of sub) {
        manifest.set(k, v);
      }
    } else if (entry.isFile()) {
      const relativePath = path.posix.join(base, entry.name);
      const hash = await hashFile(fullPath);
      manifest.set(relativePath, hash);
    }
  }

  return manifest;
}

export async function generateManifest(outputDir: string): Promise<void> {
  const manifest = await collectFiles(outputDir, 'assets');
  const obj: Record<string, string> = {};
  const sorted = [...manifest.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of sorted) {
    obj[key] = value;
  }

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(obj, null, 2), 'utf-8');

  console.log(`  Manifest: ${manifest.size} entries → manifest.json`);
}
