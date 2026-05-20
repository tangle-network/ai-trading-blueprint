# Database + cache clients. Servers themselves bring their own daemon;
# in CI we mostly need the client side for tests + migrations.
{ pkgs, lib }:

with pkgs; [
  # Relational.
  postgresql
  mariadb-client
  sqlite
  sqlite-interactive
  duckdb

  # Migrations.
  flyway
  dbmate
  sqlx-cli

  # Key/value + cache.
  redis

  # Document / NoSQL.
  mongodb-tools

  # Search.
  meilisearch

  # ORMs / DB tools.
  pgcli
  litecli
  mycli
]
