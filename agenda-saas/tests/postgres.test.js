import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createDb, one } from "../server/db.js";
import { createApp } from "../server/app.js";
import { createWorkspace, book, decide } from "../server/domain.js";
import { digest } from "../server/security.js";
import { localDate, addDays } from "../server/time.js";
import { migrationStatus } from "../server/migrate.js";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_MODE = "disabled";
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

/**
 * Exercita o caminho PostgreSQL real (driver `pg` + protocolo de rede), não o
 * PGlite embutido. Em CI usa TEST_DATABASE_URL; localmente sobe um servidor
 * compatível com o protocolo do Postgres em memória.
 */
let db, app, cleanup, seededEmail;
const externalUrl = process.env.TEST_DATABASE_URL;

before(async () => {
  let url = externalUrl;
  if (!url) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { btree_gist } = await import(
      "@electric-sql/pglite/contrib/btree_gist"
    );
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const pglite = await PGlite.create({ extensions: { btree_gist } });
    const server = new PGLiteSocketServer({
      db: pglite,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 10,
    });
    await server.start();
    url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
    cleanup = async () => {
      await server.stop();
      await pglite.close();
    };
  }
  process.env.DATABASE_URL = url;
  db = await createDb({ url, poolMax: 4 });
  app = createApp(db, { dev: true });
  seededEmail = `dono-${randomUUID().slice(0, 8)}@pg.demo`;
  await createWorkspace(db, {
    workspace: `Clínica PG ${randomUUID().slice(0, 6)}`,
    name: "Dono PG",
    email: seededEmail,
    password: "senha-de-teste-longa",
    privacy: true,
  });
});

after(async () => {
  await db?.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  await cleanup?.();
  delete process.env.DATABASE_URL;
});

describe("PostgreSQL real (driver pg)", () => {
  test("o adaptador reporta postgres e aplica as migrações", async () => {
    assert.equal(db.kind, "postgres");
    const status = await migrationStatus(db);
    assert.equal(status.pending.length, 0);
    assert.equal(status.changed.length, 0);
    assert.ok(status.applied.some((v) => v.startsWith("0001")));
    assert.ok(status.applied.some((v) => v.startsWith("0002")));
  });

  test("rodar migrações de novo é seguro (idempotente)", async () => {
    const { migrate } = await import("../server/migrate.js");
    const result = await migrate(db);
    assert.deepEqual(result.applied, []);
  });

  test("transação reverte tudo em caso de erro", async () => {
    const id = randomUUID();
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO rate_buckets(key,count,resets_at) VALUES($1,1,now())",
          [id],
        );
        throw new Error("falha simulada");
      }),
    );
    assert.equal(
      await one(db, "SELECT key FROM rate_buckets WHERE key=$1", [id]),
      null,
    );
  });

  test("a exclusão de sobreposição funciona no PostgreSQL real", async () => {
    const tenant = await one(
      db,
      "SELECT t.* FROM tenants t JOIN memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id WHERE u.email=$1",
      [seededEmail],
    );
    const pro = await one(
      db,
      "SELECT * FROM professionals WHERE tenant_id=$1",
      [tenant.id],
    );
    const service = await one(db, "SELECT * FROM services WHERE tenant_id=$1", [
      tenant.id,
    ]);
    let day = addDays(localDate(new Date(), tenant.timezone), 1);
    while ([0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay()))
      day = addDays(day, 1);
    const input = {
      professionalId: pro.id,
      serviceId: service.id,
      date: day,
      time: "09:00",
      name: "Cliente PG",
      phone: "+5543999990000",
      notes: "",
      consent: true,
      whatsappOptIn: true,
      idempotencyKey: randomUUID(),
    };
    const first = await book(db, tenant, input, digest("pg-1"));
    assert.equal(first.appointment.status, "pending");
    const second = await request(app)
      .post(`/api/public/${tenant.slug}/appointments`)
      .send({ ...input, idempotencyKey: randomUUID() });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "SLOT_UNAVAILABLE");
  });

  test("reserva e decisão funcionam pela API com pool de conexões", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: seededEmail, password: "senha-de-teste-longa" });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const me = await request(app).get("/api/me").set("Cookie", cookie);
    const csrf = me.body.csrf;
    const tenant = await one(db, "SELECT * FROM tenants WHERE id=$1", [
      me.body.tenant.id,
    ]);
    const pro = await one(
      db,
      "SELECT * FROM professionals WHERE tenant_id=$1",
      [tenant.id],
    );
    const service = await one(db, "SELECT * FROM services WHERE tenant_id=$1", [
      tenant.id,
    ]);
    let day = addDays(localDate(new Date(), tenant.timezone), 3);
    while ([0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay()))
      day = addDays(day, 1);
    const created = await request(app)
      .post(`/api/public/${tenant.slug}/appointments`)
      .send({
        professionalId: pro.id,
        serviceId: service.id,
        date: day,
        time: "10:00",
        name: "Cliente API PG",
        phone: "(43) 98888-7777",
        notes: "",
        consent: true,
        whatsappOptIn: true,
        idempotencyKey: randomUUID(),
      });
    assert.equal(created.status, 201);
    const confirmed = await request(app)
      .post(`/api/appointments/${created.body.appointment.id}/decision`)
      .set("Cookie", cookie)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status, "confirmed");
    const jobs = await db.query(
      "SELECT kind FROM outbox WHERE appointment_id=$1",
      [created.body.appointment.id],
    );
    assert.ok(jobs.rows.some((j) => j.kind === "confirmation"));
  });

  test("prontidão responde 200 com banco e migrações em dia", async () => {
    const res = await request(app).get("/api/ready");
    assert.equal(res.status, 200);
    assert.equal(res.body.checks.database, true);
    assert.equal(res.body.checks.migrations, true);
  });

  test("prontidão responde 503 quando o banco cai", async () => {
    const outage = Object.assign(
      new Error("connection terminated unexpectedly"),
      { code: "ECONNRESET" },
    );
    const broken = {
      ...db,
      ping: async () => {
        throw outage;
      },
      query: async () => {
        throw outage;
      },
    };
    const brokenApp = createApp(broken, { dev: true });
    const res = await request(brokenApp).get("/api/ready");
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.checks.database, false);
    assert.equal(res.body.detail.error, "database_unavailable");
    const health = await request(brokenApp).get("/api/health");
    assert.equal(health.status, 200, "vivacidade não depende do banco");
    const api = await request(brokenApp).get("/api/public/qualquer-clinica");
    assert.equal(api.status, 503, "queda de banco vira 503, não 500");
    assert.equal(api.body.error.code, "DATABASE_UNAVAILABLE");
  });
});
