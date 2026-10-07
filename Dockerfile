# مرحلة البناء: أدوات ترجمة للحزم الأصلية (better-sqlite3) إن لم يتوفر ثنائي جاهز
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=verbose

# مرحلة التشغيل: صورة خفيفة
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# مجلد البيانات (الجلسات، الرسائل، الوسائط) — اربطه بـ Volume دائم
ENV DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "src/server.js"]
