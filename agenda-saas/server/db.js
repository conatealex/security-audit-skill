import { mkdir } from "node:fs/promises";
import path from "node:path";
import { migrate } from "./migrate.js";
import { logger } from "./logger.js";

const normalize = (result) => ({
  rows: result?.rows ?? [],
  affectedRows: result?.affectedRows ?? result?.rowCount ?? 0,
});
const txClient = (client) => ({
  query: async (sql, params = []) => normalize(await client.query(sql, params)),
  // Sem parâmetros o driver usa o protocolo simples, aceitando múltiplos comandos.
  exec: async (sql) => {
    if (typeof client.exec === "function") await client.exec(sql);
    else await client.query(sql);
  },
});

/** Erros de conexão que devem virar 503 (tentar de novo), não 500. */
export function isTransient(error) {
  const code = error?.code;
  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "57P01",
      "57P02",
      "57P03",
      "08000",
      "08003",
      "08006",
      "53300",
    ].includes(code) ||
    /connection terminated|timeout exceeded when trying to connect|server closed the connection/i.test(
      error?.message || "",
    )
  );
}

async function createPostgres(
  url,
  {
    poolMax = Number(process.env.DB_POOL_MAX || 10),
    migrate: runMigrations = true,
  } = {},
) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: url,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30_000),
    application_name: process.env.APP_NAME || "aurora-agenda",
    keepAlive: true,
  });
  pool.on("error", (error) =>
    logger.error("db.idle_client_error", { code: error.code || "unknown" }),
  );

  const retries = Number(process.env.DB_CONNECT_RETRIES || 15);
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt >= retries) throw error;
      const delay = Math.min(500 * 2 ** (attempt - 1), 8_000);
      logger.warn("db.connect_retry", {
        attempt,
        delayMs: delay,
        code: error.code || "unknown",
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const db = {
    kind: "postgres",
    query: async (sql, params = []) => normalize(await pool.query(sql, params)),
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL timezone = 'UTC'");
        const result = await fn(txClient(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    ping: async () => {
      await pool.query("SELECT 1");
    },
    close: () => pool.end(),
    stats: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }),
  };
  if (runMigrations)
    await migrate(db, { log: (event, detail) => logger.info(event, detail) });
  return db;
}

async function createPglite(location, { migrate: runMigrations = true } = {}) {
  // Import tardio: em produção (PostgreSQL) o PGlite/WASM nunca é carregado, e
  // empacotadores serverless não incluem 30 MB de binário à toa.
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  if (location !== ":memory:")
    await mkdir(path.dirname(path.resolve(location)), {
      recursive: true,
      mode: 0o700,
    });
  const pglite = await PGlite.create({
    dataDir: location === ":memory:" ? undefined : location,
    extensions: { btree_gist },
  });
  const db = {
    kind: "pglite",
    query: async (sql, params = []) =>
      normalize(await pglite.query(sql, params)),
    exec: async (sql) => {
      await pglite.exec(sql);
    },
    transaction: (fn) =>
      pglite.transaction(async (tx) => {
        await tx.query("SET LOCAL timezone = 'UTC'");
        return fn(txClient(tx));
      }),
    ping: async () => {
      await pglite.query("SELECT 1");
    },
    close: () => pglite.close(),
    stats: () => ({}),
  };
  if (runMigrations)
    await migrate(db, { log: (event, detail) => logger.info(event, detail) });
  return db;
}

/**
 * PostgreSQL gerenciado quando `DATABASE_URL` existe (produção);
 * PGlite em disco para desenvolvimento local e testes.
 */
export async function createDb(options = {}, extra = {}) {
  if (typeof options === "string") options = { location: options, ...extra };
  else options = { ...options, ...extra };
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) return createPostgres(url, options);
  const location =
    options.location ?? process.env.DATABASE_PATH ?? "./data/aurora";
  return createPglite(location, options);
}

export const one = async (db, sql, params = []) =>
  (await db.query(sql, params)).rows[0] || null;
export const many = async (db, sql, params = []) =>
  (await db.query(sql, params)).rows;
export async function transaction(db, fn) {
  return db.transaction(fn);
}
export function httpError(status, message, code = "REQUEST_ERROR") {
  return Object.assign(new Error(message), { status, code, expose: true });
}
export async function audit(
  db,
  tenantId,
  actor,
  action,
  entityId,
  metadata = {},
) {
  await db.query(
    "INSERT INTO audit_events(tenant_id,actor_user_id,actor_type,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [
      tenantId,
      actor?.userId || null,
      actor?.type || "system",
      action,
      entityId,
      JSON.stringify(metadata),
    ],
  );
}
