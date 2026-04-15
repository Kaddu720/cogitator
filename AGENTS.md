# AGENTS

## Cogitator flake note

Pi packages (like `pi-web-access`) are integrated through the `packages` field in
the generated `settings.json`, not through explicit `--extension` CLI arguments.

Current working behavior:
- The flake builds the package with `buildNpmPackage`, installs it under
  `$out/share/<package-name>`, and symlinks required peer dependencies.
- The generated `settings.json` includes the package path in its `packages` array.
- Pi's package manager discovers extensions, skills, and commands from the
  package's `package.json` `pi` manifest automatically.
- Extension tools, commands, and skills all load through this single mechanism.

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
