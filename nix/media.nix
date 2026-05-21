# Media / image / data-plumbing utilities a kitchen-sink profile keeps
# on hand for fixtures and benchmarking.
{ pkgs, lib }:

with pkgs; [
  ffmpeg
  imagemagick
  graphviz
  protobuf
  capnproto
  grpc-tools
  flatbuffers
  optipng
  jpegoptim
]
