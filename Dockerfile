# Keou open-source edition — multi-stage build
FROM node:20-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:20-slim AS runtime

# curl serves the healthcheck. ffmpeg stamps the watermark into generated video,
# the way sharp already does for images — without it the anonymous studio still
# works, it just serves video unwatermarked and says so in the log. Drop ffmpeg
# here if you do not run the public studio and want a smaller image.
RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg \
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
