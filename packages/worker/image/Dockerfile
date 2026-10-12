# MicroVM イメージ。Lambda が MicroVM の基盤イメージ（AL2023）の上でこの Dockerfile を実行し、起動済みの状態をスナップショットにする。
# 前処理用の道具（LibreOffice など）とエージェントが使う Python は、実装ステップ 2 で足す。

FROM public.ecr.aws/lambda/microvms:al2023-minimal

# Node.js（ワーカーと Claude Code）、Bash サンドボックスの依存（bubblewrap・socat）
RUN dnf install -y --setopt=install_weak_deps=0 nodejs24 nodejs24-npm bubblewrap socat \
  && dnf clean all

WORKDIR /opt/worker

# Agent SDK は Claude Code の実行ファイル（linux-arm64 向けの別パッケージ）を起動する作りで、
# esbuild でまとめると実行ファイルを見つけられないため、ここで固定版を入れる（決定12）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.mjs export-credentials.mjs ./
RUN mkdir -p /work/input

EXPOSE 9000
CMD ["node", "/opt/worker/index.mjs"]
