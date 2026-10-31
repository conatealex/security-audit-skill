# syntax=docker/dockerfile:1
# Build: npm ci -> build do front -> poda das dependências de desenvolvimento.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 aurora \
    && useradd --system --uid 10001 --gid aurora --home /app aurora
COPY --from=build --chown=aurora:aurora /app/package.json /app/package-lock.json ./
COPY --from=build --chown=aurora:aurora /app/node_modules ./node_modules
COPY --from=build --chown=aurora:aurora /app/server ./server
COPY --from=build --chown=aurora:aurora /app/dist ./dist
USER aurora
EXPOSE 3000

# /api/ready confirma banco + migrações + chave de criptografia + worker.
# Enquanto o banco não aceitar conexões o processo segue vivo (liveness) mas
# não recebe tráfego. O supervisor reinicia o container se ele travar de vez.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
