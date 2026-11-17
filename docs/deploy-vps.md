# Deploying on a VPS (with HTTPS)

One small VPS runs everything: 2 vCPU and 4 GB RAM for the server and one bot with API-based
models. The local profile needs a GPU machine instead.

## 1. Install

```bash
git clone https://github.com/lcaresia/OpenMeetings && cd OpenMeetings
cp .env.example .env
```

Edit `.env`: set **`OM_AUTH_TOKEN`** (long random string: `openssl rand -hex 32`),
**`OM_BOT_TOKEN`** (another one), and the API keys of the profile you use.

## 2. Start

```bash
docker compose up -d
docker compose exec server node /app/dist/main.js doctor
```

The server listens on `127.0.0.1:4319` only. Put Caddy in front for HTTPS.

## 3. HTTPS with Caddy

Point a DNS record (for example `meetings.example.com`) to the VPS, then add Caddy to the same
compose project with a `docker-compose.override.yml`:

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

`Caddyfile`:

```
meetings.example.com {
  reverse_proxy server:4319 {
    flush_interval -1
  }
}
```

`flush_interval -1` matters: AG-UI and the OpenAI-compatible endpoint stream with Server-Sent
Events, which must not be buffered. WebSockets (`/bot`, `/capture`) are proxied by Caddy
automatically.

```bash
docker compose up -d caddy
```

Open `https://meetings.example.com`, paste the token once, and send the bot to a meeting.

## 4. Operate

| Task   | Command                                                   |
| ------ | --------------------------------------------------------- |
| Logs   | `docker compose logs -f server bot`                       |
| Update | `git pull && docker compose pull && docker compose up -d` |
| Backup | copy the `om-data` volume (`/data/openmeetings.db`)       |
| Health | `GET /api/health` with the token                          |

## Google account for the bot

Meet refuses some anonymous automated joins. A dedicated Google account helps: log in once
with Playwright on your machine, save its storage state, and mount it:

```bash
npx playwright codegen --save-storage=storageState.json https://meet.google.com
```

then uncomment the `storageState.json` volume of the `bot` service and set
`bot.storageState: /app/storageState.json` in your config. Use an account made for this
purpose, never a personal one: new accounts can be challenged or blocked by Google.
