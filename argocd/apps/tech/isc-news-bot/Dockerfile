FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    HOME=/tmp \
    TMPDIR=/tmp \
    PORT=8080

WORKDIR /app

COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist/src ./dist/src

USER 1000:1000

EXPOSE 8080

ENTRYPOINT ["node", "dist/src/main.js"]
