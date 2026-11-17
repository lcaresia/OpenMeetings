# Server: API, AG-UI, OpenAI-compatible and MCP endpoints, and the built panel.
# docker build -f docker/server.Dockerfile -t open-meetings-server .

FROM node:26-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bot/package.json apps/bot/
COPY apps/extension/package.json apps/extension/
COPY packages/core/package.json packages/core/
COPY packages/config/package.json packages/config/
COPY packages/engines/package.json packages/engines/
COPY packages/tools/package.json packages/tools/
# Browsers belong to the bot image, not here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @open-meetings/web build && pnpm --filter open-meetings build
RUN mkdir -p /out && cp -r apps/server/dist /out/dist \
  && node docker/prune-package.mjs apps/server/package.json /out/package.json

FROM node:26-bookworm-slim
# ffmpeg decodes uploaded recordings.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /out/dist ./dist
COPY examples ./examples
COPY fixtures ./fixtures
COPY docker/server-entrypoint.sh /usr/local/bin/om-entrypoint
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production OM_HOST=0.0.0.0 OM_DB_PATH=/data/openmeetings.db
VOLUME ["/data"]
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4319/api/health',{headers:process.env.OM_AUTH_TOKEN?{authorization:'Bearer '+process.env.OM_AUTH_TOKEN}:{}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["om-entrypoint"]
CMD ["serve"]
