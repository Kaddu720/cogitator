# cogitator

`pi` launcher with process isolation provided by [Gondolin](https://github.com/earendil-works/gondolin) (a local QEMU micro-VM), plus a bundled workflow-mode extension for project-aware sessions.

Isolation is no longer done by wrapping `pi` in an OS sandbox. Instead, `cogi` runs `pi` directly on the host and registers the Gondolin pi extension, which routes `pi`'s `read`/`write`/`edit`/`bash` tools into a micro-VM with the workspace mounted at `/workspace`. Gondolin runs on both Linux and macOS (QEMU backend).

## Documentation

Detailed reference docs live in `docs/`:

- [Architecture](docs/architecture.md) — module map, import rules, runtime state, directory boundaries, isolation model
- [Approval Flow](docs/approval-flow.md) — proposal lifecycle, per-change approval, sequence gating, mode interactions
- [Project Model](docs/project-model.md) — markdown-first project states, INDEX.md selection, artifacts, artifacts-only shutdown checkpoints
- [Mode System](docs/mode-system.md) — available modes (plan, normal, readonly, creative), descriptors, write policies, tool allowlists
- [Testing](docs/testing.md) — running unit tests, test structure, coverage targets

## What this flake provides

- `cogi`, a host launcher that runs `pi` with the Gondolin micro-VM extension registered for process isolation
- `pi` built from `@earendil-works/pi-coding-agent` (the upstream pi), run on `nodejs_24` (Gondolin requires Node ≥ 23.6)
- `qemu` and the other flake-provided runtime tools (`git`, `gh`, `ffmpeg`, `yt-dlp`, `node`, `python`) — on Linux, `qemu` is included in the runtime path; on macOS, install it separately via `brew install qemu`
- bundled pi packages registered in the agent `settings.json`: `pi-web-access`, the `pi-mcp-adapter` (MCP bridge), the `ponytail` skill, and a cogitator `new-project` skill
- an overlay exposing:
  - `pkgs.cogitator`
- a bundled extension that adds:
  - `/project`
  - `/project-status`
  - `/new-project`
  - `/plan`
  - `/readonly`
  - `/normal`
  - `/creative`
  - `/weekly-summary`
- startup project selection at pi startup
- a transactional approval gate for file mutations based on your proposal workflow
- plan mode that keeps repo/code work read-only while still allowing project state + artifact updates
- explicit blocking of the `sops` command
- secret handling that stages provider API keys into the per-run agent dir and registers providers in-memory (keys are not exported into the shell environment)
- a `nix run .#test` app and `nix develop` shell that run the extension unit tests with the pi packages available

## Isolation model

Process isolation is provided by **Gondolin**, a local QEMU micro-VM, wired in as a `pi` extension:

- `cogi` runs `pi` directly on the host — there is no `bubblewrap` or Seatbelt wrapper.
- The Gondolin extension overrides `pi`'s `read`/`write`/`edit`/`bash` tools (and `!` commands) so they execute inside the micro-VM, with the workspace mounted read-write at `/workspace`.
- It boots on `session_start`; guest images (~200 MB) are fetched and cached on first use, so the first run needs network and may be slow.
- Works on Linux and macOS via the QEMU backend. On Linux, `qemu` is included in the flake runtime path and KVM acceleration is used when available. On macOS, `qemu` must be installed separately via `brew install qemu` — nixpkgs QEMU is compiled on the build farm against an older macOS SDK and fails HVF assertions on newer macOS releases.
- Gondolin updates independently via `nix flake update gondolin` (it is pinned to a release tag; bump the tag and the package hashes to upgrade).

## Project model (markdown-first)

Cogitator reads projects from a flat directory of markdown state files — there is no
`project.json` and no central control root for project records. See
[docs/project-model.md](docs/project-model.md) for the full model.

Default project states directory (override with `COGITATOR_PROJECT_STATES_DIR` or
`cogi --project-states-dir PATH`):

```text
~/Projects/projectStates/
  INDEX.md                 # curated index: names, statuses, ordering, meta-projects
  ARCHIVE.md               # completed projects (not offered for selection)
  <project-slug>.md        # one markdown state file per project (the source of truth)
  artifacts/
    <project-slug>/
      latest-shutdown.md   # rolling session checkpoint (written by cogitator)
```

- Each `*.md` (except `INDEX.md`/`ARCHIVE.md`) is a project; its id is the filename slug.
- These files are typically Jira-synced and owned by you; cogitator reads them and
  never injects its own blocks into them.

The **control root** (`~/.local/share/cogitator`, set with `--control-root`) now only
holds cogitator runtime state — persistent `sessions/` and a `.gitignore`. `cogi`
creates it and the `.gitignore` automatically if missing.

> Note: the `cogitator-init-project` helper predates this model (it scaffolds the old
> `project.json` layout, which is now ignored). Prefer `/new-project`.

## Startup behavior

When pi starts:

- it scans the project states directory and parses `INDEX.md` for names, statuses, and ordering
- it prompts you to choose a project (INDEX order first; archived hidden)
- the selected project's state file is loaded into agent context before turns

The selected project (its slug) is persisted in the pi session, so resume/tree
navigation restores it. Preselect non-interactively with `--project-id <slug>`.

Config/runtime separation:

- `.config/cogitator/resources/prompts/` — shared prompt fragments, versioned with the config.
- `~/.pi/agent` — host pi config (`settings.json`, `models.json`, optional auth).
- `<control-root>/sessions/` — persistent `cogi` session files.
- the per-run agent dir (with staged secrets) lives outside the workspace and is not exposed to the Gondolin guest.

You create a new project with `/new-project`: it collects a name (and optional
description / Jira key), then **kicks off the bundled `new-project` skill**, which
scaffolds `<slug>.md` from your house format and adds an `INDEX.md` entry. (There is
no `/add-repo` — the markdown-first model has no structured repo links.)

## Modes

### `/normal`
- restores normal tools
- no special write restrictions from the extension

### `/readonly`
- only inspection tools remain active
- blocks `bash`, `write`, and `edit`

### `/plan`
- allows analysis/planning behavior
- allows only safe read-only `bash`
- allows `write`/`edit` only for the active project's:
  - state file (`<slug>.md`)
  - `artifacts/<slug>/**`
- supports planning artifacts in that project artifact directory, such as daily plans or session plans under `~/Projects/projectStates/artifacts/<slug>/`
- also allows Jira closeout drafts under:
  - `/tmp/jira-closeout-<ISSUE-KEY>.txt`

This lets you keep project tracking and planning artifacts up to date during planning without permitting repo/code edits.

## Transactional approval gate

The bundled extension now enforces a stateful approval gate for `write` and `edit` tool calls.

Flow:

1. The assistant must first propose changes using:

```text
Change N/Total
File: <path>
Proposed edit: <summary>
```

2. The extension captures those proposed file paths.
3. Until you approve them, `write` and `edit` are blocked.
4. You respond with:
   - `a` or `approve`
   - `e` or `edit`
   - `r` or `reject`
5. After approval, only the approved file paths are unlocked for mutation.

Notes:

- this is path-based transactional gating, not content-diff verification
- menu approvals now hand control back to the assistant so an approved change can apply before the review UI reopens for any remaining pending proposals
- typed selector actions such as `reject <id>` and `edit <id>: ...` can target already-approved proposals when you need to revise or clear them
- in `/plan`, the gate is combined with the project-state/artifact-only write policy
- in all modes, `bash` commands containing `sops` are blocked

## Manual validation / smoke checks

Basic checks we have been using during refactors:

1. Restart `cogi` and ask `What mode am I in?`
   - expected: startup defaults to `/plan`
2. Run `/normal`, then ask again.
   - expected: reported mode changes to `normal`
3. Run `/plan`, then attempt a direct repo file mutation such as `extensions/workflow-mode.ts` without a proposal.
   - expected: blocked with the plan-mode repo write scope diagnostic
4. Still in `/plan`, attempt an unsafe bash command such as `rm -rf /tmp/test`.
   - expected: blocked because plan mode only allows safe read-only bash
5. Run `/normal`, then attempt a direct unapproved `write` or `edit` on a repo file.
   - expected: blocked by the transactional approval gate with `No approved proposal matches this path.`
6. Run `/readonly`, then attempt a mutation.
   - expected: mutation tools are unavailable or the mutation is blocked because read-only mode disables file changes
7. Exit `cogi` and inspect `<project-states-dir>/artifacts/<slug>/latest-shutdown.md`.
   - expected: fresh `saved_at` timestamp and the current mode/session info are persisted

These checks are intentionally small and safe. When testing writes, prefer tiny artifact-only attempts or blocked repo-path attempts so validation does not leave accidental code changes behind.

## Run

From this directory:

```bash
nix run . -- --help
```

Run pi in the current repo:

```bash
nix run .#cogi -- --workspace "$PWD"
```

The workspace is mounted into the Gondolin guest at `/workspace`. When an active project is selected, its state file is loaded into agent context. Create new projects from inside a session with `/new-project`.

Use host pi auth so existing `~/.pi/agent/auth.json` credentials work, or so `/login` persists across runs:

```bash
nix run .#cogi -- --workspace "$PWD" --host-pi-auth
```

Use a custom control root:

```bash
nix run .#cogi -- --workspace "$PWD" --control-root /path/to/cogitator-root
```

On first run, that control root will get a default `.gitignore` if one does not already exist.

Preselect a project without the startup picker:

```bash
nix run .#cogi -- --workspace "$PWD" --project-id govcloud-wave-1
```

## Secret architecture

The design avoids exporting provider API keys into normal shell environment variables.

1. `sops-nix` decrypts secrets to host files.
2. `cogi` stages only those specific files into the per-run agent dir (a fresh `mktemp -d`, removed on exit) under `secrets/`.
3. The generated `pi` `models.json` references each key with `!cat "$PI_CODING_AGENT_DIR/secrets/provider-<id>.key"`, so `pi` reads the keys into memory and registers providers directly.
4. The bundled `bash` tool scrubs the secret-config environment before spawning shell commands.
5. The `sops` command is blocked in `bash` in all modes.

Result:

- the `pi` runtime can use the keys
- keys are never written into the workspace or exported as plaintext env vars
- because the agent dir lives outside the workspace, it is not mounted into the Gondolin guest, so VM-routed tools cannot read it
- child shell processes do not inherit the secret-config environment variables

For portable local development, `--host-pi-auth` is also available as an opt-in runtime path. It reuses host `~/.pi/agent` auth so standard pi auth (`~/.pi/agent/auth.json` or `/login`) works without embedding provider secrets into this repo.

### Overlay and factory inputs for Nix / sops-nix

This flake now exposes both:

- `overlays.default`
- `lib.mkCogitator`

Recommended consumption style:

- use the overlay for ergonomic package names like `pkgs.cogitator`
- keep `mkCogitator` for host-specific configured package construction

You can call the factory from your main flake with:

- `plainEnv` for non-secret values
- `providerConfigs` for provider URLs and secret file paths
- `secretEnvFiles` for additional protected files you want staged into the per-run agent dir under `secrets/`
- `modeModels` for declarative primary/alternate model selection by mode
- `extraExtensions` for additional Pi extensions to register
- `extraRuntimeTools` for additional runtime packages available to Cogitator
- `defaultProjectId` to preselect a default project slug at startup

The flake also exports a Home Manager module as `homeManagerModules.default`. Its current options are:

- `ai.cogitator.enable`
- `ai.cogitator.plainEnv`
- `ai.cogitator.secretEnvFiles`
- `ai.cogitator.providerConfigs`
- `ai.cogitator.modeModels`
- `ai.cogitator.extraExtensions`
- `ai.cogitator.extraRuntimeTools`
- `ai.cogitator.defaultProjectId`
- `ai.cogitator.package` (`"piSandbox"` or `"cogitatorInitProject"`)

### Azure / APIM provider configuration

**Do not use `"azure"` as the provider ID.** Pi has built-in Azure OpenAI handling that activates when the provider is named `"azure"` — it rewrites the request URL to include the deployment name in the path (`/deployments/{model}/responses`), which breaks APIM-fronted endpoints that expect the model in the request body. Use any other ID (e.g. `"varda-ai"`) to get standard OpenAI-compatible behaviour where pi posts to `{baseUrl}/responses` with the model in the body.

`providerConfigs` handles API key staging into the per-run agent dir. Also set these in `plainEnv`:

| Variable | Purpose |
|---|---|
| `COGITATOR_DEFAULT_PROVIDER` | Provider ID to select at startup |
| `COGITATOR_DEFAULT_MODEL` | Model/deployment name to pre-select |

Primary/alternate models for `/plan` and `/normal` can be configured declaratively through the `modeModels` argument to `mkCogitator`.

Conceptual examples from a Home Manager / `sops-nix` environment:

Using the exported Home Manager module:

```nix
{
  imports = [ inputs.cogitator.homeManagerModules.default ];

  nixpkgs.overlays = [ inputs.cogitator.overlays.default ];

  ai.cogitator = {
    enable = true;
    package = "piSandbox";
    defaultProjectId = "your-project-slug";

    providerConfigs = {
      varda-ai = {                  # NOT "azure" — avoids pi's Azure URL rewriting
        baseUrl = "https://<apim-host>/openai/v1";
        api = "openai-responses";
        auth = {
          type = "header";
          header = "api-key";
        };
        apiKeyFile = config.sops.secrets.azure_api_key.path;
        # models must be a list of objects — plain strings fail schema validation
        models = [ { id = "gpt-5.4"; } { id = "gpt-5.4-kaddu"; } ];
      };
    };

    modeModels = {
      plan = {
        primary = {
          provider = "anthropic";
          modelId = "claude-opus-4.8";
        };
        alternate = {
          provider = "varda-ai";
          modelId = "gpt-5.4-kaddu";
        };
      };
      normal = {
        primary = {
          provider = "varda-ai";
          modelId = "gpt-5.4-kaddu";
        };
        alternate = {
          provider = "anthropic";
          modelId = "claude-sonnet-4-6";
        };
      };
    };

    plainEnv = {
      COGITATOR_DEFAULT_PROVIDER = "varda-ai";
      COGITATOR_DEFAULT_MODEL = "gpt-5.4-kaddu";
    };
  };
}
```

Or calling `mkCogitator` directly:

```nix
{
  nixpkgs.overlays = [ inputs.cogitator.overlays.default ];

  home.packages = let
    cog = pkgs.cogitatorLib.mkCogitator {
      controlRoot = "/home/kaddu/.local/share/cogitator";
      providerConfigs = {
        varda-ai = {
          baseUrl = "https://<apim-host>/openai/v1";
          api = "openai-responses";
          auth = {
            type = "header";
            header = "api-key";
          };
          apiKeyFile = config.sops.secrets.azure_api_key.path;
          models = [ { id = "gpt-5.4"; } { id = "gpt-5.4-kaddu"; } ];
        };
      };
      modeModels = {
        plan = {
          primary = {
            provider = "anthropic";
            modelId = "claude-opus-4.8";
          };
          alternate = {
            provider = "varda-ai";
            modelId = "gpt-5.4-kaddu";
          };
        };
        normal = {
          primary = {
            provider = "varda-ai";
            modelId = "gpt-5.4-kaddu";
          };
          alternate = {
            provider = "anthropic";
            modelId = "claude-sonnet-4-6";
          };
        };
      };
      plainEnv = {
        COGITATOR_DEFAULT_PROVIDER = "varda-ai";
        COGITATOR_DEFAULT_MODEL = "gpt-5.4-kaddu";
      };
      defaultProjectId = "your-project-slug";
    };
  in [
    cog.piSandbox
    cog.cogitatorInitProject
  ];
}
```

Internally, `modeModels` is translated into `COGITATOR_*` environment variables for the runtime extension. Those variables remain supported as a fallback/compatibility path.

If you just want the default package without host-specific provider wiring, you can use:

```nix
{
  nixpkgs.overlays = [ inputs.cogitator.overlays.default ];
  home.packages = [ pkgs.cogitator ];
}
```

The key point is that `apiKeyFile` is a host secret file path from `sops-nix`, not a plaintext token value in Nix.

## Launcher defaults

`cogi` runs `pi` on the host and:

- prepares a per-run agent dir (merged `settings.json`/`models.json`/`keybindings.json` from host `~/.pi/agent` + cogitator config, plus staged provider secrets)
- registers the workflow extension, `pi-web-access`, `pi-mcp-adapter`, the `ponytail` and `new-project` skills, and the Gondolin micro-VM extension via the agent `settings.json` `packages` list
- exports `PI_CACHE_RETENTION=long` (overridable) for 1-hour prompt-cache retention on supporting models, matching Claude Code's extended-cache behavior
- persists session history under `<control-root>/sessions/` so it survives restarts
- loads the selected project's state file into agent context

Filesystem/network isolation is the Gondolin guest's job (workspace mounted at `/workspace`), not `cogi`'s; see [docs/project-model.md](docs/project-model.md).

### MCP servers

`pi-mcp-adapter` bridges MCP servers into pi as tools. It reads standard MCP config
at runtime — `.mcp.json` in the workspace, `~/.config/mcp/mcp.json`, or pi-owned
overrides — so an existing config (e.g. the Ship MCP server) is picked up without
duplicating it here, and any embedded credentials stay in those host files rather
than in this repo.

## Important note on enforcement

Process isolation comes from the **Gondolin micro-VM**: VM-routed tool calls cannot touch the host filesystem outside `/workspace`, and network egress is subject to Gondolin's policy layer.

The bundled pi extension does several different jobs inside `pi`:

- project selection and project-state context loading
- mode enforcement for `/readonly` and `/plan`
- transactional gating for `write` and `edit`
- blocking of `sops` in `bash`
- instruction-level workflow guidance for your proposal format

That means:

- OS/process protection comes from Gondolin
- workflow/write-policy protection inside `pi` comes from the extension
- file approval has an actual stateful gate, not just prompt guidance

## Creating projects

Use `/new-project` from inside a session. It collects a name (and optional
description / Jira key), then kicks off the bundled `new-project` skill, which
creates `<project-states-dir>/<slug>.md` in your house format and adds an `INDEX.md`
entry under the right section. Load it with `/project`.

> The legacy `cogitator-init-project` CLI predates the markdown-first model and
> scaffolds the old `project.json` layout (now ignored); don't use it.

Shared resources under `resources/` hold reusable templates and prompt fragments.
`extensions/workflow-mode.ts` loads prompt guidance for the approval workflow, secret
handling, modes, project-context review, and targeted file access from
`resources/prompts/` at runtime.

## Testing

The flake provides the pi packages the extensions import, so the unit tests run without a manual `npm install`. From the repo root:

```bash
nix run .#test
```

Or drop into a dev shell (`nodejs_24`, `tsx`, and a `cogitator-test` command) and iterate:

```bash
nix develop
cogitator-test
```

Both run `extensions/tests/unit.ts` against the working tree. If you prefer to run `tsx` yourself, you need `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` resolvable and `"type": "module"` in scope. See [docs/testing.md](docs/testing.md) for test structure and coverage.
