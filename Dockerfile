FROM rust:1.91-bookworm AS builder

WORKDIR /build

# Install system deps for blueprint SDK (protobuf, libssl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler libprotobuf-dev pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy workspace
COPY . .

# Build release binary
RUN cargo build --release -p trading-blueprint-bin && \
    cp target/release/trading-blueprint-bin /build/trading-blueprint

# Runtime image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 curl docker.io && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/trading-blueprint /usr/local/bin/trading-blueprint

# State directory — mount a volume here
RUN mkdir -p /data/blueprint-state && chmod 700 /data/blueprint-state
ENV BLUEPRINT_STATE_DIR=/data/blueprint-state

EXPOSE 9100 9200

ENTRYPOINT ["trading-blueprint"]
