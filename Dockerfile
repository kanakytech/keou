# Keou open-source edition — multi-stage build
FROM node:20-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:20-slim AS runtime

# curl for the container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -r keou && useradd -r -g keou -d /app keou

WORKDIR /app

COPY --from=deps --chown=keou:keou /app/node_modules ./node_modules
COPY --chown=keou:keou . .

USER keou

ENV NODE_ENV=production
ENV PORT=3401
ENV EDITION=opensource

EXPOSE 3401

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/health" || exit 1

CMD ["node", "index.js"]
