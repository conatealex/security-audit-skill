import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { createDb, one } from "../server/db.js";
import { createApp } from "../server/app.js";
import { createWorkspace } from "../server/domain.js";
import { resetMailer } from "../server/mailer.js";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_MODE = "disabled";
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
process.env.APP_ORIGIN = "https://agenda.test";

let db,
  app,
  smtp,
  mailbox = [],
  user,
  password = "senha-antiga-bem-longa";

async function startSmtp() {
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", async () => {
        const parsed = await simpleParser(Buffer.concat(chunks));
        mailbox.push({
          to: parsed.to?.value?.[0]?.address,
          subject: parsed.subject,
          text: parsed.text,
          html: parsed.html,
        });
        callback();
      });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const linkFrom = (mail) => mail.text.match(/https?:\/\/\S+/)[0];
const tokenFrom = (mail) => linkFrom(mail).split("#")[1];

before(async () => {
  smtp = await startSmtp();
  process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.server.address().port}`;
  process.env.MAIL_FROM = "Aurora <nao-responda@agenda.test>";
  resetMailer();
  db = await createDb(":memory:");
  app = createApp(db, { dev: true });
  const workspace = await createWorkspace(db, {
    workspace: "Clínica Senha",
    name: "Dona Senha",
    email: "dona@clinica.test",
    password,
    privacy: true,
  });
  user = { id: workspace.userId, email: "dona@clinica.test" };
});

after(async () => {
  await db?.close();
  await new Promise((resolve) => smtp.close(resolve));
  delete process.env.SMTP_URL;
  resetMailer();
});

beforeEach(async () => {
  mailbox = [];
  // O limite de tentativas é por IP e por janela: cada caso começa limpo.
  await db.query("DELETE FROM rate_buckets");
});

const forgot = (email) => request(app).post("/api/auth/forgot").send({ email });

describe("redefinição de senha por link", () => {
  test("envia e-mail com link de uso único e válido", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password })
      .expect(200);
    const res = await forgot(user.email);
    assert.equal(res.status, 200);
    assert.equal(mailbox.length, 1, "um e-mail deve ser enviado");
    assert.equal(mailbox[0].to, user.email);
    assert.match(mailbox[0].subject, /Redefinir sua senha/);
    assert.match(linkFrom(mailbox[0]), /^https:\/\/agenda\.test\/redefinir#/);
    assert.match(
      mailbox[0].html,
      /Criar nova senha/,
      "versão HTML para clientes de e-mail",
    );
    const stored = await one(
      db,
      "SELECT token_hash FROM password_resets WHERE user_id=$1",
      [user.id],
    );
    assert.notEqual(
      stored.token_hash,
      tokenFrom(mailbox[0]),
      "o banco guarda apenas o hash",
    );
    assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  });

  test("e-mail desconhecido recebe a mesma resposta e não gera envio", async () => {
    const known = await forgot(user.email);
    const unknown = await forgot("ninguem@clinica.test");
    assert.equal(unknown.status, 200);
    assert.deepEqual(
      unknown.body,
      known.body,
      "resposta idêntica evita enumerar contas",
    );
    assert.equal(mailbox.length, 1, "só o e-mail existente recebe mensagem");
  });

  test("o link define a nova senha, encerra sessões antigas e não serve duas vezes", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password });
    const oldCookie = login.headers["set-cookie"][0].split(";")[0];
    await forgot(user.email);
    const token = tokenFrom(mailbox[0]);

    const inspect = await request(app)
      .post("/api/auth/reset/inspect")
      .send({ token });
    assert.equal(inspect.body.valid, true);
    assert.match(
      inspect.body.email,
      /^do\*+@clinica\.test$/,
      "mostra o e-mail mascarado",
    );

    const reset = await request(app)
      .post("/api/auth/reset")
      .send({ token, password: "senha-nova-bem-longa" });
    assert.equal(reset.status, 200);

    const oldSession = await request(app)
      .get("/api/me")
      .set("Cookie", oldCookie);
    assert.equal(oldSession.status, 401, "sessões abertas caem após a troca");

    await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password })
      .expect(401);
    await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "senha-nova-bem-longa" })
      .expect(200);
    password = "senha-nova-bem-longa";

    const reuse = await request(app)
      .post("/api/auth/reset")
      .send({ token, password: "outra-senha-bem-longa" });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error.code, "RESET_USED");
    const after = await request(app)
      .post("/api/auth/reset/inspect")
      .send({ token });
    assert.equal(after.body.valid, false);
    assert.equal(after.body.reason, "used");
  });

  test("pedir um link novo invalida o anterior", async () => {
    await forgot(user.email);
    const first = tokenFrom(mailbox[0]);
    await forgot(user.email);
    const second = tokenFrom(mailbox[1]);
    assert.notEqual(first, second);
    const stale = await request(app)
      .post("/api/auth/reset")
      .send({ token: first, password: "senha-de-teste-longa" });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error.code, "RESET_USED");
    await request(app)
      .post("/api/auth/reset")
      .send({ token: second, password: "senha-de-teste-longa" })
      .expect(200);
    password = "senha-de-teste-longa";
  });

  test("link expirado é recusado com mensagem própria", async () => {
    await forgot(user.email);
    const token = tokenFrom(mailbox[0]);
    await db.query(
      "UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id=$1",
      [user.id],
    );
    const res = await request(app)
      .post("/api/auth/reset")
      .send({ token, password: "senha-de-teste-longa" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "RESET_EXPIRED");
    const inspect = await request(app)
      .post("/api/auth/reset/inspect")
      .send({ token });
    assert.equal(inspect.body.reason, "expired");
  });

  test("token inventado não altera nada", async () => {
    const before = await one(
      db,
      "SELECT password_hash FROM users WHERE id=$1",
      [user.id],
    );
    const res = await request(app)
      .post("/api/auth/reset")
      .send({ token: "x".repeat(43), password: "senha-de-teste-longa" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "RESET_INVALID");
    const after = await one(db, "SELECT password_hash FROM users WHERE id=$1", [
      user.id,
    ]);
    assert.equal(after.password_hash, before.password_hash);
  });

  test("senha curta é recusada antes de qualquer alteração", async () => {
    await forgot(user.email);
    const token = tokenFrom(mailbox[0]);
    const res = await request(app)
      .post("/api/auth/reset")
      .send({ token, password: "curta" });
    assert.equal(res.status, 400);
    const row = await one(
      db,
      "SELECT used_at FROM password_resets WHERE user_id=$1 ORDER BY created_at DESC",
      [user.id],
    );
    assert.equal(
      row.used_at,
      null,
      "o link continua válido depois de uma tentativa inválida",
    );
  });

  test("conta técnica sem senha real nunca recebe link", async () => {
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,'!disabled-login')",
      [id, "tecnica@clinica.test", "Conta Técnica"],
    );
    const res = await forgot("tecnica@clinica.test");
    assert.equal(res.status, 200);
    assert.equal(mailbox.length, 0);
    assert.equal(
      await one(db, "SELECT token_hash FROM password_resets WHERE user_id=$1", [
        id,
      ]),
      null,
    );
  });

  test("o pedido fica registrado na auditoria", async () => {
    await forgot(user.email);
    const row = await one(
      db,
      "SELECT action FROM audit_events WHERE action='account.password_reset_requested' ORDER BY id DESC",
    );
    assert.ok(row, "auditoria registra o pedido de redefinição");
  });
});
