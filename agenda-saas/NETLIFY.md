# Publicar na Netlify (com banco de dados)

A Netlify hospeda o site **e** roda a API em Functions. O que ela não fornece é o banco: a Aurora precisa de um PostgreSQL — o mais rápido e gratuito é o **Neon** (neon.tech, login com GitHub, sem cartão).

> **Somente arrastar a pasta `dist/` não funciona.** Isso publica as telas e deixa a API inexistente: o botão *Criar meu espaço* falha e o app mostra a faixa vermelha *"A API deste sistema não está respondendo neste endereço"*. Para criar contas é preciso dos três passos abaixo.

---

## Passo 1 — Criar o banco (5 minutos, grátis)

1. Acesse **https://neon.tech** e entre com o GitHub.
2. **Create project** → região **AWS South America (São Paulo)** se aparecer; nome `aurora`.
3. Copie a **Connection string** (botão *Connect*). Ela se parece com:
   ```
   postgresql://neondb_owner:AbC123@ep-xyz-123456.sa-east-1.aws.neon.tech/aurora?sslmode=require
   ```
   Use a opção **Pooled connection** (o host tem `-pooler`): em serverless cada requisição pode abrir conexão nova, e o pool evita estourar o limite do banco.

Não é preciso criar tabelas: a aplicação aplica as migrações sozinha na primeira chamada (com trava de banco, então duas requisições simultâneas não brigam).

## Passo 2 — Publicar o site

**Opção A — arrastar a pasta do projeto (mais rápido)**

1. Descompacte `aurora-agenda-netlify-v1.3.0.zip`.
2. Entre em **https://app.netlify.com** (logado) e arraste a **pasta** `aurora-agenda-saas` para **Add new site → Deploy manually**.
3. Logado, a Netlify detecta o projeto e roda o build (`npm run build`) usando o `netlify.toml` — inclusive as Functions.
4. Se o resultado for só estático (sem Functions), use a Opção B.

**Opção B — Netlify CLI (garantida, também sem Git)**

```bash
npm install -g netlify-cli
cd aurora-agenda-saas
netlify login
netlify init            # cria o site, aceite o build do netlify.toml
netlify deploy --prod   # empacota as Functions e publica
```

**Opção C — por Git**

Suba o repositório (o arquivo `aurora-agenda-repo.bundle` acompanha o pacote), then em **Netlify → Add new site → Import an existing project → GitHub**. O `netlify.toml` já define build, publish e Functions.

## Passo 3 — Variáveis de ambiente (sem elas a API responde 503)

Em **Site configuration → Environment variables**, adicione:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | a string do Neon do Passo 1 (**com** `?sslmode=require`) |
| `DATA_ENCRYPTION_KEY` | 32 bytes em base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `APP_ORIGIN` | `https://SEU-SITE.netlify.app` (sem barra no fim) |
| `ALLOW_REGISTRATION` | `true` para abrir o cadastro; mude para `false` depois de criar a conta da clínica |
| `WHATSAPP_MODE` | `disabled` (mude para `live` só com a Meta configurada) |
| `SMTP_URL` / `MAIL_FROM` | opcionais; habilitam o e-mail de "esqueci minha senha" |
| `DB_POOL_MAX` | `3` (o padrão do servidor é 10; em serverless, menos conexões por instância é melhor) |

Depois de salvar: **Deploys → Trigger deploy → Clear cache and deploy site**.

## Conferir se funcionou

```bash
curl -s https://SEU-SITE.netlify.app/api/ready
```

- `{"ok":true,"checks":{"database":true,"migrations":true,...}}` → tudo pronto, crie a conta em `/criar-conta`.
- `503` com `"code":"DATABASE_NOT_CONFIGURED"` → falta `DATABASE_URL` ou o deploy precisa ser refeito depois de salvar a variável.
- `text/html` (a própria página) → as Functions não subiram: refaça pelo Passo 2, opção B.

## O que muda em relação ao servidor dedicado

| Recurso | Servidor (Render/Fly/VPS) | Netlify Functions |
| --- | --- | --- |
| Cadastro, login, agenda, bloqueio de horário | ✅ | ✅ igual |
| Fila de WhatsApp | worker contínuo no processo | **agendada** (`netlify/functions/worker.mjs`, a cada 10 min) |
| Início do processamento da fila | no instante agendado | até 10 minutos de atraso |
| Limite por requisição | 15 min de janela normal | função tem tempo limite; operações são curtas por desenho |
| PGlite local (`DATABASE_PATH`) | disponível | **não disponível** — Netlify não tem disco persistente |

Ou seja: a Netlify funciona para o uso normal da clínica, mas a fila de mensagens deixa de ser instantânea. Se a prioridade for lembrete no minuto certo, use Render/Fly/VPS com o `Dockerfile` — os dois caminhos usam o mesmo código e o mesmo banco.

## Problemas comuns

- **`DATABASE_UNAVAILABLE`** logo após salvar `DATABASE_URL`: a string está sem `?sslmode=require` ou é do host direto (sem `-pooler`).
- **Sessão não persiste**: `APP_ORIGIN` precisa ser exatamente o domínio publicado (com `https://`).
- **`/api/*` devolve HTML**: as Functions não foram publicadas; use `netlify deploy --prod`.
- **Cota de Functions**: o plano gratuito tem limite mensal de invocações; um consultório pequeno fica muito longe dele.
