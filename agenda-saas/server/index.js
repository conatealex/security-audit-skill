import http from "node:http";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import express from "express";
import { createDb } from "./db.js";
import { createApp } from "./app.js";
import { seedDemo } from "./seed.js";
import { startWorker, workerHealth } from "./whatsapp.js";
import { getMasterKey } from "./security.js";
import { migrate } from "./migrate.js";
import { logger } from "./logger.js";
import { APP_VERSION } from "./version.js";

const dev = process.argv.includes("--dev");
const port = Number(process.env.PORT || 3000);
const version = APP_VERSION;
const shutdownTimeout = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled_rejection", {
    error: reason instanceof Error ? reason : String(reason),
  });
});
process.on("uncaughtException", (error) => {
  logger.error("process.uncaught_exception", { error });
  // Estado desconhecido: encerra para o supervisor reiniciar em condição limpa.
  setTimeout(() => process.exit(1), 500).unref();
});

// Falha cedo e com mensagem clara: variável ausente em produção derruba o deploy,
// não o primeiro cliente que tentar entrar.
function validateEnv() {
  const problems = [];
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL && process.env.ALLOW_EPHEMERAL_DB !== "true")
      problems.push(
        "DATABASE_URL ausente: em produção use um PostgreSQL gerenciado (ALLOW_EPHEMERAL_DB=true apenas para testes).",
      );
    if (!process.env.DATA_ENCRYPTION_KEY)
      problems.push("DATA_ENCRYPTION_KEY ausente (32 bytes em base64).");
    if (!process.env.APP_ORIGIN)
      problems.push(
        "APP_ORIGIN ausente (ex.: https://agenda.suaclinica.com.br).",
      );
    if (process.env.WHATSAPP_MODE === "live" && !process.env.META_APP_SECRET)
      problems.push(
        "META_APP_SECRET ausente com WHATSAPP_MODE=live (webhook sem verificação de assinatura).",
      );
  }
  if (problems.length) {
    for (const problem of problems)
      logger.error("startup.invalid_env", { problem });
    process.exit(1);
  }
}
validateEnv();

const db = await createDb();
await getMasterKey();
if (process.env.MIGRATE_ON_START === "false") {
  logger.warn("startup.migrations_skipped", {
    reason: "MIGRATE_ON_START=false",
  });
} else {
  await migrate(db, { log: (event, detail) => logger.info(event, detail) });
}
if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production")
  await seedDemo(db);

const app = createApp(db, { dev });
const server = http.createServer(app);
let vite;

if (dev) {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve("dist");
  await access(path.join(dist, "index.html")).catch(() => {
    logger.error("startup.build_missing", {
      hint: "rode `npm run build` antes de iniciar",
    });
    process.exit(1);
  });
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
}

const stopWorker = startWorker(db);

const cleanup = async () => {
  await db
    .query("DELETE FROM sessions WHERE expires_at < now()")
    .catch(() => {});
  await db
    .query(
      "DELETE FROM rate_buckets WHERE resets_at < now() - interval '1 day'",
    )
    .catch(() => {});
  await db
    .query(
      "DELETE FROM audit_events WHERE created_at < now() - interval '2 years'",
    )
    .catch(() => {});
};
const cleanupTimer = setInterval(cleanup, 3_600_000);
cleanupTimer.unref();
await cleanup().catch(() => {});

server.listen(port, "0.0.0.0", () => {
  logger.info("server.started", {
    port,
    version,
    database: db.kind,
    whatsapp: process.env.WHATSAPP_MODE === "live" ? "live" : "disabled",
    env: process.env.NODE_ENV || "development",
  });
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info("server.stopping", { signal });
  const timer = setTimeout(() => {
    logger.error("server.shutdown_timeout", { timeoutMs: shutdownTimeout });
    process.exit(1);
  }, shutdownTimeout);
  timer.unref();
  try {
    clearInterval(cleanupTimer);
    // Para de aceitar conexões, encerra o ciclo do worker em andamento e só
    // então libera o pool — nenhum envio fica com a linha travada em 'processing'.
    await new Promise((resolve) => server.close(resolve));
    await stopWorker();
    await vite?.close();
    await db.close();
    logger.info("server.stopped", {});
    process.exit(0);
  } catch (error) {
    logger.error("server.shutdown_failed", { error });
    process.exit(1);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
