# Custom n8n image with n8n-nodes-imap baked in.
#
# n8n-nodes-imap itself has no native deps (imapflow/mailparser/nodemailer are
# pure JS). Its peerDependency "n8n-workflow": "*" lets npm auto-install the
# newest n8n-workflow, which pulls in @n8n/expression-runtime -> isolated-vm
# (hard dependency, needs node-gyp + Python + a C/C++ toolchain to compile).
# --legacy-peer-deps stops npm from auto-installing that peer at all; the
# toolchain in this builder stage stays only as a fallback in case a future
# release of the node picks up a real native dependency.
#
# The installed package is placed outside ~/.n8n on purpose: n8n only scans
# ~/.n8n/nodes/node_modules for arbitrary n8n-nodes-* packages, and that path
# is the PVC mount — anything baked into the image there would be hidden by
# the volume at runtime. N8N_CUSTOM_EXTENSIONS points n8n at an independent
# directory instead, so it survives PVC mounts and pod restarts alike.

FROM node:20.17.0-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /build/n8n-custom-nodes
RUN npm install n8n-nodes-imap@2.17.1 --omit=dev --legacy-peer-deps

FROM n8nio/n8n:2.36.8

COPY --from=builder --chown=node:node /build/n8n-custom-nodes /opt/n8n-custom-nodes

ENV N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom-nodes
