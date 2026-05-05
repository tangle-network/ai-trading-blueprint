# Cargo patches

This workspace keeps only the patches that are needed for local and CI builds.

## `workspace-hack`

`Cargo.toml` patches Blueprint's `workspace-hack` crate to
`patches/workspace-hack`. Blueprint crates in the git dependency graph refer to
this crate, but this repository is not built inside Blueprint's own workspace.
The local empty crate satisfies that generated dependency without checking out
and patching every Blueprint crate to local paths.

Refresh rule: keep this patch while
`cargo tree --workspace --locked --target all -i workspace-hack` shows
Blueprint crates depending on it. Remove it only after Blueprint no longer
exposes `workspace-hack` in this repo's resolved graph.

## No sibling checkout patches

Do not commit default patches to sibling checkouts such as
`../ai-agent-sandbox-blueprint` or `../blueprint`. This repository should build
from the locked git dependencies in `Cargo.lock`, so local, CI, and deploy use
the same dependency commits.

If local development needs a sibling checkout temporarily, use a local-only
override outside the committed workspace files. Verify fixes against the locked
git graph before sending them to CI.

Refresh rule: prefer replacing floating `branch = "main"` git dependencies with
pinned `rev = "..."` dependencies when the upstream API should stop drifting.
