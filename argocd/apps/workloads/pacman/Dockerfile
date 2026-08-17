# Multi-stage build: compile a static Go binary, ship it on a distroless
# base with no shell, package manager, or libc — nothing an attacker could
# use if the container were ever compromised, and nothing to patch either.
# Mirrors argocd/apps/workloads/carplay-api/Dockerfile.
FROM golang:1.23-alpine AS builder

WORKDIR /build

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /pacman-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /pacman-server /pacman-server
COPY src/ /usr/share/pacman/html/

USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/pacman-server"]
