# Core CLI surface. Mix of modern Rust replacements (ripgrep, fd, bat,
# eza, zoxide) and classic GNU coreutils so scripts that hardcode either
# style keep working.
{ pkgs, lib }:

with pkgs; [
  # Shells.
  bash
  zsh
  fish

  # Classic POSIX / GNU.
  coreutils
  gnused
  gnugrep
  gawk
  findutils
  gnutar
  gzip
  xz
  unzip
  zip
  p7zip
  rsync
  patch
  diffutils
  which
  file
  less
  moreutils
  tree
  hexdump

  # VCS.
  git
  git-lfs
  git-crypt
  gh
  glab
  difftastic

  # Network clients.
  curl
  wget
  openssh
  cacert
  rclone
  netcat
  socat
  whois
  dig

  # Data wrangling.
  jq
  yq-go
  miller
  dasel
  fx

  # Modern search / filesystem.
  ripgrep
  fd
  fzf
  bat
  eza
  zoxide
  broot
  dust
  duf

  # System monitoring.
  htop
  btop
  procs
  bottom
  iotop
  iftop
  bandwhich

  # Terminal multiplexer + session.
  tmux
  screen
  zellij

  # Build helpers.
  gnumake
  cmake
  ninja
  meson
  pkg-config
  ccache
  gcc

  # Editor adjacencies.
  neovim
  helix

  # Scratch.
  direnv
  watchexec
  entr
  hyperfine
  parallel

  # Doc / markup.
  pandoc
  asciidoctor
]
