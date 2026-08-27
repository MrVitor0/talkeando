FROM rust:1.85-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --create-home --uid 10001 talkeando \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/talkeando-server /usr/local/bin/talkeando-server
RUN mkdir -p /var/lib/talkeando/attachments && chown -R talkeando:talkeando /var/lib/talkeando
USER talkeando
ENV ATTACHMENT_STORAGE_PATH=/var/lib/talkeando/attachments
EXPOSE 8080
ENTRYPOINT ["talkeando-server"]
CMD ["serve"]
