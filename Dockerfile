# Third way to run the proxy: Docker Desktop, when there is no Node.js on the
# host and you would rather not install the VS Code extension.
#
#   docker build -t gitpod-egress-proxy .
#   docker run --rm -p 127.0.0.1:8899:8899 gitpod-egress-proxy
#
# Publishing to 127.0.0.1 keeps the proxy off your LAN. The container binds
# 0.0.0.0 because that is the only way Docker can forward into it — that
# address is the container's own interface, not your laptop's.

FROM node:22-alpine

WORKDIR /app

# No dependency install step: the proxy uses only Node core modules.
COPY package.json ./
COPY server.js ./
COPY src ./src

RUN addgroup -S proxy && adduser -S proxy -G proxy
USER proxy

ENV PROXY_HOST=0.0.0.0 \
    PROXY_PORT=8899 \
    PROXY_ALLOW_UNAUTHENTICATED_REMOTE=true

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PROXY_PORT||8899)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "server.js"]
