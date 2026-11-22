# Tracewell review deployment: web app + API in one container. PostgreSQL runs separately (see deploy/docker-compose.yml).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY db ./db
COPY src ./src
RUN npx vite build --logLevel warn
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
EXPOSE 3001
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["npx", "tsx", "src/server/index.ts"]
