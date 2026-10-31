const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const DEFAULT_LEVEL = process.env.NODE_ENV === "test" ? "silent" : "info";

function serializeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    code: error.code || error.code === 0 ? error.code : undefined,
    message: String(error.message || error).slice(0, 300),
  };
}

/**
 * Logs em uma linha JSON por evento. Nunca registra corpo de requisição,
 * cookies, tokens, telefone ou observações de clientes.
 */
function emit(level, event, detail = {}) {
  if (LEVELS[level] < LEVELS[process.env.LOG_LEVEL || DEFAULT_LEVEL]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: process.env.APP_NAME || "aurora-agenda",
    event,
    ...detail,
    ...(detail.error ? { error: serializeError(detail.error) } : {}),
  };
  const output = JSON.stringify(line);
  if (level === "error" || level === "warn")
    process.stderr.write(output + "\n");
  else process.stdout.write(output + "\n");
}

export const logger = {
  debug: (event, detail) => emit("debug", event, detail),
  info: (event, detail) => emit("info", event, detail),
  warn: (event, detail) => emit("warn", event, detail),
  error: (event, detail) => emit("error", event, detail),
};

/** Log de acesso sem query string (que pode conter tokens) e sem PII. */
export function accessLog(req, res, startedAt, requestId) {
  const path = (req.originalUrl || req.url || "/").split("?")[0];
  if (path === "/api/health" || path === "/api/ready") return;
  const level =
    res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
  emit(level, "http.request", {
    requestId,
    method: req.method,
    path,
    status: res.statusCode,
    durationMs: Date.now() - startedAt,
    ip: req.ip,
  });
}
