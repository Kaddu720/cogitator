# AGENTS

## Cogitator flake note

Pi packages (like `pi-web-access`) are integrated through the `packages` field in
the generated `settings.json`, not through explicit `--extension` CLI arguments.

Current working behavior:
- Pi core version is tracked via the `pi` flake input (`badlogic/pi-mono` tag/rev)
  and auto-derived from `packages/coding-agent/package.json` in that input.
- The actual build uses the published npm tarball for that version (pre-built
  `dist/`), not a source build from the monorepo.
- When `nix flake update` bumps the `pi` input, the version changes
  automatically but `fetchzip.hash`, `npmDepsHash`, and
  `pi-package-lock.json` must be updated manually.
- `flake.lock` updates are user-managed/manual in this repo; do not edit
  `flake.lock` unless user explicitly asks for it.
- Preferred pattern: every pi extension/package in this repo ships as a package
  root under `$out/share/<package-name>` with a root `package.json`.
- That root `package.json` should include `keywords = ["pi-package"]` and an
  explicit `pi` manifest declaring its extensions, skills, commands/prompts, or
  themes.
- The flake should package resources so the generated `settings.json` can add
  that package-root path to its `packages` array.
- Pi's package manager then discovers resources from the manifest.
- Conventional-directory fallback (for example bare `skills/` without a manifest)
  is compatibility-only and not the preferred pattern for new or updated
  packages in this repo.

If extension tools appear missing:
1. Check the operating mode — plan mode only exposes a curated tool set
   (read-only tools plus web research tools). Switch to `/normal` for full access.
2. Check the model provider — some providers (e.g. Azure/OpenAI) may not expose
   extension tools due to upstream pi tool-schema compatibility. Anthropic models
   work fully.
3. Verify the merged `settings.json` inside the sandbox contains the package path:
   read `/tmp/cogitator-pi-agent/settings.json` from within cogi.
4. Verify the package structure is intact (package.json `pi` manifest, node_modules
   symlinks for peer deps).
