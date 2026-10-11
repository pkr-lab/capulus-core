FROM ubuntu:24.04 AS build

ARG DEBIAN_FRONTEND=noninteractive
ARG BARESIP_VERSION=4.12.0
ARG PIPER_VERSION=1.8.0
ARG PIPER_VOICE=de_DE-thorsten-high

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake pkg-config git patch ca-certificates libssl-dev libopus-dev zlib1g-dev python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

COPY patches/ /patches/

RUN git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/re.git /src/re \
 && patch -p1 -d /src/re < /patches/libre-sips-route.patch \
 && git clone --depth 1 --branch "v${BARESIP_VERSION}" https://github.com/baresip/baresip.git /src/baresip \
 && cmake -S /src/re -B /src/re/build -DCMAKE_INSTALL_PREFIX=/opt/baresip -DCMAKE_INSTALL_RPATH=/opt/baresip/lib -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/re/build --parallel \
 && cmake --install /src/re/build \
 && cmake -S /src/baresip -B /src/baresip/build -DCMAKE_INSTALL_PREFIX=/opt/baresip -DCMAKE_PREFIX_PATH=/opt/baresip -DCMAKE_INSTALL_RPATH=/opt/baresip/lib -DCMAKE_BUILD_TYPE=Release -DSTATIC=OFF -DMODULES="stdio;g711;opus;aufile;auresamp;menu;ice;srtp;account" \
 && cmake --build /src/baresip/build --parallel \
 && cmake --install /src/baresip/build

RUN python3 -m venv /opt/piper/venv \
 && /opt/piper/venv/bin/pip install --no-cache-dir "piper-tts==${PIPER_VERSION}" \
 && /opt/piper/venv/bin/python -m piper.download_voices "${PIPER_VOICE}" --download-dir /opt/piper

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 sox libsox-fmt-base libssl3t64 libopus0 zlib1g ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/baresip /opt/baresip
COPY --from=build /opt/piper /opt/piper

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

USER 1000:1000

EXPOSE 9310
