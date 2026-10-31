# Publicar a Aurora

Esta é uma aplicação **Node.js com servidor próprio**: entrega o site e a API no mesmo endereço e guarda os dados em **PostgreSQL gerenciado**. Precisa de uma hospedagem que execute Node (Render, Railway, Fly.io, VPS) **e** de um PostgreSQL (o do próprio provedor, Neon, Supabase, RDS…).

> **Netlify/Vercel sem servidor não serve para o sistema completo.** O envio por arrastar-e-soltar publica apenas arquivos estáticos: a página abre, mas ninguém consegue criar conta, entrar, agendar, confirmar ou receber lembretes, porque a API não existe nesse tipo de hospedagem.
>
> **Sintoma:** a tela de cadastro abre normalmente, o botão **Criar meu espaço** responde "Não foi possível conectar. Tente novamente." ou exibe a faixa *"A API deste sistema não está respondendo neste endereço"*. Isso não é bug de validação: o `POST /api/auth/register` foi entregue ao servidor estático, que devolveu a própria página HTML em vez de JSON. A conferência leva 2 segundos:
>
> ```bash
> curl -i -X POST https://SEU-SITE/api/auth/register -H 'Content-Type: application/json' -d '{}'
> ```
>
> Se o `Content-Type` vier `text/html`, o endereço é estático — publique com o caminho abaixo (ou aponte `/api` para uma API real, como no `netlify.toml` comentado).

---

## Resumo: o que muda em relação à versão anterior

| Antes | Agora |
| --- | --- |
| Banco PGlite em disco (`DATABASE_PATH`) | PostgreSQL gerenciado (`DATABASE_URL`), pool com reconexão |
| Esquema criado na primeira execução | **Migrações versionadas** com checksum, aplicadas sob trava de banco |
| Fila sem limite de tentativas | Limite de tentativas, backoff exponencial com jitter, dead-letter |
| Erro de envio ambíguo podia reenviar | Entrega ambígua vira `unknown` e **nunca** é reenviada sozinha |
| `/api/health` respondia mesmo com banco fora | `/api/health` (vivacidade) e `/api/ready` (prontidão) separados |

O PGlite continua existindo apenas como atalho de **desenvolvimento local** (sem `DATABASE_URL`). Em produção o servidor se recusa a iniciar sem `DATABASE_URL` — evita subir achando que está tudo bem enquanto grava em disco efêmero.

---

## Opção 1 — Render (mais rápido)

1. Suba o conteúdo deste pacote em um repositório (sem `node_modules`, sem `data`, sem `.env`).
2. No Render: **New → Blueprint** e escolha o repositório. O `render.yaml` cria **dois** recursos: o serviço Docker e um PostgreSQL gerenciado; a `DATABASE_URL` é injetada automaticamente.
3. Depois do primeiro deploy, em **Environment**, preencha:
   - `APP_ORIGIN` = `https://SEU-SERVICO.onrender.com` (sem barra no fim);
   - `META_APP_SECRET` e `META_WEBHOOK_VERIFY_TOKEN` apenas quando for usar o WhatsApp real.
4. A `DATA_ENCRYPTION_KEY` é gerada pelo Render. **Copie o valor** para o seu cofre: sem ela, os tokens da Meta gravados no banco não podem ser lidos.
5. Aguarde o **health check em `/api/ready`** ficar verde e acesse `https://...onrender.com/entrar` → **Criar conta**.

> `ALLOW_REGISTRATION=false` por padrão no blueprint: crie a conta da clínica e depois mantenha o cadastro fechado (o painel gera convites para os profissionais).

## Opção 2 — Railway

1. **New Project → Deploy from GitHub** — o Railway detecta o `Dockerfile`.
2. **New → Database → PostgreSQL** no mesmo projeto.
3. No serviço da aplicação, em **Variables**:
   - `NODE_ENV=production`
   - `APP_ORIGIN=https://SEU-DOMINIO` (gere o domínio em **Settings → Networking**)
   - `DATA_ENCRYPTION_KEY` (32 bytes base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (referência à variável do plugin Postgres)
4. Deploy. O Railway reinicia o container automaticamente em falha; deixe **réplicas = 1**.

## Opção 3 — Fly.io

```bash
fly launch --no-deploy                                   # usa o fly.toml incluído
fly postgres create --name aurora-db --region gru        # ou Neon/Supabase
fly postgres attach aurora-db --app aurora-agenda        # define DATABASE_URL como segredo
fly secrets set \
  DATA_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  APP_ORIGIN="https://aurora-agenda.fly.dev"
fly deploy
```

Mantenha `min_machines_running = 1`: a fila de lembretes precisa de um processo sempre ativo. As verificações do `fly.toml` apontam para `/api/ready`.

## Opção 4 — VPS ou servidor próprio (Docker Compose)

O `docker-compose.yml` incluído sobe **app + PostgreSQL 17** com volume nomeado, `restart: unless-stopped` e healthchecks:

```bash
cp .env.example .env
# edite .env: POSTGRES_PASSWORD, DATA_ENCRYPTION_KEY, APP_ORIGIN, ALLOW_REGISTRATION
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # valor de DATA_ENCRYPTION_KEY
docker compose up -d --build
docker compose ps        # os dois serviços devem ficar "healthy"
```

O app escuta apenas em `127.0.0.1:3000`; coloque Nginx ou Caddy na frente para HTTPS:

```
agenda.suaclinica.com.br {
    reverse_proxy 127.0.0.1:3000
}
```

Para atualizar: `docker compose up -d --build` (as migrações rodam no boot, sob trava, antes de aceitar tráfego).

## Sem Docker (Node 22+)

```bash
npm ci --omit=dev
npm run build
NODE_ENV=production \
DATABASE_URL="postgres://usuario:senha@host:5432/aurora?sslmode=require" \
DATA_ENCRYPTION_KEY="<chave>" \
APP_ORIGIN="https://agenda.suaclinica.com.br" \
npm start
```

Use `systemd`, `pm2` ou equivalente para reiniciar em falhas. Exemplo de unidade systemd:

```ini
[Unit]
Description=Aurora Agenda
After=network-online.target

[Service]
WorkingDirectory=/srv/aurora
EnvironmentFile=/srv/aurora/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
User=aurora

[Install]
WantedBy=multi-user.target
```

---

## Variáveis obrigatórias em produção

| Variável | Valor |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | String de conexão do PostgreSQL gerenciado (**obrigatória**; o servidor não inicia sem ela) |
| `DATA_ENCRYPTION_KEY` | 32 bytes em base64 — sem ela o servidor **não inicia** |
| `APP_ORIGIN` | URL pública, ex.: `https://agenda.suaclinica.com.br` (obrigatória) |
| `WHATSAPP_MODE` | `disabled` até a integração estar pronta; depois `live` |
| `META_APP_SECRET` | Obrigatória quando `WHATSAPP_MODE=live` (assinatura do webhook) |
| `META_WEBHOOK_VERIFY_TOKEN` | Só quando o WhatsApp real estiver ativo |

Opcionais relevantes: `DB_POOL_MAX` (10), `DB_CONNECT_RETRIES` (15), `DB_STATEMENT_TIMEOUT_MS` (30000), `WORKER_MAX_ATTEMPTS` (5), `WORKER_INTERVAL_MS` (15000), `MIGRATE_ON_START` (`true`), `APP_VERSION` (aparece no `/api/ready`).

**Nunca** ative `DEMO_MODE` em produção: o servidor ignora essa opção quando `NODE_ENV=production`, mas o ideal é deixá-la ausente. `ALLOW_EPHEMERAL_DB=true` existe apenas para testes de container e desliga a exigência de `DATABASE_URL`.

---

## Migrações

O servidor aplica as migrações no boot, antes de abrir a porta, sob `pg_advisory_lock` — duas instâncias subindo juntas não brigam. Cada arquivo em `server/migrations/` é registrado em `schema_migrations` com um checksum SHA-256:

- **arquivo novo** → aplicado;
- **arquivo já aplicado e editado** → o servidor **se recusa a iniciar** e `/api/ready` responde 503 com `changedMigrations`. Crie uma nova migração em vez de editar a antiga;
- **DDL + registro na mesma transação** → ou a migração inteira vale, ou nada muda.

Comandos:

```bash
npm run migrate:status   # mostra aplicadas, pendentes e divergentes (sai com 1 se houver pendência)
npm run migrate          # aplica o que estiver pendente, sem subir o servidor
MIGRATE_ON_START=false   # deixe o boot rápido e migre antes, pela esteira
```

---

## Prontidão e vivacidade

| Rota | Para que serve | Resposta |
| --- | --- | --- |
| `/api/health` | **Vivacidade**: o processo está de pé? | `200` sempre que o processo responde |
| `/api/ready` | **Prontidão**: banco, migrações, chave e worker | `200` só quando tudo está pronto; `503` com `checks` e `detail` |

Use `/api/ready` no healthcheck do provedor (Docker, Render, Fly). Assim o tráfego só chega quando o banco e o esquema estão prontos, e a plataforma reinicia o processo quando ele fica realmente travado. Quedas momentâneas de banco durante uma requisição viram **503 `DATABASE_UNAVAILABLE`** (com nova tentativa no cliente), não 500.

## Fila de mensagens (WhatsApp)

- Cada job tem `max_attempts` (5 por padrão). Erro de limite da Meta (429/408) reagenda com **backoff exponencial + jitter**, até 1 hora.
- Esgotou as tentativas → `dead` (dead-letter) com `dead_at` e `error_code`; nada é reenviado.
- Erro 5xx, timeout ou queda do processo no meio do envio → **`unknown`** (`delivery_unconfirmed` / `worker_interrupted`): a mensagem pode ter saído, então o sistema **não reenvia sozinho**. Confira em **WhatsApp → Fila de mensagens**.
- Janela vencida (lembrete com mais de 30 min de atraso), consulta cancelada ou consentimento retirado → `skipped`, sem chamar a Meta.
- O worker publica sinal de vida em `worker_heartbeats`; `/api/ready` fica 503 (`checks.worker=false`) se ele parar com `WHATSAPP_MODE=live`.

## Backup

**Banco gerenciado** — use o backup automático do provedor (Render/Railway/Fly/Neon têm retenção configurável) e teste uma restauração antes de depender dele. Um dump lógico manual:

```bash
pg_dump --no-owner --format=custom "$DATABASE_URL" > aurora-$(date +%F).dump
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" aurora-2026-10-29.dump
```

**Guarde a `DATA_ENCRYPTION_KEY` em cofre separado do banco.** O dump sem ela preserva os dados, mas os tokens da Meta ficam ilegíveis.

## Depois de publicar: checklist de 10 minutos

1. `https://seudominio/api/ready` deve responder `{"ok":true,"checks":{"database":true,"migrations":true,"encryptionKey":true,"worker":true}}`.
2. `https://seudominio/api/health` responde `{"ok":true}`.
3. Acesse `/criar-conta` (se `ALLOW_REGISTRATION=true`) e crie a clínica real; depois feche o cadastro.
4. Em **Profissionais**, cadastre cada profissional e envie o **convite individual** (validade de 48 h).
5. Em **Serviços**, ajuste duração, intervalo e valor.
6. Copie o link público `/agendar/sua-clinica` e faça um pedido de teste com seu próprio WhatsApp.
7. Confirme no painel e verifique a fila em **WhatsApp → Fila de mensagens**.
8. Só então configure a Meta, mude `WHATSAPP_MODE=live` e preencha `META_APP_SECRET`.
9. Confirme que o backup automático do provedor está ativo e que você sabe restaurar.
10. Anote o `APP_VERSION` exibido em `/api/ready` — é como você confere qual versão está no ar.

## Limites desta versão (leia antes de escalar)

- **Escala horizontal não é suportada.** Várias instâncias exigiriam um agendador único para a fila; hoje rode **uma** réplica. O banco já é externo, então o caminho está aberto, mas o worker foi desenhado para um processo.
- **Sem alta disponibilidade própria.** Se o processo cair, o provedor reinicia em segundos; o banco gerenciado cuida da própria HA conforme o plano.
- **Retenção, exclusão e LGPD** precisam de definição da clínica; o texto em `/privacidade` é um ponto de partida, não um parecer jurídico.
- **Envio real de WhatsApp** depende de conta Meta Business, número aprovado, token permanente e três modelos *utility* aprovados.

## O que este pacote já contém

- `dist/` compilado — não é necessário rodar o build no servidor.
- `server/` (API, regras, fila, segurança), `server/migrations/` (esquema versionado) e `server/migrate-cli.js`.
- `Dockerfile`, `docker-compose.yml`, `render.yaml`, `fly.toml`, `.env.example`.
- `tests/` com 64 verificações, incluindo **PostgreSQL real pelo driver `pg`**, migrações e a fila (retry, dead-letter, entrega ambígua).
- Sem `node_modules`, sem banco local, sem chave de criptografia e sem dados de demonstração.
