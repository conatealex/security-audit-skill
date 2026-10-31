import { randomUUID, createHmac } from "node:crypto";
import { one, transaction, audit } from "./db.js";
import { decryptSecret, safeEqual } from "./security.js";
import { zoneParts } from "./time.js";
import { logger } from "./logger.js";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const WORKER_NAME = "whatsapp-outbox";
export const liveMessagingEnabled = () => process.env.WHATSAPP_MODE === "live";
const INSTANCE = `${process.env.HOSTNAME || "local"}:${process.pid}`;
const MAX_ATTEMPTS = () => Number(process.env.WORKER_MAX_ATTEMPTS || 5);
const STALE_MS = () => Number(process.env.WORKER_STALE_MS || 120_000);
const BASE_BACKOFF_MS = 60_000;

const templateFor = (config, kind) =>
  kind === "confirmation"
    ? config.confirmation_template
    : kind === "cancellation"
      ? config.cancellation_template
      : config.reminder_template;

export function templatePayload(config, appointment, kind, to) {
  const p = zoneParts(appointment.starts_at, appointment.timezone);
  const date = `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}/${p.year}`;
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const parameters = [
    appointment.client_name,
    appointment.professional_name,
    date,
    time,
    appointment.tenant_name,
  ].map((value) => ({
    type: "text",
    // Modelos da Meta rejeitam quebras de linha e campos muito longos.
    text: String(value ?? "")
      .replace(/[\r\n\t]/g, " ")
      .trim()
      .slice(0, 60),
  }));
  return {
    messaging_product: "whatsapp",
    to: to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: templateFor(config, kind),
      language: { code: config.template_language },
      components: [{ type: "body", parameters }],
    },
  };
}

/** Backoff exponencial com jitter, limitado a 1 hora. */
function backoffMs(attempts) {
  const base = Math.min(
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
    3_600_000,
  );
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

export async function claimDue(db, now = new Date()) {
  if (!liveMessagingEnabled()) return { waiting: true };
  return transaction(db, async (tx) => {
    const job = await one(
      tx,
      `SELECT o.* FROM outbox o
         JOIN whatsapp_configs c ON c.tenant_id = o.tenant_id
        WHERE o.status = 'queued'
          AND o.scheduled_at <= $1
          AND o.next_attempt_at <= $1
          AND o.attempts < o.max_attempts
          AND c.enabled
          AND c.access_token_cipher <> ''
          AND c.phone_number_id ~ '^[0-9]{5,30}$'
        ORDER BY o.scheduled_at
        LIMIT 1
        FOR UPDATE OF o SKIP LOCKED`,
      [now],
    );
    if (!job) return null;
    const a = await one(
      tx,
      `SELECT a.*,p.name professional_name,c.name client_name,c.phone_e164,t.name tenant_name,t.timezone
         FROM appointments a
         JOIN professionals p ON p.id = a.professional_id
         JOIN clients c ON c.id = a.client_id
         JOIN tenants t ON t.id = a.tenant_id
        WHERE a.id = $1 AND a.tenant_id = $2
        FOR UPDATE OF a`,
      [job.appointment_id, job.tenant_id],
    );
    const config = await one(
      tx,
      "SELECT * FROM whatsapp_configs WHERE tenant_id=$1",
      [job.tenant_id],
    );
    const validStatus =
      job.kind === "cancellation"
        ? a?.status === "cancelled"
        : a?.status === "confirmed";
    const staleReminder =
      job.kind.startsWith("reminder_") &&
      (!a ||
        new Date(a.starts_at) <= now ||
        now.getTime() - new Date(job.scheduled_at).getTime() > 30 * 60_000);
    const staleConfirmation =
      job.kind === "confirmation" &&
      now.getTime() - new Date(job.scheduled_at).getTime() > 2 * 3_600_000;

    if (
      !a ||
      !validStatus ||
      !a.whatsapp_opt_in ||
      staleReminder ||
      staleConfirmation
    ) {
      const reason = !validStatus
        ? "appointment_ineligible"
        : !a?.whatsapp_opt_in
          ? "no_consent"
          : "expired_window";
      await tx.query(
        "UPDATE outbox SET status='skipped',error_code=$2,locked_at=NULL WHERE id=$1",
        [job.id, reason],
      );
      return { skip: true, reason };
    }
    if (
      !config?.enabled ||
      !config.access_token_cipher ||
      !/^\d{5,30}$/.test(config.phone_number_id)
    ) {
      return { waiting: true };
    }
    await tx.query(
      "UPDATE outbox SET status='processing',locked_at=$2,attempts=attempts+1 WHERE id=$1",
      [job.id, now],
    );
    return {
      job: await one(tx, "SELECT * FROM outbox WHERE id=$1", [job.id]),
      appointment: a,
      config,
    };
  });
}

/** Mensagens presas em 'processing' por queda do processo viram 'unknown' (nunca reenvio cego). */
export async function recoverStale(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_MS());
  const result = await db.query(
    `UPDATE outbox
        SET status='unknown', error_code='worker_interrupted', locked_at=NULL, last_error_at=now()
      WHERE status='processing' AND locked_at < $1`,
    [cutoff],
  );
  if (result.affectedRows)
    logger.warn("worker.stale_recovered", { count: result.affectedRows });
  return result.affectedRows;
}

const outcome = async (db, job, status, errorCode, extra = {}) => {
  await db.query(
    `UPDATE outbox SET status=$2, error_code=$3, locked_at=NULL, last_error_at=now(),
       next_attempt_at=$4, dead_at=CASE WHEN $2='dead' THEN now() ELSE dead_at END
     WHERE id=$1`,
    [job.id, status, errorCode, extra.nextAttemptAt || new Date(0)],
  );
};

export async function processOne(db, fetchImpl = fetch, now = new Date()) {
  const claim = await claimDue(db, now);
  if (!claim || claim.skip || claim.waiting) return claim || { idle: true };
  const { job, appointment, config } = claim;

  let accessToken;
  try {
    accessToken = await decryptSecret(config.access_token_cipher);
  } catch {
    await outcome(db, job, "failed", "credential_decrypt_failed");
    logger.error("whatsapp.credential_decrypt_failed", { jobId: job.id });
    return { failed: true, id: job.id };
  }

  try {
    const response = await fetchImpl(
      `https://graph.facebook.com/${encodeURIComponent(GRAPH_VERSION)}/${encodeURIComponent(config.phone_number_id)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          templatePayload(
            config,
            appointment,
            job.kind,
            appointment.phone_e164,
          ),
        ),
        signal: AbortSignal.timeout(
          Number(process.env.META_TIMEOUT_MS || 12_000),
        ),
        redirect: "error",
      },
    );
    const body = await response.json().catch(() => ({}));

    if (response.ok && body.messages?.[0]?.id) {
      const providerId = String(body.messages[0].id);
      await transaction(db, async (tx) => {
        const current = await one(
          tx,
          "SELECT status FROM appointments WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [appointment.id, job.tenant_id],
        );
        await tx.query(
          "UPDATE outbox SET status='sent',provider_message_id=$2,sent_at=$3,error_code=NULL,locked_at=NULL WHERE id=$1",
          [job.id, providerId, now],
        );
        const expected =
          job.kind === "cancellation" ? "cancelled" : "confirmed";
        if (current.status !== expected) {
          await audit(
            tx,
            job.tenant_id,
            null,
            "whatsapp.late_delivery",
            appointment.id,
            { kind: job.kind },
          );
        }
      });
      logger.info("whatsapp.sent", {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
      });
      return { sent: true, id: job.id };
    }

    const metaCode = Number(body.error?.code || response.status);
    const code = `meta_${String(metaCode).slice(0, 20)}`;
    const retryable = response.status === 429 || response.status === 408;
    const ambiguous = response.status >= 500;
    const exhausted = job.attempts >= (job.max_attempts || MAX_ATTEMPTS());

    if (retryable && !exhausted) {
      const delay = backoffMs(job.attempts);
      await outcome(db, job, "queued", code, {
        nextAttemptAt: new Date(now.getTime() + delay),
      });
      logger.warn("whatsapp.retry_scheduled", {
        jobId: job.id,
        attempts: job.attempts,
        delayMs: delay,
        code,
      });
      return { retry: true, id: job.id, delay };
    }
    if (retryable) {
      await outcome(db, job, "dead", code);
      logger.error("whatsapp.dead_letter", {
        jobId: job.id,
        attempts: job.attempts,
        code,
      });
      return { dead: true, id: job.id };
    }
    if (ambiguous) {
      await outcome(db, job, "unknown", code);
      logger.error("whatsapp.ambiguous_delivery", {
        jobId: job.id,
        status: response.status,
        code,
      });
      return { failed: true, id: job.id, ambiguous: true };
    }
    await outcome(db, job, "failed", code);
    logger.error("whatsapp.rejected", {
      jobId: job.id,
      status: response.status,
      code,
    });
    return { failed: true, id: job.id };
  } catch (error) {
    // Pode ter chegado à Meta antes do timeout: não reenvia sozinho.
    await outcome(db, job, "unknown", "delivery_unconfirmed");
    logger.error("whatsapp.delivery_unconfirmed", {
      jobId: job.id,
      code: error?.name || "unknown",
    });
    return { unknown: true, id: job.id };
  }
}

export async function heartbeat(db, detail = {}) {
  await db.query(
    `INSERT INTO worker_heartbeats(name,instance,last_seen_at,detail) VALUES($1,$2,now(),$3)
     ON CONFLICT(name) DO UPDATE SET instance=EXCLUDED.instance,last_seen_at=now(),detail=EXCLUDED.detail`,
    [WORKER_NAME, INSTANCE, JSON.stringify(detail)],
  );
}

export async function workerHealth(db) {
  const row = await one(
    db,
    "SELECT last_seen_at,instance,detail FROM worker_heartbeats WHERE name=$1",
    [WORKER_NAME],
  );
  if (!row) return { healthy: false, reason: "sem registro de worker" };
  const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
  const maxAge = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 90_000);
  return {
    healthy: ageMs <= maxAge,
    ageMs,
    instance: row.instance,
    reason:
      ageMs <= maxAge ? null : `último sinal há ${Math.round(ageMs / 1000)}s`,
  };
}

export async function runWorkerTick(db, limit = 10) {
  const recovered = await recoverStale(db);
  const stats = {
    sent: 0,
    failed: 0,
    unknown: 0,
    skipped: 0,
    retried: 0,
    dead: 0,
    recovered,
  };
  for (let i = 0; i < limit; i++) {
    const result = await processOne(db);
    if (!result || result.idle || result.waiting) break;
    if (result.sent) stats.sent++;
    else if (result.retry) stats.retried++;
    else if (result.dead) stats.dead++;
    else if (result.unknown) stats.unknown++;
    else if (result.skip) stats.skipped++;
    else stats.failed++;
  }
  await heartbeat(db, stats);
  if (stats.sent || stats.failed || stats.unknown || stats.dead)
    logger.info("worker.tick", stats);
  return stats;
}

/** Inicia o worker e devolve uma função de parada que aguarda o ciclo em andamento. */
export function startWorker(db) {
  const interval = Number(process.env.WORKER_INTERVAL_MS || 15_000);
  let inFlight = null;
  let stopped = false;

  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = (async () => {
      try {
        await runWorkerTick(db);
      } catch (error) {
        logger.error("worker.tick_failed", {
          code: error?.code || "internal_error",
        });
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const timer = setInterval(tick, interval);
  timer.unref();
  tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight)
      await Promise.race([inFlight, new Promise((r) => setTimeout(r, 10_000))]);
  };
}

export function verifyMetaSignature(rawBody, signature, secret) {
  if (
    !secret ||
    !rawBody ||
    typeof signature !== "string" ||
    !/^sha256=[a-f0-9]{64}$/.test(signature)
  ) {
    return false;
  }
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(signature, expected);
}

export async function handleWebhook(db, body) {
  let updated = 0;
  for (const entry of Array.isArray(body.entry)
    ? body.entry.slice(0, 50)
    : []) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes.slice(0, 50)) {
      if (change?.field !== "messages") continue;
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      if (typeof phoneNumberId !== "string") continue;
      const config = await one(
        db,
        "SELECT tenant_id FROM whatsapp_configs WHERE phone_number_id=$1",
        [phoneNumberId],
      );
      if (!config) continue;
      if (!Array.isArray(change.value?.statuses)) continue;
      for (const status of change.value.statuses.slice(0, 100)) {
        if (
          typeof status?.id !== "string" ||
          !["sent", "delivered", "read", "failed"].includes(status.status)
        ) {
          continue;
        }
        const result = await db.query(
          `UPDATE outbox SET status=CASE WHEN $3='failed' THEN 'failed' ELSE 'sent' END,
             error_code=CASE WHEN $3='failed' THEN 'meta_delivery_failed' ELSE NULL END
           WHERE tenant_id=$1 AND provider_message_id=$2`,
          [config.tenant_id, status.id, status.status],
        );
        updated += result.affectedRows || 0;
      }
    }
  }
  return updated;
}
