import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { api, apiProbe, API_OFFLINE_MESSAGE } from "../src/api.js";

/**
 * Regressão do caso real: o site publicado como estático (Netlify, Vercel sem
 * funções, GitHub Pages) responde /api/* com a própria página HTML. Antes isso
 * virava "Não foi possível conectar. Tente novamente." e escondia a causa.
 */
let server, base;

const realFetch = globalThis.fetch;
const withBase = (url, options) =>
  realFetch(
    typeof url === "string" && url.startsWith("/") ? base + url : url,
    options,
  );

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/health") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<!doctype html><title>site</title>");
    }
    if (path === "/api/auth/register") {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end("<!doctype html><title>not found</title>");
    }
    if (path === "/api/auth/login") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = withBase;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

describe("cliente da API distingue site estático de erro de validação", () => {
  test("HTML em /api vira API_UNAVAILABLE, não erro genérico", async () => {
    await assert.rejects(
      api("/auth/register", { method: "POST", body: { email: "a@b.c" } }),
      (error) => {
        assert.equal(error.code, "API_UNAVAILABLE");
        assert.equal(error.message, API_OFFLINE_MESSAGE);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  test("a mensagem explica o que aconteceu e como resolver", () => {
    assert.match(API_OFFLINE_MESSAGE, /site estático/);
    assert.match(API_OFFLINE_MESSAGE, /Node\.js/);
    assert.match(API_OFFLINE_MESSAGE, /DEPLOY\.md/);
  });

  test("JSON válido continua funcionando normalmente", async () => {
    const data = await api("/auth/login", { method: "POST", body: {} });
    assert.deepEqual(data, { ok: true });
  });

  test("a sonda de saúde acusa ausência de API", async () => {
    const result = await apiProbe();
    assert.equal(result.ok, false);
    assert.equal(result.reason, API_OFFLINE_MESSAGE);
  });

  test("falha de rede também é reportada como indisponível", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const result = await apiProbe();
    assert.equal(result.ok, false);
    assert.equal(result.network, true);
    globalThis.fetch = withBase;
  });
});
