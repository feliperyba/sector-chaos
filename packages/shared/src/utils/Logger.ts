import log from 'loglevel';
import { installGlobalErrorCapture } from './LoggerGlobalCapture.js';

export interface ColorScheme {
  reset: string;
  gray: string;
  blue: string;
  green: string;
  yellow: string;
  red: string;
  white: string;
  cyan: string;
}

export const colorSchemes = {
  default: {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    white: '\x1b[37m',
    cyan: '\x1b[36m',
  },
  network: {
    reset: '\x1b[0m',
    gray: '\x1b[37m',
    blue: '\x1b[94m',
    green: '\x1b[92m',
    yellow: '\x1b[93m',
    red: '\x1b[91m',
    white: '\x1b[97m',
    cyan: '\x1b[96m',
  },
} as const;

interface LoggerFormatConfig {
  template: string;
  timestampFormatter: (date: Date) => string;
  levelFormatter: (level: string) => string;
  nameFormatter: (name: string) => string;
  format: (
    prefix: string | undefined,
    level: string,
    name: string,
    timestamp: string,
    colors: ColorScheme,
  ) => string;
}

export interface LoggerConfig {
  name: string;
  colorScheme: keyof typeof colorSchemes;
  prefix?: string;
  formatConfig?: Partial<LoggerFormatConfig>;
}

const defaultFormatConfig: LoggerFormatConfig = {
  template: '%t %l %n',
  timestampFormatter: (date: Date) => {
    if (typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function') {
      return new Intl.DateTimeFormat(undefined, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(date);
    }
    return date.toISOString();
  },
  levelFormatter: (level: string) => level.toUpperCase(),
  nameFormatter: (name: string) => name || 'logger',
  format: (
    prefix: string | undefined,
    level: string,
    name: string,
    timestamp: string,
    colors: ColorScheme,
  ) => {
    const strPrefix = `[${timestamp}]${prefix ? `[${prefix}]` : ''}[${level}][${name}]`;
    const color =
      {
        trace: colors.gray,
        debug: colors.blue,
        info: colors.green,
        warn: colors.yellow,
        error: colors.red,
        silent: colors.white,
      }[level.toLowerCase()] ?? colors.reset;

    return `${color}${strPrefix}${colors.reset}`;
  },
} as const;

// Timestamp cache to avoid repeated date formatting
class TimestampCache {
  #cachedTimestamp = '';
  #lastUpdate = 0;
  #formatter: (date: Date) => string;

  constructor(formatter: (date: Date) => string) {
    this.#formatter = formatter;
  }

  public getTimestamp(): string {
    const now = Date.now();
    // Update cache every second
    if (now - this.#lastUpdate > 1000) {
      this.#cachedTimestamp = this.#formatter(new Date(now));
      this.#lastUpdate = now;
    }
    return this.#cachedTimestamp;
  }
}

// Pre-compiled regex patterns (compile once, reuse many times)
const CLASS_METHOD_PATTERN = /at\s+([A-Z][a-zA-Z0-9_]*)\.([\w$]+)\s*[(<]/;
const FUNCTION_PATTERN = /at\s+([a-zA-Z_$][\w$]*)\s*[(<]/;

// Skip patterns - using array for ordered checks (most common first)
const SKIP_PATTERNS = [
  'at getMethodName',
  'at newFactory',
  'at Logger.',
  '/logger/',
  'logAnalyticsEvent',
  'at Object.complete',
  'at Object.next',
  'at Object.error',
  'at ConsumerObserver',
];

// Cache the skip patterns length to avoid repeated property access
const SKIP_PATTERNS_LENGTH = SKIP_PATTERNS.length;

const getMethodName = (): string => {
  try {
    throw new Error();
  } catch (error: unknown) {
    const stack = (error as Error).stack;
    if (!stack) return 'unknown';

    const stackLines = stack.split('\n');
    const lineCount = stackLines.length;

    // Start from line 3 (skip Error construction and getMethodName itself)
    // Limit search to first 15 lines (reasonable call stack depth)
    const maxLines = Math.min(lineCount, 15);

    for (let i = 3; i < maxLines; i++) {
      const line = stackLines[i];

      // Quick skip check - inline for performance with cached length
      let shouldSkip = false;
      for (let j = 0; j < SKIP_PATTERNS_LENGTH; j++) {
        if (line?.includes(SKIP_PATTERNS[j]!)) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) continue;

      // Pattern 1: "at ClassName.methodName (file:line:col)" - Prioritize class methods
      const classMethodMatch = CLASS_METHOD_PATTERN.exec(line!);
      if (classMethodMatch) {
        return `${classMethodMatch[1]}.${classMethodMatch[2]}`;
      }

      // Pattern 2: "at functionName (file:line:col)"
      const functionMatch = FUNCTION_PATTERN.exec(line!);
      if (functionMatch) {
        const funcName = functionMatch[1];
        // Quick rejection of common non-useful names
        if (funcName !== 'anonymous' && funcName !== 'eval' && funcName !== 'Object') {
          return funcName!;
        }
      }
    }

    return 'unknown';
  }
};

// Optimized JSON stringifier with depth limit and pre-allocated buffer
const safeStringify = (obj: unknown, maxDepth = 3): string => {
  const seen = new WeakSet();

  const stringify = (value: unknown, depth: number): string => {
    if (depth > maxDepth) {
      return '[Max Depth]';
    }

    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    const type = typeof value;
    if (type === 'string') return `"${String(value)}"`;
    if (type === 'number' || type === 'boolean') return String(value);

    if (type === 'object') {
      if (seen.has(value as object)) {
        return '[Circular]';
      }
      seen.add(value as object);

      if (Array.isArray(value)) {
        const length = value.length;
        if (length === 0) return '[]';

        // Pre-allocate array for better performance
        const items = new Array(length);
        for (let i = 0; i < length; i++) {
          items[i] = stringify(value[i], depth + 1);
        }
        return `[${items.join(',')}]`;
      }

      const entries = Object.entries(value as Record<string, unknown>);
      const entriesLength = entries.length;
      if (entriesLength === 0) return '{}';

      // Pre-allocate array for better performance
      const props = new Array(entriesLength);
      for (let i = 0; i < entriesLength; i++) {
        const entry = entries[i]!;
        const k = entry[0];
        const v = entry[1];
        props[i] = `"${k}":${stringify(v, depth + 1)}`;
      }
      return `{${props.join(',')}}`;
    }

    return String(value);
  };

  return stringify(obj, 0);
};

const defaultConfig: LoggerConfig = { name: 'logger', colorScheme: 'default' };
const networkConfig: LoggerConfig = {
  name: 'network',
  colorScheme: 'network' as const,
  prefix: 'NET',
};

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class Logger {
  private static instances = new Map<string, log.Logger>();
  private static timestampCaches = new Map<string, TimestampCache>();

  readonly #logger: log.Logger;

  constructor(config: LoggerConfig) {
    this.#logger = Logger.getInstance(config);
  }

  private static createLoggerInstance(config: LoggerConfig): log.Logger {
    const colors = colorSchemes[config.colorScheme];
    const formatConfig = { ...defaultFormatConfig, ...config.formatConfig };
    const logger = log.getLogger(config.name);

    // Create timestamp cache for this logger
    if (!this.timestampCaches.has(config.name)) {
      this.timestampCaches.set(config.name, new TimestampCache(formatConfig.timestampFormatter));
    }
    const timestampCache = this.timestampCaches.get(config.name)!;

    const currentFactory = log.methodFactory;

    // Pre-compute level colors to avoid repeated lookups
    const levelColors: Record<string, string> = {
      trace: colors.gray,
      debug: colors.blue,
      info: colors.green,
      warn: colors.yellow,
      error: colors.red,
      silent: colors.white,
    };

    // Cache config values to avoid repeated property access
    const configPrefix = config.prefix;
    const hasPrefix = configPrefix !== undefined;

    const newFactory = (
      methodName: log.LogLevelNames,
      logLevel: log.LogLevelNumbers,
      loggerName: string | symbol,
    ) => {
      const rawMethod = currentFactory(methodName, logLevel, loggerName);
      const levelColor = levelColors[methodName];
      const levelStr = formatConfig.levelFormatter(methodName);

      return (...args: unknown[]) => {
        // Early return: Skip all processing if logger is at SILENT level
        if (logger.getLevel() >= log.levels.SILENT) {
          return;
        }

        // Synchronous: Get timestamp (cached) and method name
        const timestamp = timestampCache.getTimestamp();
        const name = '';

        // Defer formatting and console output to microtask
        queueMicrotask(() => {
          // Build formatted prefix with pre-computed values
          const prefixPart = hasPrefix ? `[${configPrefix}]` : '';
          const namePart = name ? `[${name}]` : '';
          const prefix = `[${timestamp}]${prefixPart}[${levelStr}]${namePart}`;
          const formattedPrefix = `${levelColor}${prefix}${colors.reset}`;

          // Handle different argument types with early returns
          const argsLength = args.length;

          if (argsLength === 1) {
            const firstArg = args[0];
            const firstArgType = typeof firstArg;

            // Fast path for single object/array
            if (firstArgType === 'object' && firstArg !== null) {
              const jsonStr = safeStringify(firstArg);
              rawMethod(`${formattedPrefix} ${jsonStr}`);
              return;
            }

            // Fast path for single string
            if (firstArgType === 'string') {
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              rawMethod(`${formattedPrefix} ${firstArg}`);
              return;
            }
          }

          // Multiple arguments path
          if (argsLength > 0 && typeof args[0] === 'string') {
            args[0] = `${formattedPrefix} ${args[0]}`;
            rawMethod(...args);
          } else {
            rawMethod(formattedPrefix, ...args);
          }
        });
      };
    };

    logger.methodFactory = newFactory;
    logger.setLevel(logger.getLevel());

    return logger;
  }

  public static getInstance(config?: LoggerConfig): log.Logger {
    const loggerConfig = config ?? defaultConfig;

    if (!this.instances.has(loggerConfig.name)) {
      const instance = this.createLoggerInstance(loggerConfig);
      this.instances.set(loggerConfig.name, instance);
    }

    return this.instances.get(loggerConfig.name)!;
  }

  /**
   * Install window-level error/rejection capture. Idempotent. No-op on the
   * server (typeof window === 'undefined'). Call once at client bootstrap
   * (e.g. main.ts) AFTER the Logger singleton is constructed.
   *
   * The handler bodies live in `LoggerGlobalCapture.ts` to keep this file
   * under the 450-LOC cap.
   */
  public static installGlobalErrorCapture(): void {
    // Hand the satellite the shared `logger` singleton (a Logger instance),
    // which is constructed at module-load via `new Logger(defaultConfig)`.
    installGlobalErrorCapture(logger);
  }

  public static setLogLevel(level: log.LogLevelDesc): void {
    this.getInstance().setLevel(level);
  }

  public static getLogLevel(): log.LogLevel[keyof log.LogLevel] {
    return this.getInstance().getLevel();
  }

  public static enableLog(): void {
    this.getInstance().enableAll();
  }

  public static disableLog(): void {
    this.getInstance().disableAll();
  }

  /**
   * Whether this logger instance would currently emit debug-level messages.
   * Lets hot call-sites skip building expensive log arguments (e.g.
   * JSON.stringify'd payloads on the input-send path) when the line would be
   * dropped anyway. Read-only — does not mutate the logger state.
   */
  public isDebugEnabled(): boolean {
    return this.#logger.getLevel() <= log.levels.DEBUG;
  }

  public debug(message: string, ...args: unknown[]): void {
    this.#logger.debug(message, ...args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.#logger.info(message, ...args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.#logger.warn(message, ...args);
  }

  public error(message: string, ...args: unknown[]): void {
    this.#logger.error(message, ...args);
  }

  public exception(ex: unknown): void {
    if (ex instanceof Error) {
      this.#logger.error(ex.message, ex.stack);
    } else {
      this.#logger.error(ex);
    }
  }
}

export const logger = new Logger(defaultConfig);
export const netLogger = new Logger(networkConfig);

declare global {
  interface Window {
    logger: log.Logger;
    netLogger: log.Logger;
  }
}
