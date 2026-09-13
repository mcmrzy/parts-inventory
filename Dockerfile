# 物料管家 · 生产镜像
# 要求 Node ≥22.5（内置 node:sqlite）
FROM node:24-alpine

WORKDIR /app

# 容器内必须监听 0.0.0.0 才能映射到宿主机
ENV HOST=0.0.0.0 \
    PORT=7860 \
    NODE_ENV=production

# 先装依赖（利用层缓存：package 不变时不重复安装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 源码与前端
COPY src ./src
COPY public ./public

# 数据/照片目录（推荐用 volume 挂载持久化）
RUN mkdir -p data photos

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7860/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
