# Custom n8n image with n8n-nodes-imap baked in, plus whatsapp-web.js + Chromium
# for the workflows that send WhatsApp messages from a Code node.
#
# Offizielles npm-Paket "whatsapp-web.js" (github.com/wwebjs/whatsapp-web.js), nicht
# das aeltere "wwebjs@1.23.1-alpha.7" (Alpha von 04/2024 mit Puppeteer 18, ohne
# Kanal-Unterstuetzung, d. h. ohne @newsletter-IDs).

FROM node:24.20.0-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build/n8n-custom-nodes
RUN npm install n8n-nodes-imap@2.17.1 --omit=dev --legacy-peer-deps

RUN apk add --no-cache --root /chroot --initdb --no-scripts \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      chromium nss freetype harfbuzz ttf-freefont

WORKDIR /build/wwebjs
RUN PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    npm install whatsapp-web.js@1.34.7 qrcode@1.5.4 --omit=dev --legacy-peer-deps

FROM n8nio/n8n:2.38.4

COPY --from=builder --chown=node:node /build/n8n-custom-nodes /opt/n8n-custom-nodes

COPY --from=builder /chroot/usr /usr
COPY --from=builder --chown=node:node /build/wwebjs /opt/wwebjs

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes \
    NODE_PATH=/opt/wwebjs/node_modules \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
