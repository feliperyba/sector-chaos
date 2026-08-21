import type { Logger } from './Logger.js';

declare global {
  interface Window {
    nativeCrashLog?: (msg: string) => void;
  }
}

let globalCaptureInstalled = false;

/**
 * Coerce an unknown captured error/rejection value to a string suitable for
 * passing to `Logger.error(message: string, ...)`. Preserves Error stacks.
 */
const toErrorMessage = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Install window-level error/rejection capture onto the given Logger instance.
 * Idempotent — repeat calls are no-ops. No-op on the server (no window).
 *
 * Extracted from Logger.ts to keep that file under the 450-LOC cap.
 * Called via `Logger.installGlobalErrorCapture()`; not intended for direct
 * external use.
 *
 * @param logger - The Logger instance to receive captured errors. Must already
 *   be constructed (typically the shared `logger` singleton).
 */
export function installGlobalErrorCapture(logger: Logger): void {
  if (globalCaptureInstalled) return;
  globalCaptureInstalled = true;
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    logger.error(toErrorMessage(event.error), event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logger.error(toErrorMessage(event.reason));
  });
  window.nativeCrashLog = (msg: string) => {
    logger.error(msg);
  };
}
