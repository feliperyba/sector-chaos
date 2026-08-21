import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Purity gate (ticket 14 / research C3): the prediction-parity families —
 * `simulation/`, `collision/`, `math/` — must stay pure calculators consumable
 * by BOTH the server simulation and the client prediction. Concretely:
 *
 *   1. no external package imports at all (no Phaser, no Colyseus, no
 *      `loglevel` — Logger is infrastructure and stays in `utils/`, outside
 *      this purity set);
 *   2. every relative import resolves to a file inside `packages/shared/src`
 *      (no reaching into client-v3/ or server/);
 *   3. no DOM-global access (window/document/... ) — these modules run in
 *      Node and in the browser.
 *
 * This turns the implicit "pure calculators" convention into a CI-enforced
 * contract: an import of a schema type or a Phaser class into a calculator
 * fails here instead of shipping client-server divergence.
 */

// this file: <src>/simulation/__tests__/purity.test.ts → <src> is two levels up.
const SHARED_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PURITY_FAMILIES = ['simulation', 'collision', 'math'] as const;

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(fullPath);
    }
  }
  return out;
}

const scannedFiles = PURITY_FAMILIES.flatMap((family) => walkSourceFiles(join(SHARED_SRC, family)));

const display = (file: string) => relative(SHARED_SRC, file).split('\\').join('/');

/** All import specifiers: `… from 'x'`, side-effect `import 'x'`, dynamic `import('x')`. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromClause = /\bfrom\s*['"]([^'"]+)['"]/g;
  const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromClause, sideEffect, dynamic]) {
    for (const match of source.matchAll(re)) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

/** Resolve a relative specifier per the package's `.js`-extension ESM style. */
function resolveIntraShared(specifier: string, importerDir: string): string | null {
  const base = resolve(importerDir, specifier);
  const candidates = [
    base,
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Conservative comment strip so doc-comments (which DO mention Phaser/Colyseus
 * as the forbidden dependencies) cannot trip the DOM-global scan. Line
 * comments are only stripped when the `//` is not preceded by `:` (URLs in
 * string literals like 'https://…' survive).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DOM_GLOBAL_ACCESS =
  /\b(?:window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|cancelAnimationFrame)\s*[.[]/;

describe('purity gate: simulation/ + collision/ + math/ (ticket 14)', () => {
  it('scans a non-empty source set (the gate must have teeth)', () => {
    expect(scannedFiles.length).toBeGreaterThanOrEqual(10);
    for (const family of PURITY_FAMILIES) {
      const count = scannedFiles.filter((f) => f.includes(join(SHARED_SRC, family))).length;
      expect(count, `${family}/ has no source files?`).toBeGreaterThan(0);
    }
  });

  it('imports no external packages — no Phaser, no Colyseus, no loglevel, no DOM shims', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles) {
      // stripComments: the scan must see CODE, not prose — a doc comment
      // mentioning `from 'phaser'` must not false-positive the gate (T14
      // review follow-up, ticket 16).
      const source = stripComments(readFileSync(file, 'utf-8'));
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) {
          offenders.push(`${display(file)} → '${specifier}'`);
        }
      }
    }
    expect(
      offenders,
      `Purity violation — external imports in the parity families (Phaser/Colyseus/DOM \`window\` are exactly what this gate exists to keep out):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('resolves every relative import inside packages/shared/src', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolveIntraShared(specifier, dirname(file));
        if (resolved === null || !resolved.startsWith(SHARED_SRC)) {
          offenders.push(`${display(file)} → '${specifier}' (${resolved ?? 'unresolved'})`);
        }
      }
    }
    expect(
      offenders,
      `Purity violation — imports escaping packages/shared/src:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('accesses no DOM globals (comment-stripped scan)', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      const match = code.match(DOM_GLOBAL_ACCESS);
      if (match) offenders.push(`${display(file)} → ${match[0]}`);
    }
    expect(
      offenders,
      `Purity violation — DOM-global access in the parity families:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
