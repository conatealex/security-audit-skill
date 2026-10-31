/**
 * Fila de mensagens no Netlify: em serverless não existe processo permanente,
 * então o ciclo do worker roda por agenda (a cada 10 minutos, no mínimo).
 *
 * Sem isso, mensagens em `queued` continuariam paradas. O worker é o mesmo do
 * servidor: limite de tentativas, backoff, dead-letter e 'unknown' para entrega
 * ambígua — nada de reenvio cego.
 */
import { createDb } from "../../server/db.js";
import { runWorkerTick } from "../../server/whatsapp.js";
import { logger } from "../../server/logger.js";

export const config = { schedule: "*/10 * * * *" };

export default async () => {
  if (!process.env.DATABASE_URL) {
    logger.warn("worker.skipped", { reason: "DATABASE_URL ausente" });
    return { statusCode: 200, body: "sem banco configurado" };
  }
  const db = await createDb({ migrate: false, poolMax: 2 });
  try {
    const stats = await runWorkerTick(db, 20);
    return { statusCode: 200, body: JSON.stringify(stats) };
  } catch (error) {
    logger.error("worker.tick_failed", { error });
    return { statusCode: 500, body: "falha no ciclo do worker" };
  } finally {
    await db.close().catch(() => {});
  }
};
