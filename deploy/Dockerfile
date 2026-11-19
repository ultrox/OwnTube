FROM node:22-bookworm AS web
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apt-get update && apt-get install -y --no-install-recommends elm-compiler && rm -rf /var/lib/apt/lists/*
ENV ELM_BINARY=/usr/bin/elm
WORKDIR /build
COPY apps/backoffice/package.json apps/backoffice/pnpm-lock.yaml ./
# Debian supplies Elm on both amd64 and arm64; skip npm's platform binary installer.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/backoffice/elm.json apps/backoffice/build.mjs ./
COPY apps/backoffice/history history
COPY apps/backoffice/modules modules
COPY apps/backoffice/desk desk
COPY apps/backoffice/shared shared
COPY apps/backoffice/downloads downloads
RUN pnpm build

FROM rust:1.94-bookworm AS rust
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src src
RUN cargo build --release --locked

FROM denoland/deno:bin-2.7.14 AS deno

FROM debian:bookworm-slim
# Home German mix worker: Python, pinned yt-dlp (with its JS challenge solver) and Deno.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.10.26'
COPY --from=deno /deno /usr/local/bin/deno
RUN groupadd --gid 10001 observer && useradd --uid 10001 --gid observer observer && mkdir -p /app/data && chown observer:observer /app/data
WORKDIR /app
COPY --from=rust /build/target/release/youtube-observer /app/youtube-observer
COPY --from=web /build/dist /app/public
COPY scripts/german-matcher.py /app/scripts/german-matcher.py
# Curated rules live in the database; the file only enables the Home feed.
RUN echo '{}' > /app/home-rules.json
USER observer
ENV BIND=0.0.0.0:3210 DATA_DIR=/app/data PUBLIC_DIR=/app/public \
    OWNTUBE_HOME_RULES=/app/home-rules.json \
    OWNTUBE_GERMAN_WORKER=/app/scripts/german-matcher.py \
    YT_DLP=/opt/yt-dlp/bin/yt-dlp
VOLUME ["/app/data"]
EXPOSE 3210
CMD ["/app/youtube-observer"]
