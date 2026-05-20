# Observability + monitoring clients. Daemons stay out — these are the
# CLI / cardinality-check / log-shaping tools.
{ pkgs, lib }:

with pkgs; [
  prometheus
  grafana-loki
  opentelemetry-collector
  vector
  fluent-bit
  jq
]
