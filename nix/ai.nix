# AI-specific tooling not covered by the Python ML stack. Most LLM
# clients are Python packages (covered in python.nix); this file is for
# CLIs + local-model runtimes + agent frameworks shipped as binaries.
{ pkgs, lib }:

with pkgs; [
  # Local-model runtimes.
  ollama
  llama-cpp

  # Agent / workflow CLIs ship via npm / cargo — we keep node + cargo
  # cached so first-install is fast.
]
