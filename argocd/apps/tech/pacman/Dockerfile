FROM golang:1.27-alpine AS builder

WORKDIR /build

COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /pacman-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /pacman-server /pacman-server
COPY src/ /usr/share/pacman/html/

EXPOSE 8080

USER 65532:65532

ENTRYPOINT ["/pacman-server"]
