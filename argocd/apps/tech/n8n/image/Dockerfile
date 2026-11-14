FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build/n8n-custom-nodes
RUN npm install n8n-nodes-imap@2.17.1 --omit=dev --legacy-peer-deps

RUN apk add --no-cache --root /chroot --initdb --no-scripts \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      chromium nss freetype harfbuzz ttf-freefont

WORKDIR /build/wwebjs
RUN PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    npm install whatsapp-web.js@1.34.7 qrcode@1.5.4 pdfjs-dist@5.4.149 --omit=dev --legacy-peer-deps

FROM n8nio/n8n:2.47.7@sha256:b4b90747b81fcda7e76550c0d3aa7f0f64917a1e9573cff40d6834eaf2e0f8ea

COPY --from=builder --chown=node:node /build/n8n-custom-nodes /opt/n8n-custom-nodes

COPY --from=builder /chroot/usr /usr
COPY --from=builder --chown=node:node /build/wwebjs /opt/wwebjs

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes \
    NODE_PATH=/opt/wwebjs/node_modules \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
