FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && npm install --global pnpm@10.33.0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
ENV ARGUS_CONFIG=/app/argus.config.yaml
EXPOSE 8788

CMD ["pnpm", "start"]
