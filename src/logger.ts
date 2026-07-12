// Tiny leveled logger. No dependency; also exposes a Baileys-compatible logger
// so we don't need to pull in `pino`.

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Fall back to "info" for an unset OR unrecognized level. A bad value (typo,
// "verbose", uppercase "WARN") must never make LEVEL_ORDER[threshold] undefined,
// which would turn every shouldLog comparison into `n >= NaN` → false and mute
// all output, errors included.
const envLevel = process.env.CRABLITE_LOG_LEVEL;
const threshold: Level =
  envLevel && Object.hasOwn(LEVEL_ORDER, envLevel) ? (envLevel as Level) : "info";

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

function ts(): string {
  // Stable, sortable timestamp without pulling in a date library.
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: Level, args: unknown[]): void {
  if (!shouldLog(level)) return;
  const prefix = `${ts()} ${level.toUpperCase().padEnd(5)}`;
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  const line = args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  stream.write(`${prefix} ${line}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

// Baileys expects a pino-like logger with `.child()` and level methods.
// We give it a mostly-silent one (WhatsApp internals are very chatty at debug).
export function makeBaileysLogger(): any {
  const noop = () => {};
  const logger: any = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: (...a: unknown[]) => emit("warn", ["[wa]", ...a]),
    error: (...a: unknown[]) => emit("error", ["[wa]", ...a]),
    fatal: (...a: unknown[]) => emit("error", ["[wa]", ...a]),
    child: () => logger,
  };
  return logger;
}
