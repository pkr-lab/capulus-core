FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build/n8n-custom-nodes
RUN npm install n8n-nodes-imap@2.17.1 --omit=dev --legacy-peer-deps

RUN apk add --no-cache --root /chroot --initdb --no-scripts \
      --keys-dir /etc/apk/keys --repositories-file /etc/apk/repositories \
      chromium nss freetype harfbuzz ttf-freefont

WORKDIR /build/wwebjs
RUN PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    npm install whatsapp-web.js@1.34.7 qrcode@1.5.4 pdfjs-dist@5.4.149 --omit=dev --legacy-peer-deps

FROM n8nio/n8n:2.48.4@sha256:63bdcfdea7e0d21152a7ad8f62e6622658c5eae3835e7515dbd9b610cdb76111

COPY --from=builder --chown=node:node /build/n8n-custom-nodes /opt/n8n-custom-nodes

COPY --from=builder /chroot/usr /usr
COPY --from=builder --chown=node:node /build/wwebjs /opt/wwebjs

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes \
    NODE_PATH=/opt/wwebjs/node_modules \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
