# Go toolchain + the linters / debugger / tools the average Go project
# wants in CI.
{ pkgs, lib }:

with pkgs; [
  go
  gopls
  golangci-lint
  delve
  go-tools
  gotools
  gomodifytags
  gotests
  gofumpt
  golines
  goreleaser
  air
  mockgen
  protoc-gen-go
  protoc-gen-go-grpc
  buf
]
