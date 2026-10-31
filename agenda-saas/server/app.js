import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { randomUUID, randomBytes } from "node:crypto";
import { one, many, transaction, httpError, audit, isTransient } from "./db.js";
import { accessLog, logger } from "./logger.js";
import { APP_VERSION } from "./version.js";
import { migrationStatus } from "./migrate.js";
import {
  token,
  digest,
  hashPassword,
  verifyPassword,
  authenticate,
  ownerOnly,
  sameOrigin,
  dbRateLimit,
  encryptSecret,
  safeEqual,
} from "./security.js";
import {
  getTenant,
  listPublicProfessionals,
  listPublicServices,
  availableSlots,
  book,
  listAppointments,
  findAppointment,
  decide,
  clientLookup,
  createWorkspace,
} from "./domain.js";
import { localDate, addDays, validDay, zonedToUtc } from "./time.js";
import {
  liveMessagingEnabled,
  verifyMetaSignature,
  handleWebhook,
  workerHealth,
} from "./whatsapp.js";

const uuid = z.string().uuid();
const day = z.string().refine(validDay, "Data inválida.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido.");
const password = z
  .string()
  .min(12, "A senha precisa de pelo menos 12 caracteres.")
  .max(128);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((x) => x.toLowerCase());
const name = z.string().trim().min(2).max(100);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,59}$/);
const template = z.string().regex(/^[a-z0-9_]{1,512}$/);
function normalizePhone(value) {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12 && digits.length <= 13)
    digits = digits.slice(2);
  if (!/^[1-9]{2}9?\d{8}$/.test(digits))
    throw httpError(
      400,
      "Informe um WhatsApp brasileiro válido com DDD.",
      "INVALID_PHONE",
    );
  return "+55" + digits;
}
const bookingSchema = z
  .object({
    professionalId: uuid,
    serviceId: uuid,
    date: day,
    time,
    name,
    phone: z.string().min(10).max(25).transform(normalizePhone),
    notes: z.string().trim().max(300).default(""),
    consent: z.literal(true, {
      error: "Autorize o uso dos dados para agendar.",
    }),
    whatsappOptIn: z.boolean(),
    idempotencyKey: uuid,
  })
  .strict();
const decisionSchema = z
  .object({
    action: z.enum(["confirm", "cancel", "complete"]),
    reason: z.string().trim().max(300).default(""),
  })
  .strict();
const loginSchema = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();
const registerSchema = z
  .object({ workspace: name, name, email, password, privacy: z.literal(true) })
  .strict();
const hoursSchema = z
  .array(
    z
      .object({
        weekday: z.number().int().min(0).max(6),
        start: time,
        end: time,
      })
      .strict(),
  )
  .max(42)
  .refine(
    (rows) => rows.every((r) => r.end > r.start),
    "O fim deve ser depois do início.",
  )
  .refine((rows) => {
    const sorted = [...rows].sort(
      (a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start),
    );
    return sorted.every(
      (r, i) =>
        !i ||
        r.weekday !== sorted[i - 1].weekday ||
        r.start >= sorted[i - 1].end,
    );
  }, "As faixas de horário não podem se sobrepor.");

export function createApp(db, { dev = false } = {}) {
  const app = express();
  const requireAuth = (req, res, next) => authenticate(db, req, res, next);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    const requestId =
      incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    req.id = requestId;
    res.set("X-Request-Id", requestId);
    const startedAt = Date.now();
    res.on("finish", () => accessLog(req, res, startedAt, requestId));
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: dev
        ? false
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:"],
              fontSrc: ["'self'"],
              connectSrc: ["'self'"],
              frameAncestors: ["'none'"],
              objectSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
            },
          },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/api/config", (req, res) =>
    res.json({
      demo:
        process.env.DEMO_MODE === "true" &&
        process.env.NODE_ENV !== "production",
      registration: process.env.ALLOW_REGISTRATION !== "false",
    }),
  );
  // Liveness: responde enquanto o processo estiver vivo (não toca no banco).
  app.get("/api/health", (req, res) =>
    res.json({
      ok: true,
      mode: process.env.DATABASE_URL ? "postgres" : "pglite",
      whatsapp: liveMessagingEnabled() ? "live" : "disabled",
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );
  // Readiness: só recebe tráfego quando banco, migrações, chave e worker estão prontos.
  app.get("/api/ready", async (req, res) => {
    const checks = {
      database: false,
      migrations: false,
      encryptionKey: false,
      worker: true,
    };
    let detail = {};
    try {
      await db.ping();
      checks.database = true;
      const status = await migrationStatus(db);
      checks.migrations =
        status.pending.length === 0 && status.changed.length === 0;
      detail = {
        pendingMigrations: status.pending.length,
        changedMigrations: status.changed.length,
      };
    } catch (error) {
      detail.error = isTransient(error)
        ? "database_unavailable"
        : "database_check_failed";
    }
    checks.encryptionKey =
      process.env.NODE_ENV !== "production" ||
      Boolean(process.env.DATA_ENCRYPTION_KEY);
    if (liveMessagingEnabled() && checks.database) {
      try {
        const worker = await workerHealth(db);
        checks.worker = worker.healthy;
        if (!worker.healthy) detail.worker = worker.reason;
      } catch {
        checks.worker = false;
      }
    }
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? 200 : 503).json({
      ok,
      checks,
      detail,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
  app.get("/api/webhooks/meta", (req, res) => {
    const challenge = req.query["hub.challenge"];
    const verifyToken = req.query["hub.verify_token"];
    if (
      req.query["hub.mode"] === "subscribe" &&
      typeof challenge === "string" &&
      challenge.length < 500 &&
      process.env.META_WEBHOOK_VERIFY_TOKEN &&
      typeof verifyToken === "string" &&
      safeEqual(verifyToken, process.env.META_WEBHOOK_VERIFY_TOKEN)
    )
      return res.type("text/plain").send(challenge);
    res.sendStatus(403);
  });
  app.post(
    "/api/webhooks/meta",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res, next) => {
      try {
        if (
          !verifyMetaSignature(
            req.body,
            req.get("x-hub-signature-256"),
            process.env.META_APP_SECRET,
          )
        )
          throw httpError(401, "Assinatura inválida.", "INVALID_SIGNATURE");
        let body;
        try {
          body = JSON.parse(req.body.toString("utf8"));
        } catch {
          throw httpError(400, "JSON inválido.");
        }
        await handleWebhook(db, body);
        res.sendStatus(200);
      } catch (e) {
        next(e);
      }
    },
  );
  app.use(express.json({ limit: "32kb" }));
  app.use("/api", sameOrigin);
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: {
          message: "Muitas requisições. Tente novamente em instantes.",
          code: "RATE_LIMITED",
        },
      },
    }),
  );
  const authLimiter = dbRateLimit(db, "auth", 20, 15 * 60000);
  const bookLimiter = dbRateLimit(db, "booking", 12, 15 * 60000);
  const lookupLimiter = dbRateLimit(db, "lookup", 20, 15 * 60000);
  const cookieName =
    process.env.NODE_ENV === "production"
      ? "__Host-aurora_session"
      : "aurora_session";
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
  async function establishSession(res, userId) {
    const raw = token(),
      csrf = token(),
      expires = new Date(Date.now() + 8 * 3600000);
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)",
      [digest(raw), userId, csrf, expires],
    );
    res.cookie(cookieName, raw, { ...cookieOptions, maxAge: 8 * 3600000 });
  }
  app.post("/api/auth/register", authLimiter, async (req, res, next) => {
    try {
      if (process.env.ALLOW_REGISTRATION === "false")
        throw httpError(403, "Cadastro desativado neste ambiente.");
      const input = registerSchema.parse(req.body);
      const workspace = await createWorkspace(db, input);
      await establishSession(res, workspace.userId);
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/auth/login", authLimiter, async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body);
      const user = await one(db, "SELECT * FROM users WHERE email=$1", [
        input.email,
      ]);
      const valid = user
        ? await verifyPassword(input.password, user.password_hash)
        : (await hashPassword(input.password), false);
      if (!user || !valid)
        throw httpError(
          401,
          "E-mail ou senha incorretos.",
          "INVALID_CREDENTIALS",
        );
      await establishSession(res, user.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/auth/demo", authLimiter, async (req, res, next) => {
    try {
      if (
        process.env.DEMO_MODE !== "true" ||
        process.env.NODE_ENV === "production"
      )
        throw httpError(404, "Não encontrado.", "NOT_FOUND");
      const persona = z
        .enum(["owner", "professional", "other"])
        .parse(req.body.persona || "owner");
      const email = {
        owner: "admin@aurora.demo",
        professional: "marina@aurora.demo",
        other: "admin@outra-clinica.demo",
      }[persona];
      const user = await one(db, "SELECT id FROM users WHERE email=$1", [
        email,
      ]);
      if (!user) throw httpError(409, "Execute npm run seed primeiro.");
      await establishSession(res, user.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/auth/logout", requireAuth, async (req, res, next) => {
    try {
      await db.query(
        "DELETE FROM sessions WHERE user_id=$1 AND csrf_token=$2",
        [req.auth.userId, req.auth.csrf],
      );
      res.clearCookie(cookieName, cookieOptions);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/me", requireAuth, (req, res) =>
    res.json({
      user: { id: req.auth.userId, name: req.auth.name, email: req.auth.email },
      tenant: {
        id: req.auth.tenant_id,
        name: req.auth.tenant_name,
        slug: req.auth.slug,
        timezone: req.auth.timezone,
      },
      role: req.auth.role,
      professionalId: req.auth.professional_id,
      csrf: req.auth.csrf,
      demo: process.env.DEMO_MODE === "true",
      whatsappMode: liveMessagingEnabled() ? "live" : "disabled",
    }),
  );

  app.get("/api/public/:slug", async (req, res, next) => {
    try {
      const t = await getTenant(db, slugSchema.parse(req.params.slug));
      res.json({
        tenant: { name: t.name, slug: t.slug, timezone: t.timezone },
        professionals: await listPublicProfessionals(db, t.id),
        services: await listPublicServices(db, t.id),
      });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/public/:slug/slots", async (req, res, next) => {
    try {
      const t = await getTenant(db, slugSchema.parse(req.params.slug));
      const q = z
        .object({ professional: uuid, service: uuid, date: day })
        .parse(req.query);
      res.json({
        slots: await availableSlots(db, t, q.professional, q.date, q.service),
      });
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/public/:slug/appointments",
    bookLimiter,
    async (req, res, next) => {
      try {
        const t = await getTenant(db, slugSchema.parse(req.params.slug));
        const input = bookingSchema.parse(req.body);
        const fingerprint = digest(
          JSON.stringify([
            t.id,
            input.professionalId,
            input.serviceId,
            input.date,
            input.time,
            input.name,
            input.phone,
            input.notes,
            input.whatsappOptIn,
          ]),
        );
        const result = await book(db, t, input, fingerprint);
        res.status(result.repeated ? 200 : 201).json(result);
      } catch (e) {
        next(e);
      }
    },
  );
  app.post("/api/public/lookup", lookupLimiter, async (req, res, next) => {
    try {
      const { accessToken } = z
        .object({ accessToken: z.string().min(32).max(100) })
        .strict()
        .parse(req.body);
      res.json({ appointment: await clientLookup(db, accessToken) });
    } catch (e) {
      next(e);
    }
  });

  const inviteLimiter = dbRateLimit(db, "invite", 15, 15 * 60000);
  app.post(
    "/api/invitations/inspect",
    inviteLimiter,
    async (req, res, next) => {
      try {
        const { accessToken } = z
          .object({ accessToken: z.string().min(32).max(100) })
          .strict()
          .parse(req.body);
        const invite = await one(
          db,
          `SELECT i.expires_at,i.used_at,p.name,p.specialty,t.name tenant_name FROM invitations i JOIN professionals p ON p.id=i.professional_id JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=$1`,
          [digest(accessToken)],
        );
        if (
          !invite ||
          invite.used_at ||
          new Date(invite.expires_at) <= new Date()
        )
          throw httpError(
            404,
            "Convite inválido ou expirado. Peça um novo ao administrador.",
            "INVALID_INVITE",
          );
        res.json({
          invite: {
            name: invite.name,
            specialty: invite.specialty,
            tenant: invite.tenant_name,
          },
        });
      } catch (e) {
        next(e);
      }
    },
  );
  app.post("/api/invitations/accept", inviteLimiter, async (req, res, next) => {
    try {
      const input = z
        .object({
          accessToken: z.string().min(32).max(100),
          email,
          password,
          privacy: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const userId = randomUUID();
      await transaction(db, async (tx) => {
        const invite = await one(
          tx,
          "SELECT * FROM invitations WHERE token_hash=$1 FOR UPDATE",
          [digest(input.accessToken)],
        );
        if (
          !invite ||
          invite.used_at ||
          new Date(invite.expires_at) <= new Date()
        )
          throw httpError(
            404,
            "Convite inválido ou expirado.",
            "INVALID_INVITE",
          );
        const pro = await one(
          tx,
          "SELECT * FROM professionals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [invite.professional_id, invite.tenant_id],
        );
        if (!pro || pro.user_id)
          throw httpError(
            409,
            "Este profissional já possui acesso.",
            "INVITE_USED",
          );
        if (await one(tx, "SELECT id FROM users WHERE email=$1", [input.email]))
          throw httpError(
            409,
            "Não foi possível criar a conta com estes dados.",
            "REGISTRATION_FAILED",
          );
        await tx.query(
          "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
          [userId, input.email, pro.name, passwordHash],
        );
        await tx.query(
          "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
          [invite.tenant_id, userId, "professional"],
        );
        await tx.query(
          "UPDATE professionals SET user_id=$3 WHERE id=$1 AND tenant_id=$2",
          [pro.id, invite.tenant_id, userId],
        );
        await tx.query(
          "UPDATE invitations SET used_at=now() WHERE token_hash=$1",
          [digest(input.accessToken)],
        );
        await audit(
          tx,
          invite.tenant_id,
          { userId, type: "user" },
          "professional.invitation_accepted",
          pro.id,
        );
      });
      await establishSession(res, userId);
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.use("/api", requireAuth);
  app.get("/api/appointments", async (req, res, next) => {
    try {
      const q = z
        .object({
          status: z
            .enum(["all", "pending", "confirmed", "cancelled", "completed"])
            .optional(),
          date: day.optional(),
          from: day.optional(),
        })
        .parse(req.query);
      res.json({ appointments: await listAppointments(db, req.auth, q) });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/appointments/:id", async (req, res, next) => {
    try {
      const a = await findAppointment(db, req.auth, uuid.parse(req.params.id));
      res.json({
        appointment: {
          ...a,
          client_token_hash: undefined,
          request_fingerprint: undefined,
          idempotency_key: undefined,
        },
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/appointments/:id/decision", async (req, res, next) => {
    try {
      res.json(
        await decide(
          db,
          req.auth,
          uuid.parse(req.params.id),
          ...((i) => [i.action, i.reason])(decisionSchema.parse(req.body)),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/overview", async (req, res, next) => {
    try {
      const appointments = await listAppointments(db, req.auth);
      const today = localDate(new Date(), req.auth.timezone);
      const todays = appointments.filter(
        (a) =>
          localDate(a.startsAt, req.auth.timezone) === today &&
          !["cancelled"].includes(a.status),
      );
      res.json({
        today: {
          total: todays.length,
          pending: appointments.filter((a) => a.status === "pending").length,
          confirmed: todays.filter((a) => a.status === "confirmed").length,
          completed: todays.filter((a) => a.status === "completed").length,
        },
        upcoming: appointments
          .filter(
            (a) =>
              a.status === "confirmed" && new Date(a.startsAt) > new Date(),
          )
          .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
          .slice(0, 5),
        recent: appointments.slice(0, 6),
      });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/professionals", async (req, res, next) => {
    try {
      res.json({
        professionals: await many(
          db,
          "SELECT id,name,specialty,color,active,user_id FROM professionals WHERE tenant_id=$1 ORDER BY name",
          [req.auth.tenant_id],
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/professionals", ownerOnly, async (req, res, next) => {
    try {
      const input = z
        .object({
          name,
          specialty: z.string().trim().min(2).max(100),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        })
        .strict()
        .parse(req.body);
      const id = randomUUID();
      await transaction(db, async (tx) => {
        await tx.query(
          "INSERT INTO professionals(id,tenant_id,name,specialty,color) VALUES($1,$2,$3,$4,$5)",
          [id, req.auth.tenant_id, input.name, input.specialty, input.color],
        );
        for (let d = 1; d <= 5; d++)
          for (const [s, e] of [
            [540, 720],
            [840, 1080],
          ])
            await tx.query(
              "INSERT INTO working_hours(id,tenant_id,professional_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6)",
              [randomUUID(), req.auth.tenant_id, id, d, s, e],
            );
        await audit(
          tx,
          req.auth.tenant_id,
          req.auth,
          "professional.created",
          id,
        );
      });
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });
  app.patch("/api/professionals/:id", ownerOnly, async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const input = z.object({ active: z.boolean() }).strict().parse(req.body);
      await transaction(db, async (tx) => {
        const result = await tx.query(
          "UPDATE professionals SET active=$3 WHERE id=$1 AND tenant_id=$2",
          [id, req.auth.tenant_id, input.active],
        );
        if (!result.affectedRows)
          throw httpError(404, "Profissional não encontrado.");
        await audit(
          tx,
          req.auth.tenant_id,
          req.auth,
          "professional.updated",
          id,
          { active: input.active },
        );
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/professionals/:id/hours", ownerOnly, async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      if (
        !(await one(
          db,
          "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2",
          [id, req.auth.tenant_id],
        ))
      )
        throw httpError(404, "Profissional não encontrado.");
      const rows = await many(
        db,
        "SELECT weekday,start_minute,end_minute FROM working_hours WHERE professional_id=$1 AND tenant_id=$2 ORDER BY weekday,start_minute",
        [id, req.auth.tenant_id],
      );
      res.json({
        hours: rows.map((r) => ({
          weekday: r.weekday,
          start: `${String(Math.floor(r.start_minute / 60)).padStart(2, "0")}:${String(r.start_minute % 60).padStart(2, "0")}`,
          end: `${String(Math.floor(r.end_minute / 60)).padStart(2, "0")}:${String(r.end_minute % 60).padStart(2, "0")}`,
        })),
      });
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/professionals/:id/hours", ownerOnly, async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      const input = hoursSchema.parse(req.body);
      await transaction(db, async (tx) => {
        if (
          !(await one(
            tx,
            "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
            [id, req.auth.tenant_id],
          ))
        )
          throw httpError(404, "Profissional não encontrado.");
        await tx.query(
          "DELETE FROM working_hours WHERE professional_id=$1 AND tenant_id=$2",
          [id, req.auth.tenant_id],
        );
        for (const h of input)
          await tx.query(
            "INSERT INTO working_hours(id,tenant_id,professional_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6)",
            [
              randomUUID(),
              req.auth.tenant_id,
              id,
              h.weekday,
              Number(h.start.slice(0, 2)) * 60 + Number(h.start.slice(3)),
              Number(h.end.slice(0, 2)) * 60 + Number(h.end.slice(3)),
            ],
          );
        await audit(
          tx,
          req.auth.tenant_id,
          req.auth,
          "availability.updated",
          id,
        );
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/time-off", ownerOnly, async (req, res, next) => {
    try {
      const input = z
        .object({
          professionalId: uuid,
          date: day,
          reason: z.string().trim().min(2).max(100),
        })
        .strict()
        .parse(req.body);
      if (
        !(await one(
          db,
          "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2",
          [input.professionalId, req.auth.tenant_id],
        ))
      )
        throw httpError(404, "Profissional não encontrado.");
      const start = zonedToUtc(input.date, 0, req.auth.timezone),
        end = zonedToUtc(addDays(input.date, 1), 0, req.auth.timezone);
      const id = randomUUID();
      await transaction(db, async (tx) => {
        const professional = await one(
          tx,
          "SELECT id FROM professionals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
          [input.professionalId, req.auth.tenant_id],
        );
        if (!professional) throw httpError(404, "Profissional não encontrado.");
        const active = await one(
          tx,
          `SELECT id FROM appointments WHERE tenant_id=$1 AND professional_id=$2 AND status IN ('pending','confirmed') AND starts_at<$4 AND blocked_until>$3`,
          [req.auth.tenant_id, input.professionalId, start, end],
        );
        if (active)
          throw httpError(
            409,
            "Há pedidos neste dia. Cancele ou remarque antes de bloquear a data.",
          );
        await tx.query(
          "INSERT INTO time_off(id,tenant_id,professional_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            req.auth.tenant_id,
            input.professionalId,
            start,
            end,
            input.reason,
          ],
        );
        await audit(tx, req.auth.tenant_id, req.auth, "time_off.created", id);
      });
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });
  app.post(
    "/api/professionals/:id/invitation",
    ownerOnly,
    async (req, res, next) => {
      try {
        const id = uuid.parse(req.params.id);
        const raw = token();
        await transaction(db, async (tx) => {
          const pro = await one(
            tx,
            "SELECT * FROM professionals WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
            [id, req.auth.tenant_id],
          );
          if (!pro) throw httpError(404, "Profissional não encontrado.");
          if (pro.user_id)
            throw httpError(409, "Este profissional já possui acesso.");
          await tx.query(
            "INSERT INTO invitations(token_hash,tenant_id,professional_id,expires_at,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(professional_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,used_at=NULL,created_by=EXCLUDED.created_by,created_at=now()",
            [
              digest(raw),
              req.auth.tenant_id,
              id,
              new Date(Date.now() + 48 * 3600000),
              req.auth.userId,
            ],
          );
          await audit(
            tx,
            req.auth.tenant_id,
            req.auth,
            "professional.invitation_created",
            id,
          );
        });
        res.status(201).json({ accessToken: raw, expiresInHours: 48 });
      } catch (e) {
        next(e);
      }
    },
  );
  app.post(
    "/api/appointments/:id/messaging-consent",
    async (req, res, next) => {
      try {
        const id = uuid.parse(req.params.id);
        z.object({ optIn: z.literal(false) })
          .strict()
          .parse(req.body);
        await transaction(db, async (tx) => {
          const a = await findAppointment(tx, req.auth, id);
          await tx.query(
            "UPDATE appointments SET whatsapp_opt_in=false,updated_at=now() WHERE id=$1 AND tenant_id=$2",
            [id, req.auth.tenant_id],
          );
          await tx.query(
            `UPDATE outbox SET status='cancelled' WHERE appointment_id=$1 AND tenant_id=$2 AND status IN ('queued','failed')`,
            [id, req.auth.tenant_id],
          );
          await audit(
            tx,
            req.auth.tenant_id,
            req.auth,
            "appointment.messaging_revoked",
            id,
            { previous: a.whatsapp_opt_in },
          );
        });
        res.json({ ok: true });
      } catch (e) {
        next(e);
      }
    },
  );
  app.get("/api/services", async (req, res, next) => {
    try {
      res.json({
        services: await many(
          db,
          "SELECT id,name,duration_minutes,buffer_minutes,price_cents,active FROM services WHERE tenant_id=$1 ORDER BY name",
          [req.auth.tenant_id],
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/services", ownerOnly, async (req, res, next) => {
    try {
      const input = z
        .object({
          name: z.string().trim().min(2).max(100),
          duration: z.number().int().min(15).max(240),
          buffer: z.number().int().min(0).max(120),
          price: z.number().min(0).max(100000),
        })
        .strict()
        .parse(req.body);
      const id = randomUUID();
      await transaction(db, async (tx) => {
        await tx.query(
          "INSERT INTO services(id,tenant_id,name,duration_minutes,buffer_minutes,price_cents) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            req.auth.tenant_id,
            input.name,
            input.duration,
            input.buffer,
            Math.round(input.price * 100),
          ],
        );
        await audit(tx, req.auth.tenant_id, req.auth, "service.created", id);
      });
      res.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/whatsapp", ownerOnly, async (req, res, next) => {
    try {
      const c = await one(
        db,
        "SELECT phone_number_id,confirmation_template,reminder_template,cancellation_template,template_language,enabled,(access_token_cipher<>'') configured FROM whatsapp_configs WHERE tenant_id=$1",
        [req.auth.tenant_id],
      );
      res.json({
        config: c || {},
        mode: liveMessagingEnabled() ? "live" : "disabled",
        templates: {
          variables: [
            "nome do cliente",
            "nome do profissional",
            "data",
            "horário",
            "nome da clínica",
          ],
        },
      });
    } catch (e) {
      next(e);
    }
  });
  app.put("/api/whatsapp", ownerOnly, async (req, res, next) => {
    try {
      const input = z
        .object({
          phoneNumberId: z
            .string()
            .regex(/^\d{5,30}$/)
            .or(z.literal("")),
          accessToken: z.string().min(20).max(8192).optional(),
          confirmationTemplate: template,
          reminderTemplate: template,
          cancellationTemplate: template,
          language: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/),
          enabled: z.boolean(),
        })
        .strict()
        .parse(req.body);
      await transaction(db, async (tx) => {
        const previous = await one(
          tx,
          "SELECT * FROM whatsapp_configs WHERE tenant_id=$1",
          [req.auth.tenant_id],
        );
        const cipher = input.accessToken
          ? await encryptSecret(input.accessToken)
          : previous?.access_token_cipher || "";
        if (input.enabled && (!input.phoneNumberId || !cipher))
          throw httpError(400, "Informe o número e o token antes de ativar.");
        await tx.query(
          `INSERT INTO whatsapp_configs(tenant_id,phone_number_id,access_token_cipher,confirmation_template,reminder_template,cancellation_template,template_language,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id) DO UPDATE SET phone_number_id=EXCLUDED.phone_number_id,access_token_cipher=EXCLUDED.access_token_cipher,confirmation_template=EXCLUDED.confirmation_template,reminder_template=EXCLUDED.reminder_template,cancellation_template=EXCLUDED.cancellation_template,template_language=EXCLUDED.template_language,enabled=EXCLUDED.enabled,updated_at=now()`,
          [
            req.auth.tenant_id,
            input.phoneNumberId,
            cipher,
            input.confirmationTemplate,
            input.reminderTemplate,
            input.cancellationTemplate,
            input.language,
            input.enabled,
          ],
        );
        await audit(
          tx,
          req.auth.tenant_id,
          req.auth,
          "whatsapp.configured",
          req.auth.tenant_id,
          { enabled: input.enabled },
        );
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/outbox", async (req, res, next) => {
    try {
      const params = [req.auth.tenant_id];
      let filter = "";
      if (req.auth.role === "professional") {
        params.push(req.auth.professional_id);
        filter = " AND a.professional_id=$2";
      }
      const messages = await many(
        db,
        `SELECT o.id,o.kind,o.status,o.scheduled_at,o.sent_at,o.attempts,o.error_code,a.starts_at,p.name professional FROM outbox o JOIN appointments a ON a.id=o.appointment_id JOIN professionals p ON p.id=a.professional_id WHERE o.tenant_id=$1${filter} ORDER BY o.scheduled_at DESC LIMIT 100`,
        params,
      );
      res.json({ messages });
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/outbox/:id/retry", ownerOnly, async (req, res, next) => {
    try {
      const id = uuid.parse(req.params.id);
      await transaction(db, async (tx) => {
        const m = await one(
          tx,
          "SELECT o.*,a.status appointment_status,a.starts_at FROM outbox o JOIN appointments a ON a.id=o.appointment_id WHERE o.id=$1 AND o.tenant_id=$2 FOR UPDATE OF o",
          [id, req.auth.tenant_id],
        );
        if (!m) throw httpError(404, "Mensagem não encontrada.");
        if (m.status !== "failed")
          throw httpError(
            409,
            "Só mensagens rejeitadas podem ser reenviadas. Entregas não confirmadas exigem conferência na Meta.",
          );
        const expected = m.kind === "cancellation" ? "cancelled" : "confirmed";
        if (
          m.appointment_status !== expected ||
          new Date(m.starts_at) < new Date()
        )
          throw httpError(
            409,
            "O agendamento não está elegível para esta mensagem.",
          );
        await tx.query(
          `UPDATE outbox SET status='queued',attempts=0,next_attempt_at=now(),error_code=NULL WHERE id=$1`,
          [id],
        );
        await audit(tx, req.auth.tenant_id, req.auth, "whatsapp.retried", id);
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/audit", ownerOnly, async (req, res, next) => {
    try {
      res.json({
        events: await many(
          db,
          "SELECT id,actor_type,action,entity_id,metadata,created_at FROM audit_events WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100",
          [req.auth.tenant_id],
        ),
      });
    } catch (e) {
      next(e);
    }
  });
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({ error: { message: "Rota não encontrada.", code: "NOT_FOUND" } }),
  );
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError)
      return res.status(400).json({
        error: {
          message: err.issues[0]?.message || "Dados inválidos.",
          code: "VALIDATION_ERROR",
        },
      });
    if (err.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: { message: "JSON inválido.", code: "INVALID_JSON" } });
    if (err.code === "23505")
      return res.status(409).json({
        error: {
          message:
            "Este registro já existe. Para WhatsApp, cada número da Meta deve pertencer a apenas uma clínica.",
          code: "CONFLICT",
        },
      });
    if (err.type === "entity.too.large")
      return res.status(413).json({
        error: { message: "Conteúdo muito grande.", code: "TOO_LARGE" },
      });
    if (isTransient(err))
      return res.status(503).json({
        error: {
          message:
            "Serviço temporariamente indisponível. Tente novamente em instantes.",
          code: "DATABASE_UNAVAILABLE",
        },
      });
    const status = err.expose ? err.status : 500;
    if (status === 500) {
      logger.error("http.unhandled_error", {
        requestId: req.id,
        code: err.code || err.name || "internal_error",
        ...(dev ? { error: err } : {}),
      });
    }
    res.status(status).json({
      error: {
        message:
          status === 500
            ? "Não foi possível concluir a operação. Tente novamente."
            : err.message,
        code: err.expose ? err.code : "INTERNAL_ERROR",
      },
    });
  });
  return app;
}
