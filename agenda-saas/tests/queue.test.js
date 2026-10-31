import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, one } from "../server/db.js";
import { encryptSecret } from "../server/security.js";
import {
  processOne,
  recoverStale,
  heartbeat,
  workerHealth,
  runWorkerTick,
  liveMessagingEnabled,
} from "../server/whatsapp.js";

process.env.NODE_ENV = "test";
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.WHATSAPP_MODE = "live";
process.env.WORKER_MAX_ATTEMPTS = "3";

let db, tenant, appointment;

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const SENT = response(200, { messages: [{ id: "wamid.TESTE123" }] });
const RATE_LIMITED = response(429, { error: { code: 131056 } });
const SERVER_ERROR = response(500, { error: { code: 1 } });
const REJECTED = response(400, { error: { code: 132000 } });

async function enqueue(kind = "confirmation", options = {}) {
  await db.query("DELETE FROM outbox WHERE appointment_id=$1", [
    appointment.id,
  ]);
  await db.query(
    `INSERT INTO outbox(id,tenant_id,appointment_id,kind,scheduled_at,status,attempts,next_attempt_at,max_attempts)
     VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8)`,
    [
      randomUUID(),
      tenant.id,
      appointment.id,
      kind,
      options.scheduledAt || new Date(Date.now() - 1000),
      options.attempts || 0,
      options.nextAttemptAt || new Date(Date.now() - 1000),
      options.maxAttempts || 3,
    ],
  );
}

before(async () => {
  db = await createDb(":memory:");
  const ids = {
    tenant: randomUUID(),
    pro: randomUUID(),
    service: randomUUID(),
    client: randomUUID(),
    appointment: randomUUID(),
  };
  tenant = { id: ids.tenant };
  await db.query(
    "INSERT INTO tenants(id,name,slug,timezone) VALUES($1,'Clínica Fila',$2,'America/Sao_Paulo')",
    [ids.tenant, `fila-${ids.tenant.slice(0, 6)}`],
  );
  await db.query(
    "INSERT INTO professionals(id,tenant_id,name,specialty) VALUES($1,$2,'Dra. Fila','Clínica')",
    [ids.pro, ids.tenant],
  );
  await db.query(
    "INSERT INTO services(id,tenant_id,name,duration_minutes,buffer_minutes) VALUES($1,$2,'Consulta',50,10)",
    [ids.service, ids.tenant],
  );
  await db.query(
    "INSERT INTO clients(id,tenant_id,name,phone_e164) VALUES($1,$2,'Cliente Fila','+5543999998888')",
    [ids.client, ids.tenant],
  );
  const starts = new Date(Date.now() + 3 * 86_400_000);
  appointment = { id: ids.appointment, starts };
  await db.query(
    `INSERT INTO appointments(id,tenant_id,professional_id,service_id,client_id,starts_at,ends_at,blocked_until,status,client_token_hash,consent_at,whatsapp_opt_in,idempotency_key,request_fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'confirmed','hash-teste',$9,true,$10,'fp')`,
    [
      ids.appointment,
      ids.tenant,
      ids.pro,
      ids.service,
      ids.client,
      starts,
      new Date(starts.getTime() + 3_000_000),
      new Date(starts.getTime() + 3_600_000),
      new Date(),
      randomUUID(),
    ],
  );
  await db.query(
    `INSERT INTO whatsapp_configs(tenant_id,phone_number_id,access_token_cipher,enabled)
     VALUES($1,'1234567890',$2,true)`,
    [ids.tenant, await encryptSecret("token-de-teste")],
  );
});

after(async () => {
  await db?.close();
  delete process.env.WHATSAPP_MODE;
});

beforeEach(async () => {
  await db.query("DELETE FROM worker_heartbeats");
  await db.query(
    "UPDATE appointments SET whatsapp_opt_in=true, status='confirmed' WHERE id=$1",
    [appointment.id],
  );
  await db.query(
    "UPDATE whatsapp_configs SET enabled=true, phone_number_id='1234567890', access_token_cipher=$2 WHERE tenant_id=$1",
    [tenant.id, await encryptSecret("token-de-teste")],
  );
});

describe("fila de WhatsApp confiável", () => {
  test("entrega bem-sucedida marca como enviada com o id do provedor", async () => {
    await enqueue();
    const result = await processOne(db, async () => SENT);
    assert.equal(result.sent, true);
    const job = await one(db, "SELECT * FROM outbox WHERE appointment_id=$1", [
      appointment.id,
    ]);
    assert.equal(job.status, "sent");
    assert.equal(job.provider_message_id, "wamid.TESTE123");
    assert.equal(job.attempts, 1);
    assert.equal(job.locked_at, null);
  });

  test("429 reagenda com backoff exponencial em vez de perder a mensagem", async () => {
    await enqueue("confirmation", { attempts: 1 });
    const result = await processOne(db, async () => RATE_LIMITED);
    assert.equal(result.retry, true);
    const job = await one(db, "SELECT * FROM outbox WHERE appointment_id=$1", [
      appointment.id,
    ]);
    assert.equal(job.status, "queued");
    assert.equal(job.error_code, "meta_131056");
    assert.equal(job.attempts, 2);
    const wait = new Date(job.next_attempt_at).getTime() - Date.now();
    assert.ok(wait > 30_000, `espera de backoff muito curta: ${wait}ms`);
    assert.ok(
      Math.abs(result.delay - wait) < 2000,
      "o retorno informa o mesmo atraso gravado",
    );
  });

  test("esgotar as tentativas em 429 encerra em dead-letter", async () => {
    await enqueue("confirmation", { attempts: 2, maxAttempts: 3 });
    const result = await processOne(db, async () => RATE_LIMITED);
    assert.equal(result.dead, true);
    const job = await one(db, "SELECT * FROM outbox WHERE appointment_id=$1", [
      appointment.id,
    ]);
    assert.equal(job.status, "dead");
    assert.ok(job.dead_at, "dead_at registra quando desistiu");
    const again = await processOne(db, async () => SENT);
    assert.equal(again.idle, true, "job morto não é reivindicado de novo");
  });

  test("erro 5xx é entrega ambígua: vira 'unknown' e nunca é reenviado cegamente", async () => {
    await enqueue();
    const result = await processOne(db, async () => SERVER_ERROR);
    assert.equal(result.ambiguous, true);
    const job = await one(db, "SELECT * FROM outbox WHERE appointment_id=$1", [
      appointment.id,
    ]);
    assert.equal(job.status, "unknown");
    assert.equal(job.error_code, "meta_1");
    const again = await processOne(db, async () => SENT);
    assert.equal(again.idle, true);
  });

  test("timeout de rede também fica 'unknown'", async () => {
    await enqueue();
    const result = await processOne(db, async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError",
      });
    });
    assert.equal(result.unknown, true);
    const job = await one(
      db,
      "SELECT status,error_code FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "unknown");
    assert.equal(job.error_code, "delivery_unconfirmed");
  });

  test("rejeição definitiva da Meta não fica em loop de retentativa", async () => {
    await enqueue();
    const result = await processOne(db, async () => REJECTED);
    assert.equal(result.failed, true);
    const job = await one(
      db,
      "SELECT status,next_attempt_at FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "failed");
    assert.equal(new Date(job.next_attempt_at).getTime(), 0, "não reagenda");
  });

  test("worker interrompido no meio do envio é recuperado como 'unknown'", async () => {
    await enqueue();
    await db.query(
      "UPDATE outbox SET status='processing', locked_at=now() - interval '10 minutes' WHERE appointment_id=$1",
      [appointment.id],
    );
    const recovered = await recoverStale(db);
    assert.equal(recovered, 1);
    const job = await one(
      db,
      "SELECT status,error_code FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "unknown");
    assert.equal(job.error_code, "worker_interrupted");
  });

  test("mensagem em processamento recente não é roubada por outro worker", async () => {
    await enqueue();
    await db.query(
      "UPDATE outbox SET status='processing', locked_at=now() WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(await recoverStale(db), 0);
  });

  test("desistência do cliente (opt-out) marca como ignorada, sem envio", async () => {
    await enqueue();
    await db.query(
      "UPDATE appointments SET whatsapp_opt_in=false WHERE id=$1",
      [appointment.id],
    );
    let called = false;
    const result = await processOne(db, async () => {
      called = true;
      return SENT;
    });
    assert.equal(called, false, "não chama a Meta");
    assert.equal(result.skip, true);
    assert.equal(result.reason, "no_consent");
    const job = await one(
      db,
      "SELECT status,error_code FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "skipped");
    assert.equal(job.error_code, "no_consent");
  });

  test("consulta cancelada não recebe confirmação pendente", async () => {
    await enqueue();
    await db.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [
      appointment.id,
    ]);
    const result = await processOne(db, async () => SENT);
    assert.equal(result.skip, true);
    assert.equal(result.reason, "appointment_ineligible");
  });

  test("lembrete vencido (mais de 30 min atrasado) é ignorado em vez de enviado fora de hora", async () => {
    await enqueue("reminder_2h", {
      scheduledAt: new Date(Date.now() - 2 * 3_600_000),
    });
    const result = await processOne(db, async () => SENT);
    assert.equal(result.skip, true);
    assert.equal(result.reason, "expired_window");
  });

  test("sem credencial habilitada a fila espera, sem queimar tentativas", async () => {
    await enqueue();
    await db.query(
      "UPDATE whatsapp_configs SET enabled=false WHERE tenant_id=$1",
      [tenant.id],
    );
    const result = await processOne(db, async () => SENT);
    assert.ok(result.waiting || result.idle, "a fila não é consumida");
    const job = await one(
      db,
      "SELECT status,attempts FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "queued");
    assert.equal(job.attempts, 0);
  });

  test("token ilegível falha sem tentar a rede", async () => {
    await enqueue();
    await db.query(
      "UPDATE whatsapp_configs SET access_token_cipher='lixo' WHERE tenant_id=$1",
      [tenant.id],
    );
    let called = false;
    const result = await processOne(db, async () => {
      called = true;
      return SENT;
    });
    assert.equal(called, false);
    assert.equal(result.failed, true);
    const job = await one(
      db,
      "SELECT status,error_code FROM outbox WHERE appointment_id=$1",
      [appointment.id],
    );
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "credential_decrypt_failed");
  });

  test("o worker publica sinal de vida e a prontidão o reconhece", async () => {
    assert.equal((await workerHealth(db)).healthy, false, "sem sinal ainda");
    await db.query("DELETE FROM outbox WHERE appointment_id=$1", [
      appointment.id,
    ]);
    const stats = await runWorkerTick(db, 3);
    assert.equal(stats.sent, 0);
    const health = await workerHealth(db);
    assert.equal(health.healthy, true);
    await db.query(
      "UPDATE worker_heartbeats SET last_seen_at = now() - interval '10 minutes'",
    );
    const stale = await workerHealth(db);
    assert.equal(stale.healthy, false);
    assert.match(stale.reason, /sinal/);
    await heartbeat(db, { teste: true });
    assert.equal((await workerHealth(db)).healthy, true);
  });

  test("modo desligado não consome a fila", async () => {
    await enqueue();
    const saved = process.env.WHATSAPP_MODE;
    process.env.WHATSAPP_MODE = "disabled";
    assert.equal(liveMessagingEnabled(), false);
    const result = await processOne(db, async () => SENT);
    assert.equal(result.waiting, true);
    process.env.WHATSAPP_MODE = saved;
  });
});
