import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Characterization tests for the Logger global-capture seam refactor (ticket #21).
 *
 * Pre-refactor: `Logger.getInstance()` had a hidden side effect that, when
 * called with the default config (name='logger') in a browser environment,
 * would install `window.addEventListener('error')`,
 * `window.addEventListener('unhandledrejection')`, and overwrite
 * `window.nativeCrashLog`. These cases pin the post-refactor contract:
 * capture is opt-in via `Logger.installGlobalErrorCapture()` only.
 *
 * Per the ticket, tests 2-5 are committed failing in Step 0 (red) and made
 * green by Step 1 (extract to LoggerGlobalCapture.ts + thin static delegate).
 *
 * Note on ordering: the Logger module eagerly constructs the singleton via
 * `export const logger = new Logger(defaultConfig);` at module load. To
 * exercise the inline-capture path (pre-refactor), the window stub MUST be
 * in place BEFORE the dynamic `import('../Logger.js')` so module-load
 * `getInstance()` observes a present window.
 */

// Build a stub `window` that records addEventListener calls and exposes the
// nativeCrashLog slot the production code writes to.
const buildStubWindow = (): {
  addEventListener: ReturnType<typeof vi.fn>;
  nativeCrashLog: ((msg: string) => void) | undefined;
} => ({
  addEventListener: vi.fn(),
  nativeCrashLog: undefined,
});

type StubWindow = ReturnType<typeof buildStubWindow>;

const setStubWindow = (w: StubWindow | undefined): void => {
  if (w === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as unknown as { window?: unknown }).window;
  } else {
    (globalThis as unknown as { window: StubWindow }).window = w;
  }
};

const defaultLoggerConfig = { name: 'logger', colorScheme: 'default' as const };

describe('Logger global-capture characterization', () => {
  afterEach(() => {
    setStubWindow(undefined);
    vi.resetModules();
  });

  it('1. getInstance() returns the same instance for the same name', async () => {
    const { Logger } = await import('../Logger.js');
    const a = Logger.getInstance(defaultLoggerConfig);
    const b = Logger.getInstance(defaultLoggerConfig);
    expect(a).toBe(b);
  });

  it('2. getInstance() alone does NOT install global capture (post-refactor)', async () => {
    // Stub the window BEFORE importing Logger so module-load
    // `new Logger(defaultConfig)` -> `getInstance()` runs with a window present.
    // Pre-refactor, that module-load path installs the global listeners.
    const w = buildStubWindow();
    setStubWindow(w);
    await import('../Logger.js');
    expect(w.addEventListener).not.toHaveBeenCalled();
  });

  it('3. installGlobalErrorCapture() installs error + unhandledrejection listeners and nativeCrashLog', async () => {
    const w = buildStubWindow();
    setStubWindow(w);
    const { Logger } = await import('../Logger.js');
    Logger.installGlobalErrorCapture();
    expect(w.addEventListener).toHaveBeenCalledTimes(2);
    expect(w.nativeCrashLog).toBeTypeOf('function');
  });

  it('4. installGlobalErrorCapture() is idempotent across repeat calls', async () => {
    const w = buildStubWindow();
    setStubWindow(w);
    const { Logger } = await import('../Logger.js');
    Logger.installGlobalErrorCapture();
    Logger.installGlobalErrorCapture();
    expect(w.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('5. installGlobalErrorCapture() is a server no-op when window is undefined', async () => {
    // Import without ever setting a window — Node default.
    const { Logger } = await import('../Logger.js');
    expect(() => Logger.installGlobalErrorCapture()).not.toThrow();
    expect((globalThis as unknown as { window?: unknown }).window).toBeUndefined();
  });
});
