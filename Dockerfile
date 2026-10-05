FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# مجلد البيانات (الجلسات، الرسائل، الوسائط) — اربطه بـ Volume دائم
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
