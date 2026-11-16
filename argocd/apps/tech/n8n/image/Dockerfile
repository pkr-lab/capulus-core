FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build/n8n-custom-nodes
RUN npm install n8n-nodes-imap@2.17.1 --omit=dev --legacy-peer-deps

RUN apk add --no-cache --root /chroot --initdb --no-scripts \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      chromium nss freetype harfbuzz ttf-freefont

WORKDIR /build/wwebjs
RUN PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    npm install whatsapp-web.js@1.34.7 qrcode@1.5.4 pdfjs-dist@5.4.149 --omit=dev --legacy-peer-deps

FROM n8nio/n8n:3.2.2@sha256:c5d94cb443ff3d7b3abd65927fd8c9af1281f026ebfed9b208cf8d0f6b199a94

COPY --from=builder --chown=node:node /build/n8n-custom-nodes /opt/n8n-custom-nodes

COPY --from=builder /chroot/usr /usr
COPY --from=builder --chown=node:node /build/wwebjs /opt/wwebjs

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes \
    NODE_PATH=/opt/wwebjs/node_modules \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
