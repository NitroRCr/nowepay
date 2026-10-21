type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

const SECRET_KEYS = /^(sign|key|apikey|api_key|ipnsecret|x-api-key|authorization)$/i;

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SECRET_KEYS.test(k)) out[k] = "***";
    else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Error)) out[k] = redact(v as Record<string, unknown>);
    else if (v instanceof Error) out[k] = v.message;
    else out[k] = v;
  }
  return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < min) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...redact(fields) });
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
