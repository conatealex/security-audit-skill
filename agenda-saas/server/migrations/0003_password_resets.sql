-- 0003: redefinição de senha por link de uso único.
-- Guarda apenas o hash SHA-256 do token (o token em claro só existe no e-mail).

-- Eventos de conta (redefinição de senha) podem não ter clínica associada:
-- a auditoria registra a ação mesmo antes de o usuário ter vínculo.
ALTER TABLE audit_events ALTER COLUMN tenant_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS password_resets_expiry ON password_resets(expires_at);
