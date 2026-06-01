# deepseek-网关

把 **DeepSeek 网页版聊天** 反向封装成标准 API 的代理服务。对外同时提供 **OpenAI 兼容格式** 和 **DeepSeek 原生格式** 两套接口，可直接接入 Claude Code、OpenAI SDK、各类 LLM 客户端 / 网关（如 one-api / new-api）。

> 服务基于 Node.js + Express 实现，内置 PoW（工作量证明）求解、多 Token / 多账号池、智能调度、会话复用、排队限流、JSON 持久化、请求日志与性能监控面板。

---

## 功能特性

- **双协议接口**：OpenAI 格式（`/v1/chat/completions`）+ DeepSeek 原生格式（`/api/v0/chat/completion`）。
- **多 Token / 多账号池**：支持配置多个 token 或账号自动登录，按 token 并发上限（默认 2）分配槽位、失效检测、健康检查与容量统计。
- **智能调度器**：基于权重的概率调度 + 冷却机制 + 请求间隔抖动 + 频率限制 + 渐进式恢复 + 时间段策略 + 全局自适应限速。
- **PoW 自动求解**：自动完成 DeepSeek 的 `DeepSeekHashV1` 工作量证明，优先使用 WASM（`sha3_wasm_bg.wasm`），失败回退纯 JS 实现。
- **会话复用**：按「token + 模型类型」缓存会话（TTL 3 天），减少握手开销。
- **排队限流**：所有 token 满载时进入队列（上限 100，30s 超时），含过载告警。
- **JSON 持久化**：所有配置（除端口和面板密码外）自动保存到 `data/config.json`，Docker 映射 `./data` 目录即可实现跨容器持久化与一键迁移。
- **思考内容（reasoning）**：默认以 `reasoning_content` 字段单独输出（兼容 Claude Code / OpenAI 客户端），也可合并为 `<think>...</think>` 标签。
- **视觉模型**：支持多模态图片输入（data URL / 远程 URL 自动上传换取 file_id）。
- **指纹轮换**：按请求数 / 时间自动轮换浏览器指纹，降低风控触发概率。
- **可观测性**：内置管理面板 `/admin`、性能监控 `/performance`、调度器面板 `/scheduler`、API 调试 `/playground`。
- **代理支持**：出口代理（`HTTPS_PROXY`）+ 登录代理（手动 / 携趣短效 API）。


---

## 架构概览

```
              客户端 (OpenAI SDK / Claude Code / 网关)
                              │
                     index.js (Express 入口)
              日志中间件 · API Key 鉴权 · 面板密码鉴权
        ┌─────────────────────┼──────────────────────────┐
        ▼                     ▼                           ▼
 /v1/chat/completions  /api/v0/chat/completion   /admin · /performance
   openai.js             deepseek.js              /playground · /scheduler
        └──────────┬──────────┘
                   ▼
                chat.js  ── 统一聊天流程
        ┌──────────┼───────────┬───────────┐
        ▼          ▼           ▼           ▼
    queue.js    pow.js     session.js   headers.js
                   │                       │
                   ▼                       ▼
   scheduler.js ← auth.js ──────→ persist.js ──→ data/config.json
   (智能调度)     (Token/账号池)    (JSON持久化)
```


| 模块 | 职责 |
|------|------|
| `index.js` | Express 入口、路由、鉴权、启动初始化 |
| `persist.js` | **JSON 持久化核心**：读写 `data/config.json`，所有配置变更统一经此模块落盘 |
| `auth.js` | Token / 账号池：登录刷新、失效检测、并发槽位、健康检查 |
| `access.js` | API Key 集合 + 面板密码 / 会话管理 |
| `scheduler.js` | 智能权重调度器：动态权重、冷却、渐进恢复、时间段策略、全局限速 |
| `chat.js` | 统一聊天流程：取槽 → 解 PoW → 取会话 → 请求 → 解析 SSE |
| `openai.js` / `deepseek.js` | OpenAI 格式适配 / DeepSeek 原生透传 |
| `pow.js` | 解工作量证明（WASM 优先，JS 回退） |
| `session.js` | 会话池缓存与预热、自动删除模式 |
| `headers.js` | 浏览器头模拟、cookie、HIF 校验头、指纹轮换 |
| `proxy.js` | 登录代理管理（手动 / 携趣短效 API） |
| `queue.js` | 满载排队与过载告警 |
| `upload.js` | 视觉模型图片上传 |
| `usage.js` | 按 API Key / 账号的用量统计 |
| `metrics.js` / `logger.js` | 性能指标 / 请求与对话日志 |
| `env_store.js` | `.env` 读改写助手（兼容旧逻辑） |

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

## 环境变量

复制 `.env.example` 为 `.env` 并按需填写：

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否（默认 3000） | 服务监听端口（**仅 .env 配置，不持久化到 JSON**） |
| `PANEL_PASSWORD` | 否 | 管理面板独立密码（**仅 .env 配置，不持久化到 JSON**）；留空则面板无需登录 |
| `DS_TOKEN` | 可选 | 单个 DeepSeek token（首次启动使用，之后通过面板管理） |
| `DS_TOKENS` | 可选 | 多个 token，逗号分隔：`token1,token2` |
| `DS_ACCOUNTS` | 可选 | 账号自动登录：`email1:pass1,email2:pass2` |
| `DS_ACCOUNTS_EXTENDED` | 可选 | 将已有 token 关联到账号：`email:password:token前12位` |
| `API_KEYS` | 否 | 客户端密钥，支持多个，逗号分隔；留空则不鉴权 |
| `API_KEY` | 否 | 兼容旧的单值写法，会与 `API_KEYS` 合并 |
| `DATA_DIR` | 否 | JSON 配置持久化目录（Docker 默认 `/app/data`） |
| `LOG_DIR` | 否 | 日志目录（Docker 默认 `/app/logs`） |
| `AUTO_DELETE` | 否 | 会话自动删除模式：`none`（默认）/ `single` / `all` |
| `MERGE_THINKING` | 否 | `true` 时全局将思考合并进 `content` |
| `HTTPS_PROXY` / `HTTP_PROXY` | 否 | 出口代理地址 |

> ✅ **所有 DeepSeek 认证项都可以留空**：服务会以空令牌池启动，之后在管理面板 `/admin` 添加 token / 账号登录即可，**立即生效（热加载）**，无需重启。


---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 1. 准备配置
cp .env.example .env
# 编辑 .env，设置 PORT（可选）和 PANEL_PASSWORD（推荐）
# DS_TOKEN / DS_ACCOUNTS 等可在此配置首次使用，之后通过面板管理

# 2. 构建并启动
docker compose up -d --build

# 3. 查看日志
docker compose logs -f

# 4. 验证服务
curl http://localhost:3000/v1/models

# 5. 停止
docker compose down

# 6. 更新代码后重建
git pull && docker compose up -d --build
```

**目录映射说明：**

| 宿主机目录 | 容器目录 | 用途 |
|-----------|---------|------|
| `./data` | `/app/data` | JSON 配置持久化（tokens、accounts、API Keys、调度器等） |
| `./logs` | `/app/logs` | 请求日志与对话记录 |

> 修改端口：在 `.env` 中设置 `PORT=8080`，compose 自动映射。


### 方式二：docker run

```bash
# 构建镜像
docker build -t deepseek-2api:latest .

# 运行容器（使用 .env 文件）
docker run -d \
  --name deepseek-2api \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -e LOG_DIR=/app/logs \
  -e DATA_DIR=/app/data \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" \
  deepseek-2api:latest

# 或者直接传入环境变量（不使用 .env 文件）
docker run -d \
  --name deepseek-2api \
  --restart unless-stopped \
  -p 3000:3000 \
  -e PORT=3000 \
  -e PANEL_PASSWORD="your-password" \
  -e LOG_DIR=/app/logs \
  -e DATA_DIR=/app/data \
  -v "$(pwd)/logs:/app/logs" \
  -v "$(pwd)/data:/app/data" \
  deepseek-2api:latest

# 查看日志
docker logs -f deepseek-2api
```


### 方式三：本地 Node 运行

要求 Node.js >= 18（推荐 22）。

```bash
npm ci                     # 安装依赖
cp .env.example .env       # 编辑配置
npm start                  # 启动服务（或 npm run dev 热重载）
```

本地运行时 `DATA_DIR` 默认为项目根目录下的 `data/`，`LOG_DIR` 使用代码内默认路径。

启动后访问 `http://localhost:3000`。

---

## 数据持久化

本项目采用 **JSON 文件持久化** 方案。所有通过 Web 面板或 API 修改的配置自动保存到 `data/config.json`，Docker 通过映射 `./data` 目录实现持久化。

### 持久化范围

| 配置项 | JSON key | 说明 |
|--------|----------|------|
| DeepSeek Tokens | `tokens` | 存活的 token 列表 |
| DeepSeek 账号 | `accounts` | `[{email, password}]` 数组 |
| API Keys | `apiKeys` | API key 字符串列表 |
| 登录代理 | `proxy` | `{manualProxy, xiequApiUrl}` |
| 调度器配置 | `scheduler` | 全部调度器参数（频率、权重、冷却等） |
| 指纹轮换配置 | `fingerprint` | `{ROTATE_AFTER_REQUESTS, ROTATE_AFTER_MS}` |
| 自动删除模式 | `autoDeleteMode` | `none` / `single` / `all` |


### 不持久化（必须通过 `.env` 设置）

| 配置项 | 原因 |
|--------|------|
| `PORT` | 端口属于部署配置，不应随数据迁移 |
| `PANEL_PASSWORD` | 面板密码属于安全凭证，必须显式设置 |

### 加载优先级

```
JSON 持久化 (data/config.json)  >  环境变量 (.env)  >  默认值
```

首次部署时 `config.json` 不存在，系统从 `.env` 读取初始配置；之后面板的所有变更自动保存到 JSON。

### 迁移到新机器

```bash
# 备份
cp -r ./data ./data-backup

# 复制到新机器
scp -r ./data user@new-server:/path/to/project/data

# 新机器只需在 .env 中设置 PORT 和 PANEL_PASSWORD 即可
```

### config.json 结构示例

```json
{
  "tokens": ["eyJhbGci...", "eyJhbGci..."],
  "accounts": [
    { "email": "user@example.com", "password": "xxx" }
  ],
  "apiKeys": ["sk-abc123..."],
  "proxy": {
    "manualProxy": "1.2.3.4:8080",
    "xiequApiUrl": "https://api.xiequ.cn/..."
  },
  "scheduler": {
    "MIN_INTERVAL": 3000,
    "RATE_LIMIT": 10,
    "COOLDOWN_DURATION": 300000
  },
  "fingerprint": {
    "ROTATE_AFTER_REQUESTS": 50,
    "ROTATE_AFTER_MS": 1800000
  },
  "autoDeleteMode": "none"
}
```


---

## 认证与访问控制

本服务有 **两套相互独立** 的鉴权：

| 鉴权 | 作用范围 | 配置方式 | 持久化 |
|------|----------|----------|--------|
| **API Key** | `/v1/*`、`/api/v0/*` | `.env` 初始 + 面板热管理 | JSON 持久化 |
| **面板密码** | 管理面板与监控页 | **仅 `.env`** | 不持久化 |

特性：

- **多 API Key**：面板中新增、删除或自动生成，立即生效 + 自动持久化。
- **独立面板密码**：与 API Key 完全分离，只能通过 `.env` 的 `PANEL_PASSWORD` 设置。
- **账号与令牌热加载**：面板中添加/删除账号和 token，立即生效 + 自动持久化到 JSON。

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
      { "role": "user", "content": "你好" }
    ]
  }'
```

可选请求体字段：

| 字段 | 默认 | 说明 |
|------|------|------|
| `stream` | `false` | 是否流式（SSE）输出 |
| `thinking_enabled` | `true` | 是否开启思考链 |
| `search_enabled` | 非 vision 为 `true` | 是否联网搜索 |
| `merge_thinking` | `false` | `true` 时思考合并进 `<think>` 标签 |
| `max_tokens` | — | 最大输出 token |


### 所有端点

| 方法 / 路径 | 鉴权 | 说明 |
|------|------|------|
| `POST /v1/chat/completions` | API Key | OpenAI 格式聊天补全 |
| `GET /v1/models` | API Key | 列出可用模型 |
| `POST /api/v0/chat/completion` | API Key | DeepSeek 原生格式 |
| `GET /` | 无 | 健康检查 + 状态 |
| `GET /admin` | 无（页面）/ 面板密码（API） | 管理面板 |
| `GET /performance` | 面板密码 | 性能监控面板 |
| `GET /playground` | 无 | API 调试面板 |
| `GET /scheduler` | 无 | 调度器面板 |

---

## 管理面板

访问 `http://localhost:3000/admin`，功能包括：

- **账号管理**：邮箱/手机号 + 密码登录添加，支持删除（热加载）
- **令牌管理**：粘贴 token 添加，支持删除（热加载）
- **会话缓存**：查看、单条删除、清空全部
- **API Key 管理**：增删 / 自动生成（热加载）
- **代理设置**：手动代理 / 携趣 API 配置 / 连通性测试
- **调度器**：查看/修改调度参数、重置权重/冷却
- **指纹轮换**：查看/修改轮换策略
- **用量统计**：按 API Key / 账号统计请求数和 token 消耗
- **日志查看**：实时日志 / 历史日志 / 对话记录

所有面板操作自动持久化到 `data/config.json`，容器重启后配置自动恢复。


---

## docker-compose.yml 参考

```yaml
services:
  deepseek-2api:
    build:
      context: .
      dockerfile: Dockerfile
    image: deepseek-2api:latest
    container_name: deepseek-2api
    restart: unless-stopped
    env_file:
      - .env
    environment:
      LOG_DIR: /app/logs
      DATA_DIR: /app/data
      PORT: 3000
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - ./logs:/app/logs      # 日志持久化
      - ./data:/app/data      # JSON 配置持久化
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(()=>process.exit(0)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

---

## 注意事项

- **安全建议**：生产环境建议同时设置 `API_KEYS`（保护接口）与 `PANEL_PASSWORD`（保护面板），并通过反向代理（Nginx / Caddy）启用 HTTPS。
- **健康检查**：容器健康检查请求 `GET /`，进程能响应即视为存活。
- **日志路径**：Docker 部署通过 `LOG_DIR=/app/logs` 覆盖默认路径并挂载到宿主机 `./logs`。
- **合规**：本项目用于个人学习与研究，请遵守 DeepSeek 的服务条款，自行承担使用风险。


---

## 项目结构

```
.
├── Dockerfile              # 多阶段构建（node:22-alpine）
├── docker-compose.yml      # 一键部署编排
├── .dockerignore
├── .env.example            # 环境变量模板（仅 PORT 和 PANEL_PASSWORD 必须在此配置）
├── sha3_wasm_bg.wasm       # PoW WASM
├── data/                   # [运行时生成] 持久化数据目录（volume 挂载）
│   └── config.json         # 自动生成的 JSON 配置文件
├── logs/                   # [运行时生成] 请求日志目录（volume 挂载）
└── src/
    ├── index.js            # Express 入口、路由、启动初始化
    ├── persist.js          # JSON 持久化核心（读写 data/config.json）
    ├── auth.js             # Token / 账号池、登录刷新、健康检查
    ├── access.js           # API Key 集合 + 面板密码 / 会话
    ├── scheduler.js        # 智能权重调度器
    ├── chat.js             # 统一聊天流程
    ├── openai.js           # OpenAI 格式适配
    ├── deepseek.js         # DeepSeek 原生格式
    ├── pow.js              # 工作量证明求解
    ├── session.js          # 会话池缓存、自动删除模式
    ├── headers.js          # 浏览器头模拟、指纹轮换
    ├── proxy.js            # 登录代理管理
    ├── queue.js            # 排队限流
    ├── upload.js           # 图片上传
    ├── usage.js            # 用量统计
    ├── metrics.js          # 性能指标
    ├── logger.js           # 请求与对话日志
    ├── env_store.js        # .env 读改写助手（兼容旧逻辑）
    ├── admin/              # 管理面板 HTML
    ├── performance/        # 性能监控面板
    ├── playground/         # API 调试面板
    └── scheduler/          # 调度器面板
```
