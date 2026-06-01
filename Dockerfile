# syntax=docker/dockerfile:1

############################
# Stage 1 — dependencies
############################
FROM node:22-alpine AS deps

WORKDIR /app

# Build tools are only needed in case an optional native dependency
# (e.g. ssh2's cpu-features) needs to be compiled. They are NOT carried
# into the final image.
RUN apk add --no-cache python3 make g++

# Install production dependencies only.
COPY package.json package-lock.json ./
RUN npm install --omit=dev && npm cache clean --force

############################
# Stage 2 — runtime
############################
FROM node:22-alpine AS runtime

# Small init process so the container handles signals (SIGTERM/SIGINT) correctly.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_DIR=/app/logs \
    DATA_DIR=/app/data

WORKDIR /app

# Copy installed dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy application source and runtime assets.
COPY package.json package-lock.json ./
COPY src ./src
COPY sha3_wasm_bg.wasm ./sha3_wasm_bg.wasm

# Logs directory (override the hardcoded default via LOG_DIR; mount as a volume to persist).
RUN mkdir -p /app/logs

# Data directory for JSON config persistence (mount as a volume to persist).
RUN mkdir -p /app/data

EXPOSE 3000

# Liveness probe: the server is healthy if it answers HTTP on PORT
# (any status, including 401 when API_KEY is set, means the process is up).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
