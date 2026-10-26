FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea AS build

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea

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
