import * as fs from 'fs';
import * as path from 'path';

describe('Domain Purity', () => {
  it('should not import from forbidden packages', () => {
    const forbidden = ['@colyseus/schema', 'colyseus', 'express', 'zod'];
    const domainDir = path.resolve(__dirname, '../../src/domain');

    function checkDirectory(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const pkg of forbidden) {
            expect(
              content.includes(`from '${pkg}'`) || content.includes(`from "${pkg}"`),
              `${fullPath} imports from ${pkg}`,
            ).toBe(false);
          }
        }
      }
    }

    checkDirectory(domainDir);
  });

  it('application layer should not import from colyseus or express', () => {
    const forbidden = ['@colyseus/schema', 'colyseus', 'express'];
    const appDir = path.resolve(__dirname, '../../src/application');

    function checkDirectory(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          for (const pkg of forbidden) {
            expect(
              content.includes(`from '${pkg}'`) || content.includes(`from "${pkg}"`),
              `${fullPath} imports from ${pkg}`,
            ).toBe(false);
          }
        }
      }
    }

    checkDirectory(appDir);
  });
});
