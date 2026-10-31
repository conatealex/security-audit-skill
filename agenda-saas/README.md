# Aurora · Agenda inteligente

SaaS de agendamento multi-profissional: o cliente escolhe data e horário, o horário fica **bloqueado** até o profissional confirmar ou cancelar, e as mensagens de WhatsApp (confirmação, lembrete de 1 dia e lembrete de 2 horas) entram numa fila persistente enviada pela **API oficial da Meta**.

> Pronta para publicar com **PostgreSQL gerenciado**. O envio real de WhatsApp fica desligado por padrão (`WHATSAPP_MODE=disabled`) e a demonstração usa somente dados fictícios. Guia de publicação: [`DEPLOY.md`](DEPLOY.md).

## Como rodar

```bash
npm install
npm run seed                 # cria a demonstração (apenas dados fictícios)
DEMO_MODE=true npm run dev   # http://localhost:3000
```

No painel de demonstração, o botão **Explorar como administrador** entra como dono da clínica. Também há acesso como profissional e como outra clínica, para conferir o isolamento. O link público da clínica de demonstração é `/agendar/clinica-aurora`.

Sem `DATABASE_URL`, o desenvolvimento usa PGlite local em `./data/aurora`. Com uma variável de conexão, usa **PostgreSQL** de verdade:

```bash
DATABASE_URL="postgres://usuario:senha@localhost:5432/aurora" npm run migrate
DATABASE_URL="postgres://usuario:senha@localhost:5432/aurora" npm run seed
DATABASE_URL="postgres://usuario:senha@localhost:5432/aurora" npm run dev
```

Build e execução de produção (exige `DATABASE_URL`, `DATA_ENCRYPTION_KEY` e `APP_ORIGIN`):

```bash
npm run build
NODE_ENV=production \
DATABASE_URL="postgres://usuario:senha@host:5432/aurora?sslmode=require" \
DATA_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
APP_ORIGIN="https://agenda.suaclinica.com.br" \
npm start
```

Testes (64 verificações: regras, segurança, PostgreSQL real, migrações e fila):

```bash
npm test
npm run test:postgres   # só o caminho PostgreSQL (driver pg + protocolo de rede)
npm run check           # testes + build
```

## Como o fluxo funciona

1. **Pedido do cliente**: nome, WhatsApp com DDD, serviço, profissional, data e horário. O consentimento é obrigatório e a autorização de mensagens é opcional e separada.
2. **Bloqueio imediato**: o pedido nasce como `pending` e reserva o horário — inclusive o intervalo entre atendimentos.
3. **Resposta do profissional**: `pending → confirmed`, `pending → cancelled`, `confirmed → completed` ou `confirmed → cancelled`. Transições inválidas são recusadas.
4. **Confirmação**: ao confirmar, a confirmação entra na fila para envio imediato; os lembretes são agendados para `início − 24h` e `início − 2h`. Lembretes cujo horário já passou não são criados (evita mensagem atrasada em agendamento de última hora).
5. **Cancelamento**: libera o horário, retira da fila os lembretes pendentes e, se houver autorização, enfileira uma mensagem de cancelamento.
6. **Acompanhamento**: o cliente recebe um link individual (`/acompanhar#token`). O token fica guardado apenas como hash; não existe busca por telefone.

## Decisões de segurança implementadas

- **Bloqueio no banco, não só na tela**: `EXCLUDE USING gist` sobre `tstzrange(starts_at, blocked_until)` por profissional. Duas pessoas disputando o mesmo horário resultam em um único pedido, mesmo em requisições concorrentes.
- **Idempotência**: cada envio do formulário carrega uma chave; reenvio pela rede não duplica o pedido. A mesma chave com conteúdo diferente é rejeitada.
- **Isolamento por clínica**: toda consulta filtra `tenant_id`; profissional só vê a própria agenda; configuração de WhatsApp e auditoria são exclusivas do administrador.
- **Autenticação**: senha com `scrypt`, sessão em cookie `HttpOnly`/`SameSite=Lax` (e `Secure` + prefixo `__Host-` em produção), token de sessão guardado como hash, validade de 8 horas, CSRF obrigatório em toda escrita.
- **Convites individuais**: o profissional convidado cria o próprio acesso por link de uso único com validade de 48 horas.
- **Token da Meta**: cifrado com AES-256-GCM usando `DATA_ENCRYPTION_KEY`; nunca é devolvido ao navegador.
- **Webhook**: assinatura HMAC SHA-256 verificada antes de qualquer processamento.
- **Fila à prova de falha**: `FOR UPDATE SKIP LOCKED` garante que dois workers não pegam o mesmo job. Cada job tem `max_attempts` (5); 429/408 voltam para a fila com **backoff exponencial + jitter** (até 1 h) e, esgotadas as tentativas, viram `dead` (dead-letter). Erro 5xx, timeout ou processo interrompido no meio do envio viram `unknown` — **nunca** reenvio cego. Lembrete atrasado, consulta cancelada ou consentimento retirado viram `skipped` sem chamar a Meta.
- **Migrações versionadas**: `server/migrations/` aplicado sob `pg_advisory_lock`, com checksum SHA-256 por arquivo e DDL + registro na mesma transação. Se um arquivo já aplicado for editado, o servidor **não inicia** (evita divergência silenciosa entre ambientes).
- **Prontidão separada da vivacidade**: `/api/health` diz que o processo responde; `/api/ready` confirma banco, migrações, chave e worker. Queda de banco durante uma requisição vira 503 `DATABASE_UNAVAILABLE`, não 500.
- **Banco resiliente**: pool `pg` com `statement_timeout`, retry exponencial na conexão inicial, reconexão automática e encerramento gracioso (SIGTERM aguarda o worker e o pool).
- **Logs estruturados**: uma linha JSON por evento, com `requestId` por requisição; o log de acesso não grava query string. Nenhum dado clínico vai para o log.
- **Consentimento vivo**: revogar a autorização retira mensagens pendentes e impede novas; a checagem também ocorre no momento do envio.
- **Limites**: teto global por IP, limites de banco para login, reservas, consulta por link e convites.
- **Cabeçalhos**: CSP restritiva sem `unsafe-inline` em scripts, `frame-ancestors 'none'`, `no-store` na API, HSTS.
- **Dados sensíveis**: as mensagens carregam apenas nome, profissional, data, horário e clínica — nunca o motivo clínico.

## WhatsApp: o que falta para enviar de verdade

1. Conta no Meta Business com número aprovado para a WhatsApp Business Platform.
2. Token permanente e `phone_number_id` (o ID do número, não o telefone).
3. Três modelos aprovados na categoria *utility*, com a mesma ordem de variáveis: `{{1}}` nome do cliente, `{{2}}` profissional, `{{3}}` data, `{{4}}` horário, `{{5}}` clínica.
4. Servidor com `WHATSAPP_MODE=live`, `META_APP_SECRET` e `META_WEBHOOK_VERIFY_TOKEN`; webhook apontando para `/api/webhooks/meta`.
5. Preencher em **WhatsApp → Conexão e modelos** o ID, o token, os nomes dos modelos e o idioma, e marcar a autorização de envio.

Limite conhecido: `graph.facebook.com` precisa ser acessível pelo servidor. Nesta sandbox o acesso externo é restrito, portanto o envio real não foi exercitado — apenas a construção do payload, a assinatura do webhook e a máquina de estados da fila foram testadas.

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão do PostgreSQL — **obrigatória em produção** |
| `DATABASE_PATH` | Banco local PGlite, só quando não há `DATABASE_URL` (padrão `./data/aurora`) |
| `DB_POOL_MAX` / `DB_CONNECT_RETRIES` / `DB_STATEMENT_TIMEOUT_MS` | Ajustes do pool (10 / 15 / 30000) |
| `MIGRATE_ON_START` | `false` deixa a migração para `npm run migrate` |
| `DATA_ENCRYPTION_KEY` | Chave de 32 bytes em base64 — **obrigatória em produção** |
| `WHATSAPP_MODE` | `disabled` (padrão) ou `live` |
| `META_APP_SECRET` | Segredo do app Meta, valida a assinatura do webhook |
| `META_WEBHOOK_VERIFY_TOKEN` | Token da verificação do webhook |
| `META_GRAPH_VERSION` | Versão da Graph API (padrão `v25.0`) |
| `DEMO_MODE` | `true` cria dados fictícios e habilita o acesso de demonstração |
| `ALLOW_REGISTRATION` | `false` desativa o cadastro público de clínicas |
| `APP_ORIGIN` | Origem permitida quando há proxy na frente — **obrigatória em produção** |
| `WORKER_MAX_ATTEMPTS` / `WORKER_INTERVAL_MS` / `WORKER_STALE_MS` | Limite de tentativas (5), ciclo do worker (15 s) e tempo até considerar um envio interrompido (120 s) |
| `LOG_LEVEL` | `info` (padrão), `warn`, `error`, `debug`; em testes o padrão é silencioso |
| `PORT` | Porta do servidor (padrão 3000) |

## "Não foi possível conectar" ao criar conta

Se a tela de cadastro abre mas o botão falha, quase sempre o site foi publicado em um serviço **estático** (Netlify, Vercel sem funções, GitHub Pages): as telas vêm do `dist/`, mas `/api/*` não existe e o servidor devolve a própria página HTML. O app detecta isso e mostra a faixa *"A API deste sistema não está respondendo neste endereço"*. Confira:

```bash
curl -i -X POST https://SEU-SITE/api/auth/register -H 'Content-Type: application/json' -d '{}'
```

`Content-Type: text/html` confirma o problema. Publicação correta em [`DEPLOY.md`](DEPLOY.md) (Render com `render.yaml`, Railway, Fly.io, VPS com `docker-compose.yml`).

## Antes de usar dados reais

- Usar o PostgreSQL gerenciado com backup automático e **restauração testada** (ver `DEPLOY.md`); PGlite é apenas atalho local.
- Servir apenas por HTTPS, com proxy reverso e cabeçalhos de segurança preservados.
- Definir prazo de retenção, rotina de exclusão, encarregado de dados e contrato com operadores (LGPD). O aviso em `/privacidade` é um texto-base, não um parecer jurídico.
- Ligar os logs JSON ao coletor do provedor e alertar quando `/api/ready` ficar 503, quando houver mensagens `unknown`/`dead` na fila ou picos de 429.
- Revisar o limite por IP quando houver mais de uma instância (passar a usar armazenamento compartilhado).

## Estrutura

```
server/app.js        rotas HTTP, validação, limites e tratamento de erros
server/domain.js     regras de agenda, reserva transacional e decisões
server/whatsapp.js       fila confiável, envio pela Graph API, worker e webhook
server/security.js       senha, sessão, CSRF, criptografia e limites
server/db.js             pool PostgreSQL com retry, PGlite local e helpers
server/migrate.js        migrações sob trava, com checksum
server/migrations/       esquema versionado (0001 baseline, 0002 confiabilidade)
server/logger.js         log JSON estruturado e log de acesso
server/index.js          boot, validação de ambiente, worker e shutdown gracioso
src/App.jsx              painel, agenda pública, acompanhamento e privacidade
tests/agenda.test.js     bloqueio, isolamento, permissões
tests/postgres.test.js   driver pg contra PostgreSQL real
tests/queue.test.js      retry, dead-letter, entrega ambígua, recuperação
tests/migrations.test.js ordem, idempotência e detecção de divergência
```
