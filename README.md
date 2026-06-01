# deepseek-2api

DeepSeek Web Chat to API proxy.

本项目主要用于 Linux Docker 部署。

## 快速开始

1. 克隆仓库
   git clone -b codex https://github.com/qing1189/ds42-2026531.git
   cd ds42-2026531

2. 准备环境变量
   cp .env.production.example .env.production
   vi .env.production

   至少填写一个 DeepSeek 凭据：
   - DS_TOKEN=your_token
   - 或 DS_EMAIL + DS_PASSWORD

3. 启动
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

4. 查看日志
   docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

5. 停止
   docker compose -f docker-compose.yml -f docker-compose.prod.yml down

## 默认接口

- API: http://your-server:3000/
- Admin: http://your-server:3000/admin
- Performance: http://your-server:3000/performance
- OpenAI: POST /v1/chat/completions
- DeepSeek: POST /api/v0/chat/completion
- Models: GET /v1/models

## 生产配置

推荐使用 docker-compose.prod.yml，它默认包含：
- restart: always
- 使用 .env.production
- 限制日志大小（默认 3 份，每份 10MB）

## 环境变量

- DS_TOKEN
- DS_EMAIL
- DS_PASSWORD
- PORT
- API_KEY
- LOG_DIR
- HTTP_PROXY / HTTPS_PROXY

## 健康检查

- 接口: GET http://localhost:3000/
- interval: 15s
- timeout: 5s
- retries: 3
- start_period: 10s

## 备注

- 推荐部署环境: Linux + Docker
- .env.production 只读挂载
- 日志目录默认 ./logs
