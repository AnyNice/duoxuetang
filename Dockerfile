# 多学堂 Web 版 · Docker 镜像
# 多阶段：构建阶段装全部依赖并构建前端；运行阶段只带服务代码与构建产物。

# ---------- 构建阶段 ----------
FROM node:22-bookworm AS build
WORKDIR /app
# better-sqlite3 若无预编译包需要本地编译，备好工具链
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build
# 只保留生产依赖给运行阶段
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
# 数据目录（数据库 + settings.json）由 compose 挂卷持久化
RUN mkdir -p /app/data
EXPOSE 8080
CMD ["node", "server/index.js"]
