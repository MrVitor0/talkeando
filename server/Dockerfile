FROM rust:1.88-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
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
