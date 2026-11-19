export interface StellarLogger {
  warn(message: string, meta?: unknown): void;
}

const consoleLogger: StellarLogger = {
  warn(message, meta) {
    console.warn(message, meta);
  },
};

let activeLogger: StellarLogger = consoleLogger;

/**
 * Inject the platform logger (for example the API's winston logger) so Stellar
 * warnings are emitted through structured logging. Passing undefined restores
 * the console fallback.
 */
export function setLogger(logger: StellarLogger | undefined | null): void {
  activeLogger = logger ?? consoleLogger;
}

export function getLogger(): StellarLogger {
  return activeLogger;
}

export function warn(message: string, meta?: unknown): void {
  if (meta === undefined) {
    activeLogger.warn(message);
  } else {
    activeLogger.warn(message, meta);
  }
}
