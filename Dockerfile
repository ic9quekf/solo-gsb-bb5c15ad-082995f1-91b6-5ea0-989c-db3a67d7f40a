# ---------- 构建阶段：安装依赖并编译前端与后端 ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# 先拷贝依赖清单（含 lock），利用层缓存并保证可复现安装
COPY server/package.json server/package-lock.json server/
COPY client/package.json client/package-lock.json client/
# better-sqlite3 优先使用预编译二进制；不可用时回退源码编译，故预装工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm --prefix server ci \
 && npm --prefix client ci

COPY server/ server/
COPY client/ client/
RUN npm --prefix client run build \
 && npm --prefix server run build

# ---------- 运行阶段：仅生产依赖 + 构建产物 ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY server/package.json server/package-lock.json server/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm --prefix server ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

ENV PORT=8080
ENV DATABASE_PATH=/app/data/continuity.db
# SQLite 数据库文件目录（建表与演示数据均在启动时自动完成）
VOLUME /app/data

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
