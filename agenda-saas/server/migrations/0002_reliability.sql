-- 0002: confiabilidade da fila de mensagens e observabilidade do worker.
-- Aditiva e idempotente: pode ser aplicada sobre instalações existentes.

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_at timestamptz;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('queued','processing','sent','failed','cancelled','skipped','unknown','dead'));

-- Índice parcial: a consulta do worker percorre apenas mensagens prontas para envio.
CREATE INDEX IF NOT EXISTS outbox_ready ON outbox (scheduled_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS outbox_processing ON outbox (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS outbox_unknown ON outbox (tenant_id) WHERE status = 'unknown';

-- Repara resíduo de uma tentativa anterior interrompida no meio do DDL:
-- o tipo composto pode existir sem a tabela correspondente.
DO $$
BEGIN
  IF to_regclass('worker_heartbeats') IS NULL
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'worker_heartbeats') THEN
    DROP TYPE worker_heartbeats;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  name text PRIMARY KEY,
  instance text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
