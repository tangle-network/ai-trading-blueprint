# LSPs, linters, and formatters for languages not already covered by
# their dedicated nix file. Editor sessions inside the devShell get
# everything resolved without per-machine `:LspInstall` dances.
{ pkgs, lib }:

with pkgs; [
  # Multi-language formatters.
  shellcheck
  shfmt
  treefmt

  # Markdown.
  marksman
  mdsh
  markdownlint-cli

  # Nix.
  nil
  nixfmt-classic
  nix-tree

  # Config / data.
  yaml-language-server
  taplo
  vscode-langservers-extracted

  # DevOps.
  hadolint
  dockfmt
  tflint
]
