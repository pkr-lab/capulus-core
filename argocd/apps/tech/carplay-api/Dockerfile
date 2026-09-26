FROM golang:1.27-alpine AS builder

WORKDIR /build

COPY src/go.mod src/go.sum ./
RUN go mod download

COPY src/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /carplay-api ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /carplay-api /carplay-api

USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/carplay-api"]
