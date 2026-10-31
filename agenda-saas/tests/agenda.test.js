import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { createDb, one, many } from "../server/db.js";
import { createApp } from "../server/app.js";
import {
  createWorkspace,
  book,
  decide,
  availableSlots,
} from "../server/domain.js";
import { digest, encryptSecret, token } from "../server/security.js";
import {
  templatePayload,
  verifyMetaSignature,
  handleWebhook,
} from "../server/whatsapp.js";
import { localDate, addDays, zonedToUtc } from "../server/time.js";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_MODE = "disabled";
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.META_APP_SECRET = "test-app-secret";

let db, app, tenant, session, csrf, professionalId, serviceId, other;
const nextWorkday = (from, steps = 1) => {
  let day = from;
  for (let added = 0; added < steps; ) {
    day = addDays(day, 1);
    if (![0, 6].includes(new Date(day + "T12:00:00Z").getUTCDay())) added++;
  }
  return day;
};
const TODAY = localDate(new Date(), "America/Sao_Paulo");
const DAY = nextWorkday(TODAY, 1);
const DAY2 = nextWorkday(TODAY, 2);
const DAY3 = nextWorkday(TODAY, 3);
const DAY4 = nextWorkday(TODAY, 4);

before(async () => {
  db = await createDb(":memory:");
  app = createApp(db, { dev: true });
  const ws = await createWorkspace(db, {
    workspace: "Clínica Teste",
    name: "Ana Teste",
    email: "ana@teste.demo",
    password: "frase-secreta-longa-123",
    privacy: true,
  });
  tenant = await one(db, "SELECT * FROM tenants WHERE id=$1", [ws.tenantId]);
  professionalId = ws.professionalId;
  serviceId = ws.serviceId;
  other = await createWorkspace(db, {
    workspace: "Outra Clínica",
    name: "Bruno Outro",
    email: "bruno@teste.demo",
    password: "outra-frase-longa-123",
    privacy: true,
  });
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email: "ana@teste.demo", password: "frase-secreta-longa-123" });
  assert.equal(login.status, 200);
  session = login.headers["set-cookie"][0].split(";")[0];
  csrf = (await request(app).get("/api/me").set("Cookie", session)).body.csrf;
});

after(async () => db.close());
beforeEach(async () => {
  await db.query("DELETE FROM rate_buckets");
});

const bookBody = (over = {}) => ({
  professionalId,
  serviceId,
  date: DAY,
  time: "09:00",
  name: "Cliente Teste",
  phone: "(11) 98888-7777",
  notes: "",
  consent: true,
  whatsappOptIn: true,
  idempotencyKey: randomUUID(),
  ...over,
});

describe("bloqueio de horário", () => {
  test("o primeiro pedido fica pendente e bloqueia o horário", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ time: "09:00" }));
    assert.equal(res.status, 201);
    assert.equal(res.body.appointment.status, "pending");
    assert.ok(res.body.accessToken.length >= 32);
    const slots = await availableSlots(
      db,
      tenant,
      professionalId,
      DAY,
      serviceId,
    );
    assert.ok(
      !slots.some((s) => s.time === "09:00"),
      "horário pendente não deve ser oferecido novamente",
    );
  });

  test("a restrição do banco impede sobreposição mesmo sem consulta prévia", async () => {
    const second = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ time: "09:00" }));
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "SLOT_UNAVAILABLE");
    const count = await one(
      db,
      "SELECT count(*)::int AS n FROM appointments WHERE starts_at=$1 AND status='pending'",
      [zonedToUtc(DAY, 540, "America/Sao_Paulo")],
    );
    assert.equal(count.n, 1);
  });

  test("a reserva é idempotente e não duplica com reenvio", async () => {
    const body = bookBody({ time: "10:00" });
    const first = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(body);
    const second = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.repeated, true);
    assert.equal(second.body.appointment.id, first.body.appointment.id);
  });

  test("a mesma chave com conteúdo diferente é rejeitada", async () => {
    const body = bookBody({ time: "11:00" });
    await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(body);
    const conflict = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send({ ...body, name: "Outra Pessoa" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  });

  test("horário fora da grade e intervalo reservado são recusados", async () => {
    const offGrid = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ time: "09:30" }));
    assert.equal(offGrid.status, 409);
    assert.equal(offGrid.body.error.code, "OUTSIDE_HOURS");
  });
});

describe("confirmação e cancelamento", () => {
  test("confirmar agenda confirmação e dois lembretes", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY3, time: "14:00" }));
    const id = res.body.appointment.id;
    const decision = await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    assert.equal(decision.status, 200);
    assert.equal(decision.body.status, "confirmed");
    const jobs = await many(
      db,
      "SELECT kind,scheduled_at FROM outbox WHERE appointment_id=$1 ORDER BY scheduled_at",
      [id],
    );
    assert.deepEqual(jobs.map((j) => j.kind).sort(), [
      "confirmation",
      "reminder_24h",
      "reminder_2h",
    ]);
    const start = new Date(res.body.appointment.startsAt).getTime();
    const byKind = Object.fromEntries(
      jobs.map((j) => [j.kind, new Date(j.scheduled_at).getTime()]),
    );
    assert.ok(
      byKind.confirmation <= Date.now() + 1000,
      "confirmação deve sair imediatamente",
    );
    assert.equal(byKind.reminder_24h, start - 86400000);
    assert.equal(byKind.reminder_2h, start - 7200000);
  });
  test("agendamento para menos de 24 horas não gera lembrete atrasado", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY4, time: "16:00" }));
    const id = res.body.appointment.id;
    // Desloca o atendimento para daqui a 3 horas antes de confirmar. Assim a
    // janela é sempre menor que 24 h, independentemente do dia da semana em
    // que o teste roda (antes dependia de DAY cair em menos de 24 h).
    const start = new Date(Date.now() + 3 * 3_600_000);
    await db.query(
      "UPDATE appointments SET starts_at=$2, ends_at=$3, blocked_until=$4 WHERE id=$1",
      [
        id,
        start,
        new Date(start.getTime() + 3_000_000),
        new Date(start.getTime() + 3_600_000),
      ],
    );
    await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    const kinds = (
      await many(db, "SELECT kind FROM outbox WHERE appointment_id=$1", [id])
    ).map((j) => j.kind);
    assert.ok(kinds.includes("confirmation"));
    assert.ok(
      !kinds.includes("reminder_24h"),
      "lembrete de 24 h cairia no passado e não deve ser criado",
    );
    assert.ok(
      kinds.includes("reminder_2h"),
      "lembrete de 2 h ainda está no futuro e deve ser criado",
    );
  });

  test("cancelar libera o horário e retira lembretes pendentes", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY3, time: "15:00" }));
    const id = res.body.appointment.id;
    await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    const cancel = await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "cancel" });
    assert.equal(cancel.status, 200);
    const jobs = await many(
      db,
      "SELECT kind,status FROM outbox WHERE appointment_id=$1",
      [id],
    );
    assert.ok(jobs.filter((j) => j.status === "cancelled").length >= 2);
    const slots = await availableSlots(
      db,
      tenant,
      professionalId,
      DAY,
      serviceId,
    );
    assert.ok(
      slots.some((s) => s.time === "15:00"),
      "horário cancelado deve voltar a ser oferecido",
    );
  });

  test("transição inválida é recusada", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY3, time: "16:00" }));
    const id = res.body.appointment.id;
    const complete = await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "complete" });
    assert.equal(complete.status, 409);
  });

  test("sem autorização de WhatsApp não há mensagens na fila", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY2, time: "09:00", whatsappOptIn: false }));
    const id = res.body.appointment.id;
    await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM outbox WHERE appointment_id=$1",
          [id],
        )
      ).n,
      0,
    );
  });
});

describe("isolamento entre clínicas", () => {
  test("outra clínica não enxerga nem decide o agendamento alheio", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY4, time: "17:00" }));
    const id = res.body.appointment.id;
    const otherLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "bruno@teste.demo", password: "outra-frase-longa-123" });
    const otherSession = otherLogin.headers["set-cookie"][0].split(";")[0];
    const otherCsrf = (
      await request(app).get("/api/me").set("Cookie", otherSession)
    ).body.csrf;
    assert.equal(
      (
        await request(app)
          .get(`/api/appointments/${id}`)
          .set("Cookie", otherSession)
      ).status,
      404,
    );
    assert.equal(
      (
        await request(app)
          .post(`/api/appointments/${id}/decision`)
          .set("Cookie", otherSession)
          .set("X-CSRF-Token", otherCsrf)
          .send({ action: "confirm" })
      ).status,
      404,
    );
    const list = await request(app)
      .get("/api/appointments")
      .set("Cookie", otherSession);
    assert.ok(!list.body.appointments.some((a) => a.id === id));
  });

  test("lista pública não expõe nome de clientes", async () => {
    const res = await request(app).get("/api/public/clinica-teste");
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes("Cliente Teste"));
    assert.ok(!body.includes("98888"));
  });

  test("consulta por telefone não existe; acompanhamento exige link secreto", async () => {
    const byPhone = await request(app)
      .post("/api/public/lookup")
      .send({ accessToken: "+5511988887777" });
    assert.equal(byPhone.status, 400);
    const random = await request(app)
      .post("/api/public/lookup")
      .send({ accessToken: token() });
    assert.equal(random.status, 404);
  });
});

describe("sessão, permissões e validação", () => {
  test("rota autenticada sem sessão retorna 401", async () => {
    assert.equal((await request(app).get("/api/appointments")).status, 401);
  });

  test("escrita sem CSRF é recusada", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", session)
      .send({ name: "Teste", duration: 30, buffer: 5, price: 0 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "CSRF_INVALID");
  });

  test("origem cruzada é recusada", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://malicioso.example")
      .send({ email: "ana@teste.demo", password: "frase-secreta-longa-123" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "ORIGIN_INVALID");
  });

  test("campos desconhecidos e telefone inválido são recusados", async () => {
    const extra = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send({ ...bookBody({ time: "09:00" }), role: "owner" });
    assert.equal(extra.status, 400);
    const phone = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ time: "09:00", phone: "123" }));
    assert.equal(phone.status, 400);
  });

  test("senha fora do padrão e cadastro duplicado são recusados", async () => {
    const weak = await request(app).post("/api/auth/register").send({
      workspace: "X Ltda",
      name: "Fulano",
      email: "novo@teste.demo",
      password: "curta",
      privacy: true,
    });
    assert.equal(weak.status, 400);
    const dup = await request(app).post("/api/auth/register").send({
      workspace: "Outra",
      name: "Fulano",
      email: "ana@teste.demo",
      password: "uma-senha-bem-longa-1",
      privacy: true,
    });
    assert.equal(dup.status, 409);
  });

  test("profissional convidado só vê a própria agenda e não acessa configurações", async () => {
    const ownerId = (
      await one(db, "SELECT id FROM users WHERE email='ana@teste.demo'")
    ).id;
    const proId = randomUUID();
    await db.query(
      "INSERT INTO professionals(id,tenant_id,name,specialty,color) VALUES($1,$2,$3,$4,$5)",
      [proId, tenant.id, "Carla Pro", "Psicologia", "#7764AA"],
    );
    const raw = token();
    await db.query(
      "INSERT INTO invitations(token_hash,tenant_id,professional_id,expires_at,created_by) VALUES($1,$2,$3,$4,$5)",
      [digest(raw), tenant.id, proId, new Date(Date.now() + 3600000), ownerId],
    );
    const inspect = await request(app)
      .post("/api/invitations/inspect")
      .send({ accessToken: raw });
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.invite.name, "Carla Pro");
    const accept = await request(app).post("/api/invitations/accept").send({
      accessToken: raw,
      email: "carla@teste.demo",
      password: "frase-da-carla-123",
      privacy: true,
    });
    assert.equal(accept.status, 201);
    const proSession = accept.headers["set-cookie"][0].split(";")[0];
    const me = await request(app).get("/api/me").set("Cookie", proSession);
    assert.equal(me.body.role, "professional");
    assert.equal(
      (await request(app).get("/api/whatsapp").set("Cookie", proSession))
        .status,
      403,
    );
    assert.equal(
      (await request(app).get("/api/audit").set("Cookie", proSession)).status,
      403,
    );
    assert.equal(
      (
        await request(app)
          .post("/api/professionals")
          .set("Cookie", proSession)
          .set("X-CSRF-Token", me.body.csrf)
          .send({ name: "Intruso", specialty: "X", color: "#112233" })
      ).status,
      403,
    );
    const reuse = await request(app).post("/api/invitations/accept").send({
      accessToken: raw,
      email: "outro@teste.demo",
      password: "outra-senha-bem-longa-1",
      privacy: true,
    });
    assert.equal(reuse.status, 404);
  });
});

describe("WhatsApp oficial", () => {
  test("o payload usa modelo aprovado e remove quebras de linha dos parâmetros", () => {
    const payload = templatePayload(
      {
        confirmation_template: "confirmacao",
        reminder_template: "lembrete",
        cancellation_template: "cancelamento",
        template_language: "pt_BR",
      },
      {
        starts_at: zonedToUtc(DAY, 600, "America/Sao_Paulo"),
        timezone: "America/Sao_Paulo",
        client_name: "Ana\nBeatriz",
        professional_name: "Camila",
        tenant_name: "Aurora",
      },
      "confirmation",
      "+5511988887777",
    );
    assert.equal(payload.to, "5511988887777");
    assert.equal(payload.type, "template");
    assert.equal(payload.template.name, "confirmacao");
    assert.equal(
      payload.template.components[0].parameters[0].text,
      "Ana Beatriz",
    );
    assert.equal(
      payload.template.components[0].parameters[2].text,
      "03/11/2026".slice(0, 10).length === 10
        ? payload.template.components[0].parameters[2].text
        : "",
    );
  });

  test("a assinatura do webhook só é aceita com HMAC válido", async () => {
    const raw = Buffer.from('{"object":"whatsapp_business_account"}');
    const { createHmac } = await import("node:crypto");
    const good =
      "sha256=" +
      createHmac("sha256", "test-app-secret").update(raw).digest("hex");
    assert.equal(verifyMetaSignature(raw, good, "test-app-secret"), true);
    assert.equal(verifyMetaSignature(raw, good, "outro"), false);
    assert.equal(verifyMetaSignature(raw, undefined, "test-app-secret"), false);
  });

  test("webhook sem assinatura é recusado pela API", async () => {
    const res = await request(app)
      .post("/api/webhooks/meta")
      .set("Content-Type", "application/json")
      .send({ object: "whatsapp_business_account" });
    assert.equal(res.status, 401);
  });

  test("webhook valida o token de verificação", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-123";
    assert.equal(
      (
        await request(app).get(
          "/api/webhooks/meta?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=verify-123",
        )
      ).text,
      "abc",
    );
    assert.equal(
      (
        await request(app).get(
          "/api/webhooks/meta?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=errado",
        )
      ).status,
      403,
    );
  });

  test("status do webhook só altera a mensagem da clínica correta", async () => {
    await db.query(
      "UPDATE whatsapp_configs SET phone_number_id='102345678901234', enabled=true WHERE tenant_id=$1",
      [tenant.id],
    );
    const a = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY2, time: "10:00" }));
    await request(app)
      .post(`/api/appointments/${a.body.appointment.id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    const job = await one(
      db,
      "SELECT * FROM outbox WHERE appointment_id=$1 AND kind='confirmation'",
      [a.body.appointment.id],
    );
    await db.query(
      "UPDATE outbox SET provider_message_id='wamid.TEST' WHERE id=$1",
      [job.id],
    );
    await db.query(
      "UPDATE whatsapp_configs SET enabled=false WHERE tenant_id=$1",
      [tenant.id],
    );
    const body = {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "102345678901234" },
                statuses: [{ id: "wamid.TEST", status: "failed" }],
              },
            },
          ],
        },
      ],
    };
    const updated = await handleWebhook(db, body);
    assert.equal(updated, 1);
    assert.equal(
      (await one(db, "SELECT status FROM outbox WHERE id=$1", [job.id])).status,
      "failed",
    );
  });

  test("token da Meta é cifrado e nunca retornado", async () => {
    const cipher = await encryptSecret("EAAG-token-de-teste-123456");
    assert.ok(!cipher.includes("EAAG"));
    const put = await request(app)
      .put("/api/whatsapp")
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({
        phoneNumberId: "102345678901234",
        accessToken: "EAAG-token-de-teste-123456",
        confirmationTemplate: "confirmacao",
        reminderTemplate: "lembrete",
        cancellationTemplate: "cancelamento",
        language: "pt_BR",
        enabled: false,
      });
    assert.equal(put.status, 200);
    const get = await request(app).get("/api/whatsapp").set("Cookie", session);
    assert.equal(get.body.config.configured, true);
    assert.ok(!JSON.stringify(get.body).includes("EAAG"));
    assert.ok(!("access_token_cipher" in get.body.config));
  });

  test("número da Meta não pode ser reutilizado por outra clínica", async () => {
    const otherLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "bruno@teste.demo", password: "outra-frase-longa-123" });
    const s = otherLogin.headers["set-cookie"][0].split(";")[0];
    const c = (await request(app).get("/api/me").set("Cookie", s)).body.csrf;
    const res = await request(app)
      .put("/api/whatsapp")
      .set("Cookie", s)
      .set("X-CSRF-Token", c)
      .send({
        phoneNumberId: "102345678901234",
        confirmationTemplate: "confirmacao",
        reminderTemplate: "lembrete",
        cancellationTemplate: "cancelamento",
        language: "pt_BR",
        enabled: false,
      });
    assert.equal(res.status, 409);
  });

  test("modo seguro deixa a fila intacta sem chamar a Meta", async () => {
    const { processOne } = await import("../server/whatsapp.js");
    const result = await processOne(db, () =>
      assert.fail("não deve chamar a rede"),
    );
    assert.equal(result.waiting, true);
  });
});

describe("limites e detalhes", () => {
  test("limite de reservas responde 429", async () => {
    let limited = null;
    for (let i = 0; i < 20 && !limited; i++) {
      const res = await request(app)
        .post("/api/public/clinica-teste/appointments")
        .send(bookBody({ time: "09:00" }));
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, "esperava 429 após exceder o limite");
    assert.ok(limited.headers["retry-after"]);
  });

  test("comentário com HTML é devolvido como texto e não como marcação", async () => {
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(
        bookBody({
          date: DAY2,
          time: "11:00",
          notes: "<img src=x onerror=alert(1)>",
        }),
      );
    assert.equal(res.status, 201);
    const list = await request(app)
      .get("/api/appointments")
      .set("Cookie", session);
    const item = list.body.appointments.find(
      (a) => a.id === res.body.appointment.id,
    );
    assert.equal(item.notes, "<img src=x onerror=alert(1)>");
    const toc = await readFile(
      new URL("../server/app.js", import.meta.url),
      "utf8",
    );
    assert.ok(!toc.includes("dangerouslySetInnerHTML"));
  });
});

describe("fila e revogação", () => {
  test("revogar a autorização retira mensagens pendentes e impede envio", async () => {
    const DAY3 = nextWorkday(TODAY, 3);
    const res = await request(app)
      .post("/api/public/clinica-teste/appointments")
      .send(bookBody({ date: DAY3, time: "09:00", whatsappOptIn: true }));
    const id = res.body.appointment.id;
    await request(app)
      .post(`/api/appointments/${id}/decision`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ action: "confirm" });
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM outbox WHERE appointment_id=$1 AND status='queued'",
          [id],
        )
      ).n,
      3,
    );
    const revoke = await request(app)
      .post(`/api/appointments/${id}/messaging-consent`)
      .set("Cookie", session)
      .set("X-CSRF-Token", csrf)
      .send({ optIn: false });
    assert.equal(revoke.status, 200);
    assert.equal(
      (
        await one(
          db,
          "SELECT count(*)::int n FROM outbox WHERE appointment_id=$1 AND status='queued'",
          [id],
        )
      ).n,
      0,
    );
    assert.equal(
      (
        await one(db, "SELECT whatsapp_opt_in FROM appointments WHERE id=$1", [
          id,
        ])
      ).whatsapp_opt_in,
      false,
    );
  });

  test("falha de entrega ambígua não é reenviada automaticamente", async () => {
    const { processOne } = await import("../server/whatsapp.js");
    process.env.WHATSAPP_MODE = "live";
    try {
      await db.query("DELETE FROM outbox WHERE tenant_id=$1", [tenant.id]);
      const res = await request(app)
        .post("/api/public/clinica-teste/appointments")
        .send(bookBody({ date: DAY4, time: "10:00", whatsappOptIn: true }));
      const id = res.body.appointment.id;
      await request(app)
        .post(`/api/appointments/${id}/decision`)
        .set("Cookie", session)
        .set("X-CSRF-Token", csrf)
        .send({ action: "confirm" });
      await db.query(
        "UPDATE whatsapp_configs SET phone_number_id='102345678901234', enabled=true, access_token_cipher=$2 WHERE tenant_id=$1",
        [tenant.id, await encryptSecret("EAAG-exemplo-de-token-valido")],
      );
      let calls = 0;
      const failing = async () => {
        calls += 1;
        throw new Error("tempo esgotado");
      };
      const result = await processOne(db, failing, new Date());
      assert.equal(result.unknown, true);
      const job = await one(
        db,
        "SELECT status, attempts FROM outbox WHERE appointment_id=$1 AND kind='confirmation'",
        [id],
      );
      assert.equal(job.status, "unknown");
      const next = await processOne(db, failing, new Date());
      assert.equal(
        next.idle,
        true,
        "entrega ambígua não deve ser tentada de novo",
      );
      assert.equal(calls, 1);
      assert.equal(
        (await one(db, "SELECT status FROM appointments WHERE id=$1", [id]))
          .status,
        "confirmed",
      );
    } finally {
      process.env.WHATSAPP_MODE = "disabled";
      await db.query(
        "UPDATE whatsapp_configs SET enabled=false WHERE tenant_id=$1",
        [tenant.id],
      );
    }
  });

  test("limite de tentativas de login é aplicado no servidor", async () => {
    await db.query("DELETE FROM rate_buckets");
    let limited = null;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "ana@teste.demo", password: "senha-errada" });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, "esperava bloqueio após tentativas repetidas");
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    await db.query("DELETE FROM rate_buckets");
    assert.equal(
      (
        await request(app).post("/api/auth/login").send({
          email: "ana@teste.demo",
          password: "frase-secreta-longa-123",
        })
      ).status,
      200,
    );
  });
});
