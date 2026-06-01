# deepseek-2api

DeepSeek Web Chat to API proxy, compatible with OpenAI and DeepSeek native formats.

This project is mainly designed for **Linux Docker deployment**.

## Quick Start (Linux Docker)

### 1. Clone the repository

`ash
git clone -b codex https://github.com/qing1189/ds42-2026531.git
cd ds42-2026531
`

### 2. Prepare environment file

`ash
cp .env.production.example .env.production
vi .env.production
`

Fill at least one DeepSeek credential:

- DS_TOKEN=your_token
- or DS_EMAIL=your_email + DS_PASSWORD=your_password

### 3. Start with production override

`ash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
`

### 4. Check service status

`ash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
`

### 5. Stop the service

`ash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
`

---

## Default Service Endpoints

- API: http://your-server:3000/
- Admin: http://your-server:3000/admin
- Performance: http://your-server:3000/performance
- OpenAI format: POST /v1/chat/completions
- DeepSeek format: POST /api/v0/chat/completion
- Models: GET /v1/models

---

## Production Configuration

The production override file docker-compose.prod.yml is recommended for Linux deployment.

It does the following:

- uses estart: always
- loads .env.production
- limits container log files (default 3 files, 10MB each)

This is suitable for long-running background services on Linux servers.

---

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| DS_TOKEN | One credential required | DeepSeek login token |
| DS_EMAIL | No | DeepSeek email (used with DS_PASSWORD) |
| DS_PASSWORD | No | DeepSeek password (used with DS_EMAIL) |
| PORT | No | Service port. Default is 3000 |
| API_KEY | No | Optional API key auth. Leave empty to disable |
| LOG_DIR | No | Log directory. Default is /app/logs in Docker |
| HTTP_PROXY / HTTPS_PROXY | No | Optional proxy for outbound requests |

---

## Healthcheck

Docker Compose includes a built-in healthcheck:

- Endpoint: GET http://localhost:3000/
- Interval: 15s
- Timeout: 5s
- Retries: 3
- Start period: 10s

You can inspect the health state with:

`ash
docker inspect --format='{{json .State.Health}}' deepseek-2api
`

---

## Notes

- The recommended deployment environment is Linux + Docker.
- .env.production is mounted read-only; the app reads configuration from environment variables at runtime.
- Logs are mounted into ./logs by default for persistence and easier debugging.
- The project uses package-lock.json for deterministic installs; the Dockerfile defaults to 
pm ci.
