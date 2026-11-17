# Bot worker: Playwright + Chromium. Connects to the server over WebSocket.
# docker build -f docker/bot.Dockerfile -t open-meetings-bot .

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
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @open-meetings/bot build
RUN mkdir -p /out && cp -r apps/bot/dist /out/dist \
  && node docker/prune-package.mjs apps/bot/package.json /out/package.json

# The official image ships Chromium and its system libraries for this exact Playwright version.
FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /app
COPY --from=build /out/package.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /out/dist ./dist
RUN chown -R pwuser:pwuser /app
USER pwuser
ENV NODE_ENV=production OM_SERVER_WS=ws://server:4319/bot
CMD ["node", "/app/dist/main.js"]
