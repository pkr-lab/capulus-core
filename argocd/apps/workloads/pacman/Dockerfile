# Static site, no build step — just nginx serving pre-vendored assets.
# nginx-unprivileged runs as a non-root user by default and listens on
# 8080, so no extra USER/securityContext wiring is needed here (matches
# the runAsNonRoot posture used elsewhere in this repo, e.g. carplay-api).
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY src/ /usr/share/nginx/html/

EXPOSE 8080
