/**
 * Aplica as migrações sem subir o servidor.
 *
 *   npm run migrate            # aplica o que estiver pendente
 *   npm run migrate -- --status  # só mostra o estado
 *
 * Use em esteiras de deploy antes de trocar a versão em produção.
 */
import { createDb } from "./db.js";
import { migrate, migrationStatus } from "./migrate.js";

const onlyStatus = process.argv.includes("--status");
const db = await createDb({ migrate: false });
try {
  if (onlyStatus) {
    const status = await migrationStatus(db);
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = status.pending.length || status.changed.length ? 1 : 0;
  } else {
    const status = await migrationStatus(db);
    const result = await migrate(db, {
      log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
    });
    console.log(
      JSON.stringify({
        event: "migrate.done",
        applied: result.applied,
        alreadyApplied: status.applied.length,
        total: result.total,
      }),
    );
    process.exitCode = 0;
  }
} catch (error) {
  console.error(
    JSON.stringify({ event: "migrate.failed", message: error.message }),
  );
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
