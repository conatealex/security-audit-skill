import { randomUUID, randomBytes } from "node:crypto";
import { one, many, transaction, httpError, audit } from "./db.js";
import { digest, hashPassword } from "./security.js";
import {
  localDate,
  zonedToUtc,
  validDay,
  addDays,
  minuteOf,
  weekdayOf,
} from "./time.js";

export const publicAppointment = (a) => ({
  id: a.id,
  startsAt: a.starts_at,
  endsAt: a.ends_at,
  status: a.status,
  professional: a.professional_name,
  service: a.service_name,
  tenant: a.tenant_name,
  timezone: a.timezone,
  clientName: a.client_name,
  phoneMasked: a.phone_e164 ? `•••• ${a.phone_e164.slice(-4)}` : undefined,
  createdAt: a.created_at,
});
const appointmentSelect = `SELECT a.*,p.name professional_name,p.color,s.name service_name,s.duration_minutes,s.buffer_minutes,c.name client_name,c.phone_e164,t.name tenant_name,t.slug,t.timezone FROM appointments a JOIN professionals p ON p.id=a.professional_id AND p.tenant_id=a.tenant_id JOIN services s ON s.id=a.service_id AND s.tenant_id=a.tenant_id JOIN clients c ON c.id=a.client_id AND c.tenant_id=a.tenant_id JOIN tenants t ON t.id=a.tenant_id`;
export async function getTenant(db, slug) {
  const t = await one(db, "SELECT * FROM tenants WHERE slug=$1", [slug]);
  if (!t) throw httpError(404, "Agenda não encontrada.", "NOT_FOUND");
  return t;
}
export async function listPublicProfessionals(db, tenantId) {
  return many(
    db,
    "SELECT id,name,specialty,color FROM professionals WHERE tenant_id=$1 AND active ORDER BY name",
    [tenantId],
  );
}
export async function listPublicServices(db, tenantId) {
  return many(
    db,
    "SELECT id,name,duration_minutes,buffer_minutes,price_cents FROM services WHERE tenant_id=$1 AND active ORDER BY name",
    [tenantId],
  );
}
export async function availableSlots(
  db,
  tenant,
  professionalId,
  day,
  serviceId,
  now = new Date(),
) {
  if (!validDay(day))
    throw httpError(400, "Escolha uma data válida.", "INVALID_DATE");
  const today = localDate(now, tenant.timezone);
  if (day < today || day > addDays(today, 60)) return [];
  const professional = await one(
    db,
    "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2 AND active",
    [professionalId, tenant.id],
  );
  const service = await one(
    db,
    "SELECT * FROM services WHERE id=$1 AND tenant_id=$2 AND active",
    [serviceId, tenant.id],
  );
  if (!professional || !service)
    throw httpError(404, "Profissional ou serviço indisponível.", "NOT_FOUND");
  const hours = await many(
    db,
    "SELECT * FROM working_hours WHERE tenant_id=$1 AND professional_id=$2 AND weekday=$3 ORDER BY start_minute",
    [tenant.id, professionalId, weekdayOf(day)],
  );
  const start = zonedToUtc(day, 0, tenant.timezone),
    end = zonedToUtc(addDays(day, 1), 0, tenant.timezone);
  const busy = await many(
    db,
    `SELECT starts_at,blocked_until FROM appointments WHERE tenant_id=$1 AND professional_id=$2 AND status IN ('pending','confirmed') AND starts_at < $4 AND blocked_until > $3
    UNION ALL SELECT starts_at,ends_at AS blocked_until FROM time_off WHERE tenant_id=$1 AND professional_id=$2 AND starts_at < $4 AND ends_at > $3`,
    [tenant.id, professionalId, start, end],
  );
  const step = service.duration_minutes + service.buffer_minutes;
  const slots = [];
  for (const h of hours) {
    for (
      let m = h.start_minute;
      m + service.duration_minutes <= h.end_minute;
      m += step
    ) {
      const at = zonedToUtc(day, m, tenant.timezone),
        until = new Date(at.getTime() + service.duration_minutes * 60000),
        blocked = new Date(until.getTime() + service.buffer_minutes * 60000);
      if (at.getTime() < now.getTime() + 60 * 60000) continue;
      if (
        busy.some(
          (b) =>
            at < new Date(b.blocked_until) && blocked > new Date(b.starts_at),
        )
      )
        continue;
      slots.push({
        time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
        startsAt: at.toISOString(),
      });
    }
  }
  return slots;
}
export async function book(db, tenant, input, fingerprint, now = new Date()) {
  const professional = await one(
    db,
    "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2 AND active",
    [input.professionalId, tenant.id],
  );
  const service = await one(
    db,
    "SELECT * FROM services WHERE id=$1 AND tenant_id=$2 AND active",
    [input.serviceId, tenant.id],
  );
  if (!professional || !service)
    throw httpError(
      400,
      "Profissional ou serviço indisponível.",
      "INVALID_SELECTION",
    );
  if (!validDay(input.date))
    throw httpError(400, "Data inválida.", "INVALID_DATE");
  const minute =
    Number(input.time.slice(0, 2)) * 60 + Number(input.time.slice(3));
  const at = zonedToUtc(input.date, minute, tenant.timezone);
  const end = new Date(at.getTime() + service.duration_minutes * 60000),
    blocked = new Date(end.getTime() + service.buffer_minutes * 60000);
  const rawToken = randomBytes(32).toString("base64url");
  try {
    return await transaction(db, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${tenant.id}:booking:${input.idempotencyKey}`,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${tenant.id}:${input.professionalId}`,
      ]);
      await tx.query(
        "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2 AND active FOR UPDATE",
        [input.professionalId, tenant.id],
      );
      const previous = await one(
        tx,
        "SELECT * FROM appointments WHERE tenant_id=$1 AND idempotency_key=$2",
        [tenant.id, input.idempotencyKey],
      );
      if (previous) {
        if (previous.request_fingerprint !== fingerprint)
          throw httpError(
            409,
            "Esta chave já foi usada para outro pedido.",
            "IDEMPOTENCY_CONFLICT",
          );
        const a = await one(
          tx,
          appointmentSelect + " WHERE a.id=$1 AND a.tenant_id=$2",
          [previous.id, tenant.id],
        );
        return { appointment: publicAppointment(a), repeated: true };
      }
      const day = localDate(now, tenant.timezone);
      if (
        input.date > addDays(day, 60) ||
        at.getTime() < now.getTime() + 3600000
      )
        throw httpError(
          400,
          "Escolha um horário com pelo menos 1 hora de antecedência, dentro dos próximos 60 dias.",
          "OUTSIDE_WINDOW",
        );
      const hours = await many(
        tx,
        "SELECT * FROM working_hours WHERE tenant_id=$1 AND professional_id=$2 AND weekday=$3",
        [tenant.id, input.professionalId, weekdayOf(input.date)],
      );
      if (
        !hours.some(
          (h) =>
            minute >= h.start_minute &&
            minute + service.duration_minutes <= h.end_minute &&
            (minute - h.start_minute) %
              (service.duration_minutes + service.buffer_minutes) ===
              0,
        )
      )
        throw httpError(
          409,
          "Este horário não está na grade disponível.",
          "OUTSIDE_HOURS",
        );
      const conflict = await one(
        tx,
        `SELECT id FROM appointments WHERE tenant_id=$1 AND professional_id=$2 AND status IN ('pending','confirmed') AND tstzrange(starts_at,blocked_until,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)') LIMIT 1`,
        [tenant.id, input.professionalId, at, blocked],
      );
      const off = await one(
        tx,
        "SELECT id FROM time_off WHERE tenant_id=$1 AND professional_id=$2 AND starts_at<$4 AND ends_at>$3",
        [tenant.id, input.professionalId, at, blocked],
      );
      if (conflict || off)
        throw httpError(
          409,
          "Este horário acabou de ser reservado. Escolha outro.",
          "SLOT_UNAVAILABLE",
        );
      await tx.query(
        "INSERT INTO clients(id,tenant_id,name,phone_e164) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,phone_e164) DO UPDATE SET name=EXCLUDED.name",
        [randomUUID(), tenant.id, input.name, input.phone],
      );
      const client = await one(
        tx,
        "SELECT id FROM clients WHERE tenant_id=$1 AND phone_e164=$2",
        [tenant.id, input.phone],
      );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO appointments(id,tenant_id,professional_id,service_id,client_id,starts_at,ends_at,blocked_until,notes,client_token_hash,consent_at,whatsapp_opt_in,idempotency_key,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          tenant.id,
          input.professionalId,
          input.serviceId,
          client.id,
          at,
          end,
          blocked,
          input.notes || "",
          digest(rawToken),
          now,
          input.whatsappOptIn,
          input.idempotencyKey,
          fingerprint,
        ],
      );
      await audit(
        tx,
        tenant.id,
        { type: "client" },
        "appointment.requested",
        id,
        { whatsappOptIn: input.whatsappOptIn },
      );
      const a = await one(
        tx,
        appointmentSelect + " WHERE a.id=$1 AND a.tenant_id=$2",
        [id, tenant.id],
      );
      return {
        appointment: publicAppointment(a),
        accessToken: rawToken,
        repeated: false,
      };
    });
  } catch (e) {
    if (e.code === "23P01" || e.code === "23505")
      throw httpError(
        409,
        "Este horário acabou de ser reservado. Escolha outro.",
        "SLOT_UNAVAILABLE",
      );
    throw e;
  }
}
export async function listAppointments(db, auth, query = {}) {
  const values = [auth.tenant_id];
  let where = "a.tenant_id=$1";
  if (auth.role === "professional") {
    values.push(auth.professional_id);
    where += ` AND a.professional_id=$${values.length}`;
  }
  if (query.status && query.status !== "all") {
    values.push(query.status);
    where += ` AND a.status=$${values.length}`;
  }
  if (query.date && validDay(query.date)) {
    const tenant = await one(db, "SELECT timezone FROM tenants WHERE id=$1", [
      auth.tenant_id,
    ]);
    values.push(
      zonedToUtc(query.date, 0, tenant.timezone),
      zonedToUtc(addDays(query.date, 1), 0, tenant.timezone),
    );
    where += ` AND a.starts_at>=$${values.length - 1} AND a.starts_at<$${values.length}`;
  }
  if (query.from && validDay(query.from)) {
    const tenant = await one(db, "SELECT timezone FROM tenants WHERE id=$1", [
      auth.tenant_id,
    ]);
    values.push(zonedToUtc(query.from, 0, tenant.timezone));
    where += ` AND a.starts_at>=$${values.length}`;
  }
  const rows = await many(
    db,
    appointmentSelect + ` WHERE ${where} ORDER BY a.starts_at DESC LIMIT 500`,
    values,
  );
  return rows.map((a) => ({
    ...publicAppointment(a),
    notes: a.notes,
    phone: a.phone_e164,
    professionalId: a.professional_id,
    serviceId: a.service_id,
    whatsappOptIn: a.whatsapp_opt_in,
    decisionReason: a.decision_reason,
  }));
}
export async function findAppointment(db, auth, id) {
  const a = await one(
    db,
    appointmentSelect +
      " WHERE a.id=$1 AND a.tenant_id=$2" +
      (auth.role === "professional" ? " AND a.professional_id=$3" : ""),
    auth.role === "professional"
      ? [id, auth.tenant_id, auth.professional_id]
      : [id, auth.tenant_id],
  );
  if (!a) throw httpError(404, "Agendamento não encontrado.", "NOT_FOUND");
  return a;
}
export async function decide(
  db,
  auth,
  id,
  action,
  reason = "",
  now = new Date(),
) {
  return transaction(db, async (tx) => {
    const a = await one(
      tx,
      "SELECT * FROM appointments WHERE id=$1 AND tenant_id=$2" +
        (auth.role === "professional" ? " AND professional_id=$3" : "") +
        " FOR UPDATE",
      auth.role === "professional"
        ? [id, auth.tenant_id, auth.professional_id]
        : [id, auth.tenant_id],
    );
    if (!a) throw httpError(404, "Agendamento não encontrado.", "NOT_FOUND");
    const next = {
      confirm: "confirmed",
      cancel: "cancelled",
      complete: "completed",
    }[action];
    const allowed = {
      pending: ["confirm", "cancel"],
      confirmed: ["cancel", "complete"],
      cancelled: [],
      completed: [],
    };
    if (!allowed[a.status].includes(action))
      throw httpError(
        409,
        "Esta ação não está disponível para o estado atual.",
        "INVALID_TRANSITION",
      );
    if (action === "complete" && new Date(a.starts_at) > now)
      throw httpError(
        409,
        "Só é possível concluir após o início do atendimento.",
        "TOO_EARLY",
      );
    await tx.query(
      "UPDATE appointments SET status=$3,decision_reason=$4,decided_by=$5,updated_at=$6 WHERE id=$1 AND tenant_id=$2",
      [id, auth.tenant_id, next, reason || null, auth.userId, now],
    );
    if (action === "confirm") {
      // A confirmação sai agora; lembretes só entram na fila se o momento ainda não passou.
      if (a.whatsapp_opt_in) {
        await tx.query(
          `INSERT INTO outbox(id,tenant_id,appointment_id,kind,scheduled_at,next_attempt_at) VALUES($1,$2,$3,'confirmation',$4,$4) ON CONFLICT(appointment_id,kind) DO NOTHING`,
          [randomUUID(), auth.tenant_id, id, now],
        );
        for (const [kind, offset] of [
          ["reminder_24h", 86400000],
          ["reminder_2h", 7200000],
        ]) {
          const target = new Date(new Date(a.starts_at).getTime() - offset);
          if (target.getTime() <= now.getTime()) continue;
          await tx.query(
            `INSERT INTO outbox(id,tenant_id,appointment_id,kind,scheduled_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(appointment_id,kind) DO NOTHING`,
            [randomUUID(), auth.tenant_id, id, kind, target],
          );
        }
      }
    } else if (action === "cancel") {
      await tx.query(
        `UPDATE outbox SET status='cancelled' WHERE appointment_id=$1 AND tenant_id=$2 AND status IN ('queued','failed')`,
        [id, auth.tenant_id],
      );
      if (a.whatsapp_opt_in)
        await tx.query(
          `INSERT INTO outbox(id,tenant_id,appointment_id,kind,scheduled_at) VALUES($1,$2,$3,'cancellation',$4) ON CONFLICT(appointment_id,kind) DO NOTHING`,
          [randomUUID(), auth.tenant_id, id, now],
        );
    } else {
      await tx.query(
        `UPDATE outbox SET status='cancelled' WHERE appointment_id=$1 AND tenant_id=$2 AND status IN ('queued','failed')`,
        [id, auth.tenant_id],
      );
    }
    await audit(tx, auth.tenant_id, auth, `appointment.${action}`, id, {
      from: a.status,
      to: next,
    });
    return { id, status: next };
  });
}
export async function clientLookup(db, rawToken) {
  const a = await one(db, appointmentSelect + " WHERE a.client_token_hash=$1", [
    digest(rawToken),
  ]);
  if (!a) throw httpError(404, "Link inválido ou expirado.", "NOT_FOUND");
  return publicAppointment(a);
}
export async function createWorkspace(db, input, now = new Date()) {
  const passwordHash = await hashPassword(input.password);
  return transaction(db, async (tx) => {
    const existing = await one(tx, "SELECT id FROM users WHERE email=$1", [
      input.email,
    ]);
    if (existing)
      throw httpError(
        409,
        "Não foi possível criar a conta com estes dados.",
        "REGISTRATION_FAILED",
      );
    const tenantId = randomUUID(),
      userId = randomUUID(),
      professionalId = randomUUID();
    let slug =
      input.workspace
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "clinica";
    if (await one(tx, "SELECT id FROM tenants WHERE slug=$1", [slug]))
      slug += "-" + randomBytes(3).toString("hex");
    await tx.query("INSERT INTO tenants(id,name,slug) VALUES($1,$2,$3)", [
      tenantId,
      input.workspace,
      slug,
    ]);
    await tx.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [userId, input.email, input.name, passwordHash],
    );
    await tx.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
      [tenantId, userId, "owner"],
    );
    await tx.query(
      "INSERT INTO professionals(id,tenant_id,user_id,name,specialty) VALUES($1,$2,$3,$4,$5)",
      [professionalId, tenantId, userId, input.name, "Atendimento"],
    );
    const serviceId = randomUUID();
    await tx.query(
      "INSERT INTO services(id,tenant_id,name,duration_minutes,buffer_minutes) VALUES($1,$2,$3,50,10)",
      [serviceId, tenantId, "Consulta"],
    );
    for (let day = 1; day <= 5; day++)
      for (const [start, end] of [
        [540, 720],
        [840, 1080],
      ])
        await tx.query(
          "INSERT INTO working_hours(id,tenant_id,professional_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6)",
          [randomUUID(), tenantId, professionalId, day, start, end],
        );
    await tx.query("INSERT INTO whatsapp_configs(tenant_id) VALUES($1)", [
      tenantId,
    ]);
    await audit(
      tx,
      tenantId,
      { userId, type: "user" },
      "workspace.created",
      tenantId,
    );
    return { tenantId, userId, professionalId, serviceId, slug };
  });
}
