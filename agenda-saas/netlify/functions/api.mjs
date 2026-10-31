/**
 * API da Aurora no Netlify Functions.
 *
 * O Express roda inteiro dentro da função; o banco é o PostgreSQL informado em
 * `DATABASE_URL` (Neon, Supabase, Render, RDS…). Não há estado em memória entre
 * invocações além do pool reaproveitado e da migração já aplicada.
 */
import serverless from "serverless-http";
import { createApp } from "../../server/app.js";
import { createDb } from "../../server/db.js";
import { migrate } from "../../server/migrate.js";
import { logger } from "../../server/logger.js";

let ready;

async function bootstrap() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL não configurada. Defina a string de conexão do PostgreSQL nas variáveis de ambiente do site.",
    );
  }
  const db = await createDb({ migrate: false, poolMax: Number(process.env.DB_POOL_MAX || 3) });
  await migrate(db, { log: (event, detail) => logger.info(event, detail) });
  // A Netlify injeta X-Forwarded-For; sem confiar no proxy o limitador recusa.
  process.env.TRUST_PROXY ??= "true";
  const app = createApp(db, { dev: false });
  const handler = serverless(app, { basePath: "/.netlify/functions/api" });
  return { db, handler };
}

export async function handler(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    ready ??= bootstrap();
    const { handler: run } = await ready;
    return await run(event, context);
  } catch (error) {
    // Cold start sem banco não deve derrubar a função inteira.
    ready = undefined;
    logger.error("netlify.bootstrap_failed", { error });
    const missingDatabase = !process.env.DATABASE_URL;
    return {
      statusCode: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: {
          message: missingDatabase
            ? "Banco de dados não configurado neste site (DATABASE_URL)."
            : "Serviço temporariamente indisponível. Tente novamente em instantes.",
          code: missingDatabase ? "DATABASE_NOT_CONFIGURED" : "DATABASE_UNAVAILABLE",
        },
      }),
    };
  }
}
