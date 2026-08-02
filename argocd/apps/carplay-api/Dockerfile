# Multi-stage build: compile a static Go binary, ship it on a distroless
# base with no shell, package manager, or libc — nothing an attacker could
# use if the container were ever compromised, and nothing to patch either.
FROM golang:1.23-alpine AS builder

WORKDIR /build

COPY src/go.mod src/go.sum ./
RUN go mod download

COPY src/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /carplay-api ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /carplay-api /carplay-api

# Overridden by the Deployment's securityContext (runAsUser: 1000) — this is
# just the image-level default if ever run outside that context.
USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/carplay-api"]
