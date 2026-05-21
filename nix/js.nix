# JavaScript / TypeScript / frontend toolchain. Multiple runtimes
# (node, bun, deno) + the bundlers/build tools any UI project picks
# from. Framework CLIs (`@angular/cli`, `@vue/cli`, `@nestjs/cli`,
# `@ionic/cli`, `vercel`, `netlify-cli`, `wrangler`) ship via npm and
# install in seconds against the cached runtime — we don't try to pin
# them in nixpkgs where availability is spotty.
{ pkgs, lib }:

with pkgs; [
  # Runtimes.
  nodejs_22
  bun
  deno

  # Package managers.
  nodePackages.pnpm
  nodePackages.npm
  nodePackages.yarn
  corepack_22

  # Language + LSP.
  nodePackages.typescript
  nodePackages.typescript-language-server
  nodePackages.ts-node

  # Linters / formatters.
  nodePackages.prettier
  nodePackages.eslint
  biome
  dprint

  # Bundlers / build.
  esbuild

  # Styling.
  tailwindcss
  sass

  # Test runners.
  playwright-driver
  cypress

  # Long-running dev utilities.
  nodePackages.serve
  nodePackages.http-server
  nodePackages.nodemon
  nodePackages.pm2
  nodePackages.concurrently
]
