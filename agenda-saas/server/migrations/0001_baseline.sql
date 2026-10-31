CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','professional')),
  PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS professionals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid UNIQUE REFERENCES users(id),
  name text NOT NULL,
  specialty text NOT NULL DEFAULT 'Atendimento',
  color text NOT NULL DEFAULT '#167D72',
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 240),
  buffer_minutes integer NOT NULL DEFAULT 10 CHECK (buffer_minutes BETWEEN 0 AND 120),
  price_cents integer NOT NULL DEFAULT 0 CHECK (price_cents BETWEEN 0 AND 10000000),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id,id)
);
CREATE TABLE IF NOT EXISTS working_hours (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute),
  FOREIGN KEY (tenant_id,professional_id) REFERENCES professionals(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS time_off (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT 'Indisponível',
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id,professional_id) REFERENCES professionals(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone_e164 text NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,phone_e164)
);
CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL,
  service_id uuid NOT NULL,
  client_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed')),
  notes text NOT NULL DEFAULT '',
  client_token_hash text NOT NULL UNIQUE,
  consent_at timestamptz NOT NULL,
  whatsapp_opt_in boolean NOT NULL DEFAULT false,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL,
  decision_reason text,
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND blocked_until >= ends_at),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,professional_id) REFERENCES professionals(tenant_id,id),
  FOREIGN KEY (tenant_id,service_id) REFERENCES services(tenant_id,id),
  FOREIGN KEY (tenant_id,client_id) REFERENCES clients(tenant_id,id),
  EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at,blocked_until,'[)') WITH &&)
    WHERE (status IN ('pending','confirmed'))
);
CREATE INDEX IF NOT EXISTS appointments_tenant_date ON appointments(tenant_id,starts_at);
CREATE INDEX IF NOT EXISTS appointments_professional_date ON appointments(professional_id,starts_at);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id),
  actor_type text NOT NULL,
  action text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS whatsapp_configs (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id text NOT NULL DEFAULT '',
  access_token_cipher text NOT NULL DEFAULT '',
  confirmation_template text NOT NULL DEFAULT 'confirmacao_agendamento',
  reminder_template text NOT NULL DEFAULT 'lembrete_agendamento',
  cancellation_template text NOT NULL DEFAULT 'cancelamento_agendamento',
  template_language text NOT NULL DEFAULT 'pt_BR',
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('confirmation','reminder_24h','reminder_2h','cancellation')),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sent','failed','cancelled','skipped','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  provider_message_id text UNIQUE,
  error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appointment_id,kind),
  FOREIGN KEY (tenant_id,appointment_id) REFERENCES appointments(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_attempt_at,scheduled_at);
CREATE TABLE IF NOT EXISTS rate_buckets (
  key text PRIMARY KEY,
  count integer NOT NULL,
  resets_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_unique_number ON whatsapp_configs(phone_number_id) WHERE phone_number_id <> '';
CREATE TABLE IF NOT EXISTS invitations (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(professional_id),
  FOREIGN KEY(tenant_id,professional_id) REFERENCES professionals(tenant_id,id) ON DELETE CASCADE
);
