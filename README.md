# deepseek-2api

把 **DeepSeek 网页版聊天** 反向封装成标准 API 的代理服务。对外同时提供 **OpenAI 兼容格式** 和 **DeepSeek 原生格式** 两套接口，可直接接入 Claude Code、OpenAI SDK、各类 LLM 客户端 / 网关（如 one-api / new-api）。

> 服务基于 Node.js + Express 实现，内置 PoW（工作量证明）求解、多 Token / 多账号池、会话复用、排队限流、请求日志与性能监控面板。

---

## 功能特性

- **双协议接口**：OpenAI 格式（`/v1/chat/completions`）+ DeepSeek 原生格式（`/api/v0/chat/completion`）。
- **多 Token / 多账号池**：支持配置多个 token 或账号自动登录，按 token 并发上限（默认 2）分配槽位、失效检测、健康检查与容量统计。
- **PoW 自动求解**：自动完成 DeepSeek 的 `DeepSeekHashV1` 工作量证明，优先使用 WASM（`sha3_wasm_bg.wasm`），失败回退纯 JS 实现。
- **会话复用**：按「token + 模型类型」缓存会话（TTL 3 天），减少握手开销。
- **排队限流**：所有 token 满载时进入队列（上限 100，30s 超时），含过载告警。
- **思考内容（reasoning）**：默认以 `reasoning_content` 字段单独输出（兼容 Claude Code / OpenAI 客户端），也可合并为 `<think>...</think>` 标签。
- **视觉模型**：支持多模态图片输入（data URL / 远程 URL 自动上传换取 file_id）。
- **可观测性**：内置管理面板 `/admin` 与性能监控 `/performance`，请求与完整对话落盘为 JSONL。
- **代理支持**：可通过 `HTTPS_PROXY` / `HTTP_PROXY` 走出口代理。

---

## 架构概览

```
                客户端 (OpenAI SDK / Claude Code / 网关)
                              │
                     index.js (Express 入口)
                  日志中间件 + API_KEY 鉴权中间件
        ┌─────────────────────┼─────────────────────────┐
        ▼                     ▼                          ▼
 /v1/chat/completions  /api/v0/chat/completion     /admin · /performance
   openai.js             deepseek.js                 面板 + 监控
        └──────────┬──────────┘
                   ▼
                chat.js  ── 统一聊天流程
        ┌──────────┼───────────┬───────────┐
        ▼          ▼           ▼           ▼
    queue.js    pow.js     session.js   headers.js
                   │
                   ▼
                auth.js  ── 多 Token / 多账号池
```

| 模块 | 职责 |
|------|------|
| `index.js` | Express 入口、路由、鉴权、启动初始化 |
| `auth.js` | Token / 账号池：登录刷新、失效检测、并发槽位、健康检查 |
| `chat.js` | 统一聊天流程：取槽 → 解 PoW → 取会话 → 请求 → 解析 SSE |
| `openai.js` / `deepseek.js` | OpenAI 格式适配 / DeepSeek 原生透传 |
| `pow.js` | 解工作量证明（WASM 优先，JS 回退） |
| `session.js` | 会话池缓存与预热 |
| `headers.js` | 浏览器头模拟、cookie、HIF 校验头、出口代理 |
| `queue.js` | 满载排队与过载告警 |
| `upload.js` | 视觉模型图片上传 |
| `metrics.js` / `logger.js` | 性能指标 / 请求与对话日志 |

---

## 支持的模型

| 对外模型名（OpenAI `model`） | 后端类型 | 说明 |
|------|------|------|
| `deepseek-v4-flash` | default | 标准对话 |
| `deepseek-v4-pro` | expert | 深度 / 专家模式 |
| `deepseek-v4-vision` | vision | 多模态视觉 |
| `deepseek-v4-flash[1m]` / `deepseek-v4-pro[1m]` / `deepseek-v4-vision[1m]` | 同上 | 长上下文变体 |

通过 `GET /v1/models` 可获取上述列表。

---

## API 接口

### OpenAI 兼容（推荐）

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "deepseek-v4-pro",
    "stream": true,
    "messages": [
      { "role": "user", "content": "用一句话介绍一下你自己" }
    ]
  }'
```

可选请求体字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `stream` | `false` | 是否流式（SSE）输出 |
| `thinking_enabled` | `true` | 是否开启思考链 |
| `search_enabled` | 非 vision 为 `true` | 是否联网搜索 |
| `merge_thinking` | `false` | `true` 时思考合并进 `content` 的 `<think>` 标签，否则走独立 `reasoning_content` |
| `max_tokens` | — | 最大输出 token |

### 其它端点

| 方法 / 路径 | 说明 |
|------|------|
| `GET /v1/models` | 列出可用模型 |
| `POST /api/v0/chat/completion` | DeepSeek 原生格式（透传 SSE） |
| `GET /` | 健康检查 + 池 / 队列状态（启用 `API_KEY` 时需鉴权） |
| `GET /admin` | 管理面板（无需鉴权，便于浏览器访问） |
| `GET /performance` | 性能监控面板 |

---

## 环境变量

复制 `.env.example` 为 `.env` 并按需填写：

| 变量 | 必填 | 说明 |
|------|------|------|
| `DS_TOKEN` | 二选一 | 单个 DeepSeek token |
| `DS_TOKENS` | 二选一 | 多个 token，英文逗号分隔：`token1,token2` |
| `DS_ACCOUNTS` | 可选 | 账号自动登录：`email1:pass1,email2:pass2` |
| `DS_ACCOUNTS_EXTENDED` | 可选 | 将已有 token 关联到账号：`email:password:token前12位` |
| `PORT` | 否（默认 3000） | 服务监听端口 |
| `API_KEY` | 否 | 本服务的 Bearer 鉴权 key，留空则不鉴权 |
| `LOG_DIR` | 否 | 日志目录；**Docker 部署务必设为 `/app/logs`**（已在 compose / Dockerfile 中默认设置） |
| `MERGE_THINKING` | 否 | `true` 时全局将思考合并进 `content` |
| `HTTPS_PROXY` / `HTTP_PROXY` | 否 | 出口代理地址 |

> ⚠️ `DS_TOKEN` / `DS_TOKENS` 与 `DS_ACCOUNTS` 至少配置一项，否则服务启动会报错。

---

## 快速开始

### 方式一：Docker Compose（推荐）

1. 准备配置文件：

   ```bash
   cp .env.example .env
   # 编辑 .env，填入 DS_TOKEN / DS_TOKENS 或 DS_ACCOUNTS，按需设置 API_KEY
   ```

2. 构建并后台启动：

   ```bash
   docker compose up -d --build
   ```

3. 查看日志 / 状态：

   ```bash
   docker compose logs -f
   docker compose ps
   ```

4. 验证：

   ```bash
   curl http://localhost:3000/v1/models
   ```

5. 停止 / 更新：

   ```bash
   docker compose down              # 停止并移除容器
   git pull && docker compose up -d --build   # 更新到最新代码
   ```

- 请求与对话日志会持久化到宿主机的 `./logs` 目录。
- 修改端口：在 `.env` 中设置 `PORT`，compose 会把宿主机 `${PORT}` 映射到容器内 3000。

### 方式二：docker run（不使用 compose）

```bash
# 1. 构建镜像
docker build -t deepseek-2api:latest .

# 2. 运行容器
docker run -d \
  --name deepseek-2api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -e LOG_DIR=/app/logs \
  -v "$(pwd)/logs:/app/logs" \
  deepseek-2api:latest

# 查看日志
docker logs -f deepseek-2api
```

也可以直接用 `-e` 传参（替代 `--env-file`）：

```bash
docker run -d --name deepseek-2api -p 3000:3000 \
  -e DS_TOKENS="token1,token2" \
  -e API_KEY="sk-your-key" \
  -e LOG_DIR=/app/logs \
  -v "$(pwd)/logs:/app/logs" \
  deepseek-2api:latest
```

### 方式三：本地 Node 运行

要求 Node.js ≥ 18（推荐 22，需要全局 `fetch`）。

```bash
npm ci            # 或 npm install
cp .env.example .env   # 填入配置
npm start              # 或 npm run dev（--watch 热重载）
```

启动后访问 `http://localhost:3000`。

---

## 管理与监控

- **管理面板**：`http://localhost:3000/admin`
  - 查看池 / 队列 / 会话 / 日志统计，在线添加 token、账号登录、查看历史对话。
- **性能监控**：`http://localhost:3000/performance`
  - RPM、TTFB（P50/P90）、token 速度、会话命中率与时序图。

---

## 说明与注意事项

- **日志路径**：代码默认日志目录为硬编码的 `/srv/threadripper-backups/newapi/logs`，Docker 部署已通过 `LOG_DIR=/app/logs` 覆盖并挂载到宿主机 `./logs`。
- **Token 持久化**：自动登录 / 新增 token 时，服务会尝试把存活 token 回写到 `.env`。容器内若未挂载可写的 `.env`，回写会被跳过（仅打印告警，不影响运行），重启后以 `env_file` / 环境变量中的配置为准。
- **健康检查**：容器健康检查请求 `GET /`，只要进程能响应 HTTP（即使因 `API_KEY` 返回 401）即视为存活。
- **安全建议**：生产环境务必设置 `API_KEY`，并通过反向代理（Nginx / Caddy）启用 HTTPS；不要把真实 `.env` 提交到仓库（已在 `.gitignore` / `.dockerignore` 中排除）。
- **合规**：本项目用于个人学习与研究，请遵守 DeepSeek 的服务条款，自行承担使用风险。

---

## 项目结构

```
.
├── Dockerfile              # 多阶段构建（node:22-alpine）
├── docker-compose.yml      # 一键部署编排
├── .dockerignore
├── .env.example            # 环境变量模板
├── sha3_wasm_bg.wasm       # PoW WASM
└── src/
    ├── index.js            # 入口
    ├── auth.js             # Token / 账号池
    ├── chat.js             # 聊天流程
    ├── openai.js           # OpenAI 格式
    ├── deepseek.js         # DeepSeek 原生格式
    ├── pow.js              # 工作量证明
    ├── session.js          # 会话池
    ├── headers.js          # 请求头 / 代理
    ├── queue.js            # 排队限流
    ├── upload.js           # 图片上传
    ├── metrics.js          # 性能指标
    ├── logger.js           # 日志
    ├── admin/              # 管理面板
    └── performance/        # 性能监控面板
```
