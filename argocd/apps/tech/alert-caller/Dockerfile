FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac AS build

ARG DEBIAN_FRONTEND=noninteractive
ARG BARESIP_VERSION=4.12.0
ARG BARESIP_RE_SHA=65555dad439de9d6a81b3ee6092b9c096585249b
ARG BARESIP_SHA=9cfab81550acc4bd38d6580d79b45cc6eea65cd6
ARG PIPER_VOICE=de_DE-thorsten-high

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake pkg-config git patch ca-certificates libssl-dev libopus-dev zlib1g-dev python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

COPY patches/ /patches/
COPY requirements.txt /tmp/requirements.txt

RUN git init -q /src/re \
 && git -C /src/re fetch -q --depth 1 https://github.com/baresip/re.git "${BARESIP_RE_SHA}" \
 && git -C /src/re checkout -q FETCH_HEAD \
 && for patch_file in /patches/libre-*.patch; do patch -p1 -d /src/re < "$patch_file" || exit 1; done \
 && git init -q /src/baresip \
 && git -C /src/baresip fetch -q --depth 1 https://github.com/baresip/baresip.git "${BARESIP_SHA}" \
 && git -C /src/baresip checkout -q FETCH_HEAD \
 && for patch_file in /patches/baresip-*.patch; do patch -p1 -d /src/baresip < "$patch_file" || exit 1; done \
 && cmake -S /src/re -B /src/re/build -DCMAKE_INSTALL_PREFIX=/opt/baresip -DCMAKE_INSTALL_RPATH=/opt/baresip/lib -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /src/re/build --parallel \
 && cmake --install /src/re/build \
 && cmake -S /src/baresip -B /src/baresip/build -DCMAKE_INSTALL_PREFIX=/opt/baresip -DCMAKE_PREFIX_PATH=/opt/baresip -DCMAKE_INSTALL_RPATH=/opt/baresip/lib -DCMAKE_BUILD_TYPE=Release -DSTATIC=OFF -DMODULES="stdio;g711;opus;aufile;auresamp;menu;ice;srtp;account" \
 && cmake --build /src/baresip/build --parallel \
 && cmake --install /src/baresip/build

RUN python3 -m venv /opt/piper/venv \
 && /opt/piper/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
 && /opt/piper/venv/bin/python -m piper.download_voices "${PIPER_VOICE}" --download-dir /opt/piper

FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

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
