FROM golang:1.25-alpine3.24@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

ENV CGO_ENABLED=0 GOFLAGS=-trimpath

RUN go install github.com/micromdm/scep/v2/cmd/scepserver@v2.3.0

FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

COPY --from=build /go/bin/scepserver /usr/bin/scepserver

USER 65532:65532

EXPOSE 8080

VOLUME ["/depot"]

ENTRYPOINT ["/usr/bin/scepserver"]
