import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * A função do Netlify é exercitada como o runtime a chama: recebe um evento HTTP
 * e devolve statusCode/body. Prova que o roteamento, o cookie de sessão e o
 * corpo JSON funcionam iguais ao servidor Node — sem depender da Netlify.
 */
process.env.NODE_ENV = "test";
process.env.WHATSAPP_MODE = "disabled";
process.env.APP_ORIGIN = "https://agenda.netlify.test";

let pglite, socket, handler, cleanup;

const event = (method, path, { body, headers = {} } = {}) => ({
  httpMethod: method,
  path: `/.netlify/functions/api${path}`,
  headers: {
    host: "agenda.netlify.test",
    origin: "https://agenda.netlify.test",
    "x-forwarded-for": "203.0.113.10",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...headers,
  },
  queryStringParameters: null,
  body: body === undefined ? null : JSON.stringify(body),
  isBase64Encoded: false,
});

const call = async (method, path, options) => {
  const response = await handler(event(method, path, options), {});
  const rawCookies =
    response.multiValueHeaders?.["Set-Cookie"] ??
    response.multiValueHeaders?.["set-cookie"] ??
    response.headers?.["set-cookie"];
  return {
    status: response.statusCode,
    headers: response.headers,
    cookies: Array.isArray(rawCookies) ? rawCookies : rawCookies ? [String(rawCookies)] : [],
    body: (() => {
      try {
        return JSON.parse(response.body);
      } catch {
        return response.body;
      }
    })(),
  };
};

before(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  pglite = await PGlite.create({ extensions: { btree_gist } });
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 10 });
  await socket.start();
  process.env.DATABASE_URL = `postgresql://aurora:aurora@${socket.getServerConn()}/aurora`;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 41).toString("base64");
  ({ handler } = await import("../netlify/functions/api.mjs"));
  cleanup = async () => {
    await socket.stop();
    await pglite.close();
  };
});

after(async () => {
  await cleanup?.();
  delete process.env.DATABASE_URL;
});

describe("função serverless (Netlify)", () => {
  test("aplica as migrações no primeiro acesso e responde vivacidade", async () => {
    const health = await call("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.mode, "postgres");
  });

  test("a prontidão confirma banco e migrações", async () => {
    const ready = await call("GET", "/api/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.checks.database, true);
    assert.equal(ready.body.checks.migrations, true);
  });

  test("cadastro cria a conta e devolve cookie de sessão", async () => {
    const res = await call("POST", "/api/auth/register", {
      body: {
        workspace: "Clínica Netlify",
        name: "Dona Netlify",
        email: `netlify-${Date.now()}@teste.local`,
        password: "senha-de-teste-longa",
        privacy: true,
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.ok(res.cookies.length > 0, "a sessão deve vir em Set-Cookie");
    assert.match(res.cookies.join("; "), /aurora_session=/);
    assert.match(res.cookies.join("; "), /HttpOnly/i, "cookie de sessão não é acessível por script");
  });

  test("a API só existe dentro de /api (sem servir o HTML)", async () => {
    const res = await call("GET", "/qualquer-coisa");
    assert.equal(res.status, 404);
  });

  test("sem DATABASE_URL responde 503 explicando o que falta", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    // Recarrega o módulo para simular um deploy sem a variável configurada.
    const module = await import(`../netlify/functions/api.mjs?sem-banco=${Date.now()}`);
    const response = await module.handler(event("GET", "/api/health"), {});
    assert.equal(response.statusCode, 503);
    assert.match(JSON.parse(response.body).error.code, /DATABASE_NOT_CONFIGURED/);
    process.env.DATABASE_URL = saved;
  });
});
