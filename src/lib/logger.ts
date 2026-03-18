/**
 * Structured logger for app and telemetry. Use instead of console.log for debuggability.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const payload = { level, message, ...meta, timestamp: new Date().toISOString() };
  return JSON.stringify(payload);
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('debug')) process.stdout.write(formatMessage('debug', message, meta) + '\n');
  },
  info(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('info')) process.stdout.write(formatMessage('info', message, meta) + '\n');
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('warn')) process.stdout.write(formatMessage('warn', message, meta) + '\n');
  },
  error(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('error')) process.stderr.write(formatMessage('error', message, meta) + '\n');
  },
};
