FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ ripgrep curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.18.34 && node /usr/local/lib/node_modules/opencode-ai/postinstall.mjs && opencode --version
RUN mkdir -p /home/node/.config /home/node/.local/share /home/node/.cache && chown -R node:node /home/node
ENV XDG_CONFIG_HOME=/home/node/.config XDG_DATA_HOME=/home/node/.local/share XDG_CACHE_HOME=/home/node/.cache
WORKDIR /workspace
USER node
CMD ["node", "-e", "setInterval(() => {}, 60000)"]
