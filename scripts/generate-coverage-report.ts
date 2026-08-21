import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';

interface CoverageMetrics {
  total: number;
  covered: number;
  pct: number;
}

interface FileCoverage {
  lines: CoverageMetrics;
  statements: CoverageMetrics;
  functions: CoverageMetrics;
  branches: CoverageMetrics;
}

interface CoverageSummary {
  total: FileCoverage;
  [filePath: string]: FileCoverage;
}

interface MatrixEntry {
  gddSection: string;
  system: string;
  taskIds: string[];
  filePatterns: RegExp[];
}

const COVERAGE_DIR = 'coverage';
const SUMMARY_FILE = join(COVERAGE_DIR, 'coverage-summary.json');
const REPORT_FILE = join(COVERAGE_DIR, 'REPORT.md');

const MATRIX: MatrixEntry[] = [
  {
    gddSection: '§2 Core Game Loop',
    system: 'Scene Navigation',
    taskIds: ['T059'],
    filePatterns: [/scenes[\\/].*\.ts$/],
  },
  {
    gddSection: '§3 Boot/Preload',
    system: 'Boot + Preload',
    taskIds: ['T059'],
    filePatterns: [/scenes[\\/]BootScene\.ts$/, /scenes[\\/]PreloadScene\.ts$/],
  },
  {
    gddSection: '§4.1 Player Rendering',
    system: 'Player Sprites',
    taskIds: ['T062'],
    filePatterns: [/game[\\/]entities[\\/]PlayerEntity\.ts$/, /game[\\/]EntityRenderer\.ts$/],
  },
  {
    gddSection: '§4.2 Mobile Controls',
    system: 'Touch Input',
    taskIds: ['T067'],
    filePatterns: [/mobile[\\/].*\.ts$/, /input[\\/]TouchHandler\.ts$/],
  },
  {
    gddSection: '§5.1 Map Generation',
    system: 'Tile Grid',
    taskIds: ['T060'],
    filePatterns: [
      /game[\\/]MapRenderer\.ts$/,
      /game[\\/]TileAtlasBuilder\.ts$/,
      /game[\\/]tileLayerUtils\.ts$/,
    ],
  },
  {
    gddSection: '§6.1–6.8 HUD',
    system: 'HUD Elements',
    taskIds: ['T061'],
    filePatterns: [/ui[\\/].*\.ts$/, /game[\\/]HUDBridge\.ts$/],
  },
  {
    gddSection: '§7.1–7.2 VFX',
    system: 'Visual Effects',
    taskIds: ['T062'],
    filePatterns: [
      /game[\\/]entities[\\/]ExplosionEntity\.ts$/,
      /game[\\/]explosionCells\.ts$/,
      /game[\\/]zone[\\/].*\.ts$/,
    ],
  },
  {
    gddSection: '§12.7 Spectator',
    system: 'Spectator Mode',
    taskIds: ['T063'],
    filePatterns: [/ui[\\/]views[\\/]SpectatorHUDView\.ts$/],
  },
  {
    gddSection: '§12.8 Results',
    system: 'Results Screen',
    taskIds: ['T063'],
    filePatterns: [/scenes[\\/]ResultsScene\.ts$/],
  },
  {
    gddSection: '§13.7.1 HUD',
    system: 'HUD Pixel Tests',
    taskIds: ['T061'],
    filePatterns: [
      /ui[\\/]views[\\/]HealthBarView\.ts$/,
      /ui[\\/]views[\\/]WeaponSlotsView\.ts$/,
      /ui[\\/]views[\\/]ZoneTimerView\.ts$/,
    ],
  },
  {
    gddSection: '§15.3 Network',
    system: 'Network Resilience',
    taskIds: ['T068'],
    filePatterns: [/network[\\/]NetworkController\.ts$/, /prediction[\\/].*\.ts$/],
  },
  {
    gddSection: '§21 Audio',
    system: 'Sound/Music',
    taskIds: ['T064'],
    filePatterns: [/audio[\\/]AudioManager\.ts$/],
  },
];

function normalizePath(filePath: string): string {
  return filePath.split(sep).join('/');
}

function readCoverageSummary(): CoverageSummary | null {
  if (!existsSync(SUMMARY_FILE)) {
    return null;
  }
  const raw = readFileSync(SUMMARY_FILE, 'utf-8');
  return JSON.parse(raw) as CoverageSummary;
}

function getFilesForEntry(entry: MatrixEntry, allFiles: string[]): string[] {
  return allFiles.filter((file) => {
    const normalized = normalizePath(file);
    return entry.filePatterns.some((pattern) => pattern.test(normalized));
  });
}

function computeAggregatedCoverage(
  files: string[],
  summary: CoverageSummary,
): { linePct: number; branchPct: number; fileCount: number } {
  if (files.length === 0) {
    return { linePct: 0, branchPct: 0, fileCount: 0 };
  }

  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  let fileCount = 0;

  for (const file of files) {
    const fileCov = summary[file];
    if (!fileCov) continue;
    fileCount++;
    totalLines += fileCov.lines.total;
    coveredLines += fileCov.lines.covered;
    totalBranches += fileCov.branches.total;
    coveredBranches += fileCov.branches.covered;
  }

  return {
    linePct: totalLines > 0 ? Math.round((coveredLines / totalLines) * 1000) / 10 : 0,
    branchPct: totalBranches > 0 ? Math.round((coveredBranches / totalBranches) * 1000) / 10 : 0,
    fileCount,
  };
}

function determineStatus(linePct: number, branchPct: number): string {
  if (linePct > 0 || branchPct > 0) return 'PASS';
  return 'NO COVERAGE';
}

function generateMatrixTable(summary: CoverageSummary, allFiles: string[]): string {
  const header = '| GDD Section | System | Task IDs | Files Covered | Line % | Branch % | Status |';
  const separator =
    '|-------------|--------|----------|--------------|--------|----------|--------|';

  const rows = MATRIX.map((entry) => {
    const files = getFilesForEntry(entry, allFiles);
    const { linePct, branchPct, fileCount } = computeAggregatedCoverage(files, summary);
    const status = determineStatus(linePct, branchPct);
    return `| ${entry.gddSection} | ${entry.system} | ${entry.taskIds.join(', ')} | ${fileCount} | ${linePct}% | ${branchPct}% | ${status} |`;
  });

  return [header, separator, ...rows].join('\n');
}

function findZeroCoverageFiles(summary: CoverageSummary, allFiles: string[]): string[] {
  return allFiles.filter((file) => {
    const fileCov = summary[file];
    if (!fileCov) return true;
    return fileCov.lines.pct === 0 && fileCov.branches.pct === 0;
  });
}

function findTasksWithNoSourceFiles(summary: CoverageSummary, allFiles: string[]): string[] {
  const tasksWithNoFiles: string[] = [];
  const seenTasks = new Set<string>();

  for (const entry of MATRIX) {
    for (const taskId of entry.taskIds) {
      if (seenTasks.has(taskId)) continue;
      seenTasks.add(taskId);

      const allEntryFiles = MATRIX.filter((e) => e.taskIds.includes(taskId)).flatMap((e) =>
        getFilesForEntry(e, allFiles),
      );

      const hasCoveredFile = allEntryFiles.some((f) => summary[f] && summary[f].lines.total > 0);
      if (!hasCoveredFile) {
        tasksWithNoFiles.push(taskId);
      }
    }
  }

  return tasksWithNoFiles;
}

function findGddSectionsWithNoTasks(): string[] {
  return MATRIX.filter((entry) => entry.taskIds.length === 0).map((entry) => entry.gddSection);
}

function generateMissingCoverageSection(summary: CoverageSummary, allFiles: string[]): string {
  const zeroFiles = findZeroCoverageFiles(summary, allFiles);
  const tasksWithNoFiles = findTasksWithNoSourceFiles(summary, allFiles);
  const sectionsWithNoTasks = findGddSectionsWithNoTasks();

  const lines: string[] = ['## Missing Coverage', ''];

  lines.push('### Files with 0% Coverage', '');
  if (zeroFiles.length === 0) {
    lines.push('None — all mapped files have some coverage.', '');
  } else {
    for (const file of zeroFiles) {
      lines.push(`- \`${normalizePath(file)}\``);
    }
    lines.push('');
  }

  lines.push('### Task IDs with No Matching Source Files', '');
  if (tasksWithNoFiles.length === 0) {
    lines.push('None — all tasks have matching source files in coverage data.', '');
  } else {
    for (const taskId of tasksWithNoFiles) {
      lines.push(`- ${taskId}`);
    }
    lines.push('');
  }

  lines.push('### GDD Sections with No Test Tasks', '');
  if (sectionsWithNoTasks.length === 0) {
    lines.push('None — all mapped GDD sections have test tasks.', '');
  } else {
    for (const section of sectionsWithNoTasks) {
      lines.push(`- ${section}`);
    }
    lines.push('');
  }

  lines.push('### Actionable Recommendations', '');
  const recommendations: string[] = [];
  for (const entry of MATRIX) {
    const files = getFilesForEntry(entry, allFiles);
    const { linePct } = computeAggregatedCoverage(files, summary);
    if (linePct === 0 && entry.taskIds.length > 0) {
      recommendations.push(
        `- Add tests for **${entry.system}** to cover ${entry.gddSection} (tasks: ${entry.taskIds.join(', ')})`,
      );
    }
  }
  if (recommendations.length === 0) {
    lines.push('All mapped GDD sections have at least partial coverage.', '');
  } else {
    lines.push(...recommendations, '');
  }

  return lines.join('\n');
}

function readTestResults(): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const testResultsPath = join(COVERAGE_DIR, 'test-results.json');
  if (!existsSync(testResultsPath)) {
    return { total: 0, passed: 0, failed: 0, skipped: 0 };
  }

  try {
    const raw = readFileSync(testResultsPath, 'utf-8');
    const results = JSON.parse(raw);
    return {
      total: (results.numTotalTests as number) ?? 0,
      passed: (results.numPassedTests as number) ?? 0,
      failed: (results.numFailedTests as number) ?? 0,
      skipped: (results.numPendingTests as number) ?? 0,
    };
  } catch {
    return { total: 0, passed: 0, failed: 0, skipped: 0 };
  }
}

function determineTaskStatus(
  linePct: number,
  testResults: { total: number; passed: number; failed: number; skipped: number },
): string {
  const hasTestedFiles = linePct > 0;
  if (!hasTestedFiles) {
    return 'FAIL';
  }
  if (testResults.total > 0 && testResults.failed > 0) {
    return 'FAIL';
  }
  if (testResults.total > 0) {
    return 'PASS';
  }
  return 'PASS';
}

function generatePerTaskRows(allFiles: string[], summary: CoverageSummary): string[] {
  const seenTasks = new Set<string>();
  const rows: string[] = [];
  const testResults = readTestResults();

  for (const entry of MATRIX) {
    for (const taskId of entry.taskIds) {
      if (seenTasks.has(taskId)) continue;
      seenTasks.add(taskId);

      const allEntryFiles = MATRIX.filter((e) => e.taskIds.includes(taskId)).flatMap((e) =>
        getFilesForEntry(e, allFiles),
      );

      const { linePct } = computeAggregatedCoverage(allEntryFiles, summary);
      const status = determineTaskStatus(linePct, testResults);
      const gddSections = MATRIX.filter((e) => e.taskIds.includes(taskId))
        .map((e) => e.gddSection)
        .join(', ');
      rows.push(`| ${taskId} | ${gddSections} | ${status} |`);
    }
  }

  return rows;
}

function generatePerGddSectionSummary(allFiles: string[], summary: CoverageSummary): string {
  const header = '| GDD Section | Line % | Branch % | Files | Status |';
  const separator = '|-------------|--------|----------|-------|--------|';

  const rows = MATRIX.map((entry) => {
    const files = getFilesForEntry(entry, allFiles);
    const { linePct, branchPct, fileCount } = computeAggregatedCoverage(files, summary);
    const status = determineStatus(linePct, branchPct);
    return `| ${entry.gddSection} | ${linePct}% | ${branchPct}% | ${fileCount} | ${status} |`;
  });

  return [header, separator, ...rows].join('\n');
}

function generateReport(summary: CoverageSummary): string {
  const total = summary.total;
  const allFiles = Object.keys(summary).filter((k) => k !== 'total');
  const timestamp = new Date().toISOString();
  const testResults = readTestResults();

  const matrixTable = generateMatrixTable(summary, allFiles);
  const missingSection = generateMissingCoverageSection(summary, allFiles);
  const perTaskRows = generatePerTaskRows(allFiles, summary);
  const perGddSectionSummary = generatePerGddSectionSummary(allFiles, summary);

  const sections = [
    '# Coverage Report',
    '',
    `**Generated**: ${timestamp}`,
    '',
    '## Overall Coverage',
    '',
    '| Metric | Percentage |',
    '|--------|-----------|',
    `| Lines | ${total.lines.pct}% |`,
    `| Branches | ${total.branches.pct}% |`,
    `| Statements | ${total.statements.pct}% |`,
    `| Functions | ${total.functions.pct}% |`,
    '',
    '## Test Results',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Total | ${testResults.total} |`,
    `| Passed | ${testResults.passed} |`,
    `| Failed | ${testResults.failed} |`,
    `| Skipped | ${testResults.skipped} |`,
    '',
    '## Per-Task Status',
    '',
    '| Task ID | GDD Sections | Status |',
    '|---------|-------------|--------|',
    ...perTaskRows,
    '',
    '## Per-GDD-Section Coverage Summary',
    '',
    perGddSectionSummary,
    '',
    '## Coverage Matrix',
    '',
    matrixTable,
    '',
    missingSection,
  ];

  return sections.join('\n');
}

function main(): void {
  const summary = readCoverageSummary();

  if (!summary) {
    console.error(`Error: ${SUMMARY_FILE} not found. Run "npx vitest run --coverage" first.`);
    process.exit(1);
  }

  const report = generateReport(summary);

  if (!existsSync(COVERAGE_DIR)) {
    mkdirSync(COVERAGE_DIR, { recursive: true });
  }

  writeFileSync(REPORT_FILE, report, 'utf-8');
  console.log(`Coverage report generated: ${REPORT_FILE}`);
  console.log();
  console.log(report);
}

main();
