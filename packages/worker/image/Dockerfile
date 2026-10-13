# MicroVM イメージ。Lambda が MicroVM の基盤イメージ（AL2023）の上でこの Dockerfile を実行し、起動済みの状態をスナップショットにする。

FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Node.js（ワーカーと Claude Code）、Bash サンドボックスの依存（bubblewrap・socat）、
# 前処理の道具（poppler・ImageMagick・heif-convert・日本語フォント）、エージェントが集計に使う Python
RUN dnf install -y --setopt=install_weak_deps=0 \
    nodejs24 nodejs24-npm bubblewrap socat \
    poppler-utils ImageMagick libheif-tools \
    google-noto-sans-cjk-jp-fonts google-noto-serif-cjk-jp-fonts \
    python3.12 python3.12-pip \
    tar gzip findutils \
    freetype fontconfig libX11 libX11-xcb libXext libXinerama cairo dbus-libs nss nspr cups-libs \
  && dnf clean all

# LibreOffice は AL2023 のリポジトリに無いため、The Document Foundation の aarch64 版 RPM を固定版で入れる。
# 取得したアーカイブは公開されている SHA-256 と照らす。この RPM は依存を宣言しておらず、microdnf はファイルの
# RPM を入れられないので rpm で入れる。headless で要るライブラリは上の dnf で入れ、GUI 統合（gnome・kde）は入れない
ARG LIBREOFFICE_VERSION=26.8.1
ARG LIBREOFFICE_SHA256=29ff4be12d0d9ce000fe3088e4e8ca6e5f88a892e8253457166c32a03d8917de
RUN cd /tmp \
  && curl -fsSL -o lo.tar.gz "https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}/rpm/aarch64/LibreOffice_${LIBREOFFICE_VERSION}_Linux_aarch64_rpm.tar.gz" \
  && echo "${LIBREOFFICE_SHA256}  lo.tar.gz" | sha256sum -c - \
  && tar xzf lo.tar.gz \
  && rpm -i $(ls /tmp/LibreOffice_*/RPMS/*.rpm | grep -v integration) \
  && rm -rf /tmp/lo.tar.gz /tmp/LibreOffice_* \
  && ln -s /opt/libreoffice*/program/soffice /usr/local/bin/soffice

# LibreOffice のプロファイルを作っておく。MicroVM では初回の起動に 30 秒以上かかったため（実測）。
# 場所は前処理のコード（preprocess.ts の LIBREOFFICE_PROFILE_DIR）と揃える
RUN mkdir -p /tmp/warm && printf 'warm-up\n' > /tmp/warm/warm.txt \
  && LANG=C.UTF-8 soffice --headless --norestore -env:UserInstallation=file:///opt/libreoffice-profile \
    --convert-to pdf --outdir /tmp/warm /tmp/warm/warm.txt \
  && test -f /tmp/warm/warm.pdf \
  && rm -rf /tmp/warm

# エージェントがサンドボックス内で使う Python の道具。ワーカーがエージェントの PATH の先頭に /opt/py/bin を置く
RUN python3.12 -m venv /opt/py \
  && /opt/py/bin/pip install --no-cache-dir pandas==3.0.6 openpyxl==3.1.5 duckdb==1.5.6

WORKDIR /opt/worker

# Agent SDK は Claude Code の実行ファイル（linux-arm64 向けの別パッケージ）を起動する作りで、
# esbuild でまとめると実行ファイルを見つけられないため、ここで固定版を入れる（決定12）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.mjs export-credentials.mjs ./
RUN mkdir -p /work /data

EXPOSE 9000
CMD ["node", "/opt/worker/index.mjs"]
