import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, one } from "../server/db.js";
import { migrate, migrationStatus } from "../server/migrate.js";
import { createApp } from "../server/app.js";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");

let db;

before(async () => {
  db = await createDb(":memory:");
});

after(async () => {
  await db?.close();
});

describe("migrações versionadas", () => {
  test("aplicam todas as versões e registram checksum", async () => {
    const status = await migrationStatus(db);
    assert.deepEqual(status.pending, []);
    assert.deepEqual(status.changed, []);
    const rows = await db.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    assert.ok(rows.rows.length >= 2);
    for (const row of rows.rows) assert.match(row.checksum, /^[a-f0-9]{64}$/);
  });

  test("reexecução não aplica nada de novo", async () => {
    const before = await db.query(
      "SELECT count(*)::int AS total FROM schema_migrations",
    );
    const result = await migrate(db);
    const after = await db.query(
      "SELECT count(*)::int AS total FROM schema_migrations",
    );
    assert.deepEqual(result.applied, []);
    assert.equal(after.rows[0].total, before.rows[0].total);
  });

  test("recusa iniciar quando uma migração aplicada foi editada", async () => {
    const original = await one(
      db,
      "SELECT checksum FROM schema_migrations WHERE version LIKE '0001%'",
    );
    await db.query(
      "UPDATE schema_migrations SET checksum='divergente' WHERE version LIKE '0001%'",
    );
    await assert.rejects(migrate(db), /Migração já aplicada foi modificada/);
    const status = await migrationStatus(db);
    assert.equal(status.changed.length, 1);
    const res = await request(createApp(db, { dev: true })).get("/api/ready");
    assert.equal(res.status, 503);
    assert.equal(res.body.checks.migrations, false);
    assert.equal(res.body.detail.changedMigrations, 1);
    await db.query(
      "UPDATE schema_migrations SET checksum=$1 WHERE version LIKE '0001%'",
      [original.checksum],
    );
    assert.equal(
      (await request(createApp(db, { dev: true })).get("/api/ready")).status,
      200,
    );
  });

  test("a coluna de bloqueio de sobreposição existe no banco", async () => {
    const constraint = await one(
      db,
      "SELECT conname FROM pg_constraint WHERE conrelid='appointments'::regclass AND contype='x'",
    );
    assert.ok(constraint, "a exclusão EXCLUDE do Postgres deve existir");
    const indexes = await db.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='outbox'",
    );
    const names = indexes.rows.map((r) => r.indexname);
    for (const index of ["outbox_ready", "outbox_processing", "outbox_unknown"])
      assert.ok(names.includes(index), `índice ausente: ${index}`);
  });

  test("a fila tem as colunas de retry e dead-letter", async () => {
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='outbox'",
    );
    const names = columns.rows.map((c) => c.column_name);
    for (const column of [
      "max_attempts",
      "dead_at",
      "last_error_at",
      "locked_at",
      "next_attempt_at",
    ]) {
      assert.ok(names.includes(column), `coluna ausente: ${column}`);
    }
  });
});
