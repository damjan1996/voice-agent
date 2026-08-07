FROM node:22-alpine

# tini fängt SIGTERM sauber ab, damit "docker compose down" nicht zehn
# Sekunden auf den Timeout wartet.
RUN apk add --no-cache tini

WORKDIR /app

# Erst die Manifeste, dann der Quelltext — so bleibt die npm-Schicht im
# Build-Cache, solange sich die Abhängigkeiten nicht ändern.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3010
EXPOSE 3010

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
