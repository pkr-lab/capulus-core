# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 1000 app && adduser -u 1000 -G app -s /bin/sh -D app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/config && chown -R app:app /app
USER app
EXPOSE 3000
CMD ["node", "src/server.js"]
