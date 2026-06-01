# deepseek-2api

DeepSeek Web Chat 转 API 代理服务，兼容 OpenAI 和 DeepSeek 原生格式。

本项目主要面向 **Linux Docker 部署**。

## 快速开始（Linux Docker）

### 1. 克隆仓库

``bash
git clone -b codex https://github.com/qing1189/ds42-2026531.git
cd ds42-2026531
``r

### 2. 准备环境变量

``bash
cp .env.production.example .env.production
vi .env.production
``r

至少填写一个 DeepSeek 凭据：

- DS_TOKEN=your_token`r
- 或 DS_EMAIL=your_email + DS_PASSWORD=your_password`r

### 3. 使用生产配置启动

``bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
``r

### 4. 查看服务状态

``bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f
``r

### 5. 停止服务

``bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
``r

---

## 默认服务接口

- API：http://your-server:3000/`r
- 管理后台：http://your-server:3000/admin`r
- 性能监控：http://your-server:3000/performance`r
- OpenAI 格式：POST /v1/chat/completions`r
- DeepSeek 格式：POST /api/v0/chat/completion`r
- 模型列表：GET /v1/models`r

---

## 生产部署说明

推荐在 Linux 服务器上使用 docker-compose.prod.yml 进行生产部署。

生产配置默认包含：

- estart: always`r
- 使用 .env.production`r
- 限制容器日志大小（默认 3 份，每份 10MB）

适合长时间运行的后台服务。

---

## 环境变量说明

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| DS_TOKEN | 二选一必填 | DeepSeek 登录 token |
| DS_EMAIL | 否 | DeepSeek 邮箱（需配合 DS_PASSWORD） |
| DS_PASSWORD | 否 | DeepSeek 密码（需配合 DS_EMAIL） |
| PORT | 否 | 服务端口，默认 3000 |
| API_KEY | 否 | 可选 API Key 鉴权，留空则不鉴权 |
| LOG_DIR | 否 | 日志目录，Docker 中默认 /app/logs |
| HTTP_PROXY / HTTPS_PROXY | 否 | 可选代理，用于出口网络请求 |

---

## 健康检查

Docker Compose 默认已配置健康检查：

- 接口：GET http://localhost:3000/`r
- 检测间隔：15s
- 超时时间：5s
- 重试次数：3
- 启动等待：10s

可使用以下命令查看健康状态：

``bash
docker inspect --format='{{json .State.Health}}' deepseek-2api
``r

---

## 备注

- 推荐部署环境为 Linux + Docker。
- .env.production 以只读方式挂载，应用运行时通过环境变量读取配置。
- 默认挂载 ./logs 目录，方便日志持久化和问题排查。
- 项目使用 package-lock.json 固定依赖版本，Dockerfile 默认使用 
pm ci。
