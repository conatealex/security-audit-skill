import { createHash } from "node:crypto";
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Localiza a pasta de migrações. Em servidor comum ela fica ao lado deste
 * arquivo; em ambientes empacotados (Netlify Functions) o código é reunido em
 * outro diretório, então procuramos também a partir da raiz de trabalho.
 */
let directory;
async function migrationDirectory() {
  if (directory) return directory;
  const candidates = [];
  if (process.env.MIGRATIONS_DIR) candidates.push(process.env.MIGRATIONS_DIR);
  try {
    candidates.push(fileURLToPath(new URL("./migrations/", import.meta.url)));
  } catch {
    // Ambiente empacotado sem import.meta (bundle CommonJS).
  }
  candidates.push(path.join(process.cwd(), "server", "migrations"));
  candidates.push(path.join(process.cwd(), "migrations"));
  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, "0001_baseline.sql").replace(/\/+$/, ""));
      directory = candidate;
      return directory;
    } catch {
      // tenta o próximo
    }
  }
  directory = candidates[0];
  throw new Error(`Pasta de migrações não encontrada (procurado em: ${candidates.join(", ")})`);
}
const LOCK_KEY = "aurora:schema-migrations";

async function lock(db) {
  if (db.kind === "postgres")
    await db.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
}

async function unlock(db) {
  if (db.kind === "postgres")
    await db.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
}

async function tableExists(db, name) {
  const res = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
    [name],
  );
  return res.rows.length > 0;
}

export async function migrationStatus(db) {
  // Antes da primeira migração a tabela de controle ainda não existe.
  const rows = (await tableExists(db, "schema_migrations"))
    ? await db.query(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      )
    : { rows: [] };
  const directory = await migrationDirectory();
  const files = (await readdir(directory))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = new Map(
    (rows.rows || []).map((r) => [r.version, r.checksum]),
  );
  const pending = [];
  const changed = [];
  for (const file of files) {
    const sql = await readFile(path.join(await migrationDirectory(), file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (!applied.has(file)) pending.push(file);
    else if (applied.get(file) !== checksum) changed.push(file);
  }
  return {
    pending,
    changed,
    applied: [...applied.keys()],
    total: files.length,
  };
}

/**
 * Aplica as migrações em ordem, sob trava de banco. Recusa iniciar quando um
 * arquivo já aplicado foi alterado — evita divergência silenciosa entre ambientes.
 */
async function ensureMigrationsTable(db) {
  if (await tableExists(db, "schema_migrations")) return;
  // Uma execução interrompida no meio do DDL pode deixar o tipo composto sem a
  // tabela; sem essa limpeza o boot falharia para sempre com "type already exists".
  const orphan = await db.query(
    "SELECT 1 FROM pg_type WHERE typname = 'schema_migrations' AND typtype = 'c'",
  );
  if (orphan.rows.length)
    await db.query("DROP TYPE IF EXISTS schema_migrations");
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function migrate(db, { log = () => {} } = {}) {
  await ensureMigrationsTable(db);
  await lock(db);
  try {
    const status = await migrationStatus(db);
    if (status.changed.length) {
      throw new Error(
        `Migração já aplicada foi modificada: ${status.changed.join(", ")}. Crie uma nova migração em vez de editar a antiga.`,
      );
    }
    for (const version of status.pending) {
      const sql = await readFile(path.join(await migrationDirectory(), version), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const started = Date.now();
      // DDL + registro na mesma transação: ou a migração inteira vale, ou nada muda.
      await db.transaction(async (tx) => {
        if (typeof tx.exec === "function") await tx.exec(sql);
        else await tx.query(sql);
        await tx.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2) ON CONFLICT(version) DO NOTHING",
          [version, checksum],
        );
      });
      log("migration.applied", { version, ms: Date.now() - started });
    }
    return { applied: status.pending, pending: [], total: status.total };
  } finally {
    await unlock(db).catch(() => {});
  }
}
