FROM golang:1.27-alpine AS builder

WORKDIR /build

COPY src/go.mod ./
RUN go mod download

COPY src/ ./
RUN go test ./... && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /ticket-gate ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

COPY --from=builder /ticket-gate /ticket-gate

USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/ticket-gate"]
