/** Tiny structured logger. Replace with pino/OpenTelemetry in a real system. */
const verbose = process.env.VERBOSE === '1' || process.argv.includes('--verbose');

function line(level: string, scope: string, message: string): string {
  return `${new Date().toISOString().slice(11, 19)} ${level.padEnd(5)} [${scope}] ${message}`;
}

export const log = {
  info: (scope: string, message: string) => console.log(line('info', scope, message)),
  warn: (scope: string, message: string) => console.warn(line('warn', scope, message)),
  error: (scope: string, message: string) => console.error(line('error', scope, message)),
  debug: (scope: string, message: string) => {
    if (verbose) console.log(line('debug', scope, message));
  },
};
