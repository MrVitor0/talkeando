FROM rust:1.88-bookworm AS chef
RUN cargo install cargo-chef --locked

FROM chef AS planner
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS build
WORKDIR /src
COPY --from=planner /src/recipe.json recipe.json
# This layer changes only when Cargo dependencies change. Source-only deploys
# reuse the expensive compilation of the Rust dependency graph on the VPS.
RUN cargo chef cook --release --locked --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --create-home --uid 10001 tupi \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/tupi-server /usr/local/bin/tupi-server
RUN mkdir -p /var/lib/tupi/attachments && chown -R tupi:tupi /var/lib/tupi
USER tupi
ENV ATTACHMENT_STORAGE_PATH=/var/lib/tupi/attachments
EXPOSE 8080
ENTRYPOINT ["tupi-server"]
CMD ["serve"]
