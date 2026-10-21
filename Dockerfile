# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN bun check && LOG_LEVEL=error bun test

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production CONFIG_PATH=/app/config.yaml DATABASE_PATH=/data/nowepay.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir -p /data && chown bun:bun /data
COPY src ./src
USER bun
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "src/index.ts"]
