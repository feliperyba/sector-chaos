import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const MAX_LINES = 500;
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const EXTS = new Set(['.ts', '.tsx']);
const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  '.git',
  'test-results',
  'tests',
  '__tests__',
]);
const TEST_FILE = /\.test\.[a-z]+$/;

const EXEMPT_FILES = new Set<string>([
  'packages/client-v3/src/assets/AssetManifest.ts',
  'packages/shared/src/weapons/definitions.ts',
  'packages/shared/src/map/sectors/openArenaSkeletons.ts',
  'packages/shared/src/map/sectors/gridArenaSkeletons.ts',
]);

interface Violation {
  file: string;
  lines: number;
}

function walk(dir: string, violations: Violation[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath, violations);
    } else if (entry.isFile() && EXTS.has(extname(entry.name))) {
      const rel = relative(ROOT, fullPath).split('\\').join('/');
      if (TEST_FILE.test(entry.name)) continue;
      if (EXEMPT_FILES.has(rel)) continue;
      const content = readFileSync(fullPath, 'utf-8');
      const lineCount = content.split('\n').length;

      if (lineCount > MAX_LINES) {
        violations.push({ file: rel, lines: lineCount });
      }
    }
  }
}

const violations: Violation[] = [];
walk(join(ROOT, 'packages'), violations);

if (violations.length > 0) {
  console.error(`\nFile length violations (max ${MAX_LINES} lines):\n`);
  for (const v of violations) {
    console.error(`  ${v.lines} lines — ${v.file}`);
  }
  console.error(`\n${violations.length} file(s) exceed the ${MAX_LINES}-line limit.\n`);
  process.exit(1);
}

console.log(`All files within ${MAX_LINES}-line limit.`);
