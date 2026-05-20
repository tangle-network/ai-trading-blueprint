# System libraries — anything Rust / Foundry / Python / Node end up
# linking against. Everything cross-platform unless explicitly gated.
{ pkgs, lib }:

[
  pkgs.pkg-config
  pkgs.autoconf
  pkgs.automake
  pkgs.libtool

  # Compilers + linkers (mold is Linux-only and applied below).
  pkgs.clang
  pkgs.libclang.lib
  pkgs.lld
  pkgs.binutils

  # SSL / TLS / crypto primitives.
  pkgs.openssl
  pkgs.openssl.dev
  pkgs.gnutls
  pkgs.libsodium
  pkgs.nettle

  # Math + arbitrary-precision (used by zk, EVM, scientific stacks).
  pkgs.gmp
  pkgs.mpfr
  pkgs.libmpc

  # Compression — every language ecosystem links one of these.
  pkgs.zlib
  pkgs.zlib.dev
  pkgs.bzip2
  pkgs.xz
  pkgs.zstd
  pkgs.lz4
  pkgs.snappy
  pkgs.brotli

  # General C library helpers.
  pkgs.libffi
  pkgs.libxml2
  pkgs.libxslt
  pkgs.expat
  pkgs.libuv
  pkgs.libev
  pkgs.libevent
  pkgs.libgcrypt

  # Networking + HTTP transport libs.
  pkgs.curl
  pkgs.libssh2
  pkgs.c-ares
  pkgs.nghttp2

  # Terminal + I/O.
  pkgs.ncurses
  pkgs.readline
  pkgs.libedit
  pkgs.icu
  pkgs.pcre2

  # Embedded DBs every language binds against.
  pkgs.sqlite
  pkgs.lmdb
  pkgs.rocksdb

  # JSON / serialization C deps.
  pkgs.jansson
  pkgs.libyaml

  # Image / font / 2D primitives so PIL / sharp / image-rs etc. build
  # without compiling from source.
  pkgs.libjpeg
  pkgs.libpng
  pkgs.libtiff
  pkgs.libwebp
  pkgs.giflib
  pkgs.freetype
  pkgs.fontconfig
  pkgs.harfbuzz
  pkgs.cairo
  pkgs.pixman
] ++ lib.optionals pkgs.stdenv.isLinux [
  pkgs.mold
  pkgs.glibc
  pkgs.libcap
  pkgs.systemd.dev
  pkgs.elfutils
  pkgs.dbus
] ++ lib.optionals pkgs.stdenv.isDarwin [
  pkgs.darwin.apple_sdk.frameworks.Security
  pkgs.darwin.apple_sdk.frameworks.SystemConfiguration
  pkgs.darwin.apple_sdk.frameworks.CoreFoundation
  pkgs.darwin.apple_sdk.frameworks.CoreServices
]
