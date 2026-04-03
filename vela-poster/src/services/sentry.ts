/**
 * Sentry — disabled. No external error reporting.
 * Errors are logged to console only.
 */

export function captureException(error: Error, _context?: Record<string, any>): void {
  console.error('[Error]', error.message);
}

export function captureMessage(message: string, _level?: string, _context?: Record<string, any>): void {
  console.warn('[Message]', message);
}
