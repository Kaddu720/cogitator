# cogitator

Sandboxed `pi` launcher for Linux using `bubblewrap`, with a macOS Seatbelt (`sandbox-exec`) path, plus a bundled workflow-mode extension for project-aware sessions.

## Documentation

Detailed reference docs live in `docs/`:

- [Architecture](docs/architecture.md) — module map, import rules, runtime state, directory boundaries, sandbox model
- [Approval Flow](docs/approval-flow.md) — proposal lifecycle, per-change approval, sequence gating, mode interactions
- [Project Model](docs/project-model.md) — control root structure, project.json schema, state template, linked repos, shutdown checkpoints
- [Mode System](docs/mode-system.md) — available modes (plan, normal, readonly, creative), descriptors, write policies, tool allowlists
- [Testing](docs/testing.md) — running unit tests, test structure, coverage targets

## What this flake provides

- `cogi` for Level 2-style sandboxing on Linux via `bubblewrap` and on macOS via Seatbelt (`/usr/bin/sandbox-exec`)
- flake-provided runtime tools on both platforms, including `git`, `gh`, `ffmpeg`, `yt-dlp`, `node`, and `python`
- `cogitator-init-project` to bootstrap a project in the control root
- platform-specific isolation semantics: Linux uses namespace/bind-mount sandboxing, while macOS uses policy-based file/network restrictions
- an overlay exposing:
  - `pkgs.cogitator`
  - `pkgs.cogitator-init-project`
- a bundled extension that adds:
  - `/project`
  - `/project-status`
  - `/new-project`
  - `/add-repo`
  - `/plan`
  - `/readonly`
  - `/normal`
- startup project selection at pi startup
- a transactional approval gate for file mutations based on your proposal workflow
- plan mode that keeps repo/code work read-only while still allowing project state + artifact updates
- explicit blocking of the `sops` command
- stronger secret handling using protected mounted secret files and in-memory provider registration

## Platform notes

- Linux keeps the existing `bubblewrap` sandbox model with a synthetic filesystem view and read-only `/nix/store`.
- macOS runs `pi` under Apple Seatbelt with a generated temporary sandbox profile via `/usr/bin/sandbox-exec`.
- The macOS path is intentionally narrower in scope than Linux `bubblewrap`: it is policy-based isolation, not namespace-based filesystem virtualization.
- On macOS, expect some tool-specific edge cases around file watchers, subprocess behavior, Mach services, and network policy details.

## Registry layout

Default control root:

```text
/home/kaddu/.local/share/cogitator/
```

Expected project layout:

```text
/home/kaddu/.local/share/cogitator/
  .gitignore
  projects/
    <project-id>/
      project.json
      state.md
      artifacts/
      repoContexts/
```

Template and shared resource files included here:

- `/home/kaddu/.config/cogitator/resources/templates/project-template.json`
- `/home/kaddu/.config/cogitator/resources/templates/project-state-template.md`
- `/home/kaddu/.config/cogitator/resources/prompts/`

You can also generate a new project scaffold automatically with:

```bash
nix run .#cogitator-init-project -- my-project-id \
  --name "My Project" \
  --repo /path/to/repo
```

A control-root `.gitignore` template is also included here:

- `/home/kaddu/.config/cogitator/control-root.gitignore`

`cogi` will automatically create `<control-root>/.gitignore` if it is missing, with default ignores for:

- `projects/`
- `uploads/`

### `project.json`

Each project can link multiple repos.

Example:

```json
{
  "id": "govcloud-wave-1",
  "name": "GovCloud Wave 1",
  "description": "Migration planning and execution tracking",
  "stateFile": "state.md",
  "artifactsDir": "artifacts",
  "repos": [
    {
      "path": "/home/kaddu/projects/bitbucket/vsi-infrastructure-platform",
      "name": "vsi-infrastructure-platform",
      "role": "primary"
    },
    {
      "path": "/home/kaddu/projects/bitbucket/vsi-azuregov",
      "name": "vsi-azuregov",
      "role": "supporting"
    }
  ],
  "repoContexts": [
    "repoContexts/vsi-infrastructure-platform-private.md"
  ],
  "tags": ["govcloud", "terraform"]
}
```

## Startup behavior

When pi starts:

- it looks under `projects/*/project.json`
- it detects the current repo root if one is mounted
- it prompts you to choose a project
- projects linked to the current repo are shown first
- the selected project's `state.md` is loaded into agent context before turns
- configured `repoContexts` are also loaded into context

The selected project is persisted in the pi session, so session resume/tree navigation restores it.

Cogitator intentionally separates replicated config assets from host-local runtime state:

- `.config/cogitator/resources/prompts/` stores shared prompt fragments that are versioned with the Cogitator config and replicated across machines.
- `.config/cogitator/resources/templates/` stores shared reusable templates such as the canonical project-state template.
- `~/.pi/agent` remains the host-side home for pi config such as `settings.json`, `models.json`, and optional auth.
- `<control-root>/sessions/` stores persistent `cogi` session files.
- `<control-root>/projects/` stores host-local project records, artifacts, and repo context files.
- the model sees the workspace, linked repos, and the mounted Cogitator control-root view, but not your full host `~/.pi` directory.

You can create a new project interactively with `/new-project`. The wizard collects the project id, project name, description, goal, owner, primary repo path, additional repo paths, initial focus items, constraints, assumptions, next steps, and optional tags. It then creates:

```text
<control-root>/projects/<project-id>/
  project.json
  state.md
  artifacts/
  repoContexts/
```

The new project is selected immediately for the current session.

You can add another linked repository during an interactive session with `/add-repo`. This updates the active project's `project.json` immediately, but because `bwrap` mounts are fixed when `cogi` starts, you must restart `cogi` before the newly linked repo becomes accessible inside the sandbox. The same restart rule applies when `/new-project` links repositories that are not already visible in the current sandbox.

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
  - `state.md`
  - `artifacts/**`
- also allows Jira closeout drafts under:
  - `/tmp/jira-closeout-<ISSUE-KEY>.txt`

This lets you keep project tracking and artifacts up to date during planning without permitting repo/code edits.

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
7. Exit `cogi` and inspect `<control-root>/projects/<id>/artifacts/latest-shutdown.md`.
   - expected: fresh `saved_at` timestamp and the current mode/session info are persisted

These checks are intentionally small and safe. When testing writes, prefer tiny artifact-only attempts or blocked repo-path attempts so validation does not leave accidental code changes behind.

## Run

From this directory:

```bash
nix run . -- --help
```

Bootstrap a new project under the default control root:

```bash
nix run .#cogitator-init-project -- my-project-id \
  --name "My Project" \
  --description "Short description" \
  --repo /path/to/repo-one \
  --repo /path/to/repo-two \
  --tag infra
```

Run sandboxed pi in the current repo:

```bash
nix run .#cogi -- --workspace "$PWD"
```

When an active project is selected, `cogi` also mounts every existing repository listed in that project's `project.json` on startup.

Use host pi auth inside the sandbox so existing `~/.pi/agent/auth.json` credentials work, or so `/login` persists across runs:

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

## Stronger secret architecture

The current design avoids exporting provider API keys into normal shell environment variables.

Instead:

1. `sops-nix` decrypts secrets to host files.
2. `cogi` mounts only those specific files into the sandbox under:

```text
/run/cogitator-secrets/
```

3. The bundled extension reads provider config from a protected runtime file.
4. The bundled extension reads mounted API key files into memory and registers providers directly with pi.
5. The bundled `bash` tool scrubs the secret-config environment before spawning shell commands.
6. Model-facing tools are blocked from protected secret paths.

Result:

- pi runtime can use the keys
- the model tools cannot read the protected secret files
- child shell processes do not inherit the secret-config environment variables

For portable local development, `--host-pi-auth` is also available as an opt-in runtime path. It binds host `~/.pi` into sandbox HOME so standard pi auth (`~/.pi/agent/auth.json` or `/login`) works without embedding provider secrets into this repo.

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
- `secretEnvFiles` for additional protected files you may want mounted under `/run/cogitator-secrets/`

Conceptual example from a Home Manager / `sops-nix` environment:

```nix
{
  nixpkgs.overlays = [ inputs.cogitator.overlays.default ];

  home.packages = let
    cog = pkgs.cogitatorLib.mkCogitator {
      controlRoot = "/home/kaddu/.local/share/cogitator";
      providerConfigs = {
        azure = {
          name = "Azure OpenAI";
          baseUrl = "https://sre-dev.azure-api.net/varda-ai-nextgen-resource/openai/v1";
          api = "openai-responses";
          authHeader = true;
          apiKeyFile = config.sops.secrets.azure_api_key.path;
        };
        openwebui = {
          name = "OpenWebUI";
          baseUrl = "https://dev-ai.cl4-ops-dev.varda.com/api/v1";
          api = "openai-responses";
          authHeader = true;
          apiKeyFile = config.sops.secrets.openwebui_api_key.path;
        };
      };
    };
  in [
    cog.piSandbox
    cog.cogitatorInitProject
  ];
}
```

If you just want the default package without host-specific provider wiring, you can use:

```nix
{
  nixpkgs.overlays = [ inputs.cogitator.overlays.default ];
  home.packages = [ pkgs.cogitator pkgs.cogitator-init-project ];
}
```

The key point is that `apiKeyFile` is a host secret file path from `sops-nix`, not a plaintext token value in Nix.

## Sandbox defaults

Default sandbox behavior:

- mounts `/nix/store` read-only
- mounts the selected workspace read-write
- mounts every existing repo listed in the active project's `project.json` when a project is selected or preselected
- exposes only a synthetic view of the control root inside the sandbox
- mounts repo-matching project directories from `<control-root>/projects/` into that synthetic control root
- mounts `<control-root>/sessions/` so `cogi` session history persists across restarts
- does not expose unrelated project state directories from the control root
- does not expose your full `~/.pi` config directory to the model
- does not expose your home directory unless you explicitly bind parts of it
- does not expose host `/var` or `/run`
- isolates `HOME` to `/tmp/home`
- uses private `/tmp`
- disables network unless `--net` is passed

## Important note on enforcement

The `bwrap` sandbox protects the host OS and limits visible paths.

The bundled pi extension does several different jobs:

- project selection and project-state context loading
- mode enforcement for `/readonly` and `/plan`
- transactional gating for `write` and `edit`
- blocking of `sops` in `bash`
- instruction-level workflow guidance for your proposal format

That means:

- OS protection comes from `bwrap`
- workflow/write-policy protection inside pi comes from the extension
- file approval now has an actual stateful gate, not just prompt guidance

## Bootstrap helper details

`cogitator-init-project` creates:

```text
<control-root>/projects/<project-id>/
  project.json
  state.md
  artifacts/
  repoContexts/
```

It also creates `<control-root>/.gitignore` if missing.

The interactive `/new-project` command creates the same scaffold from inside `cogi`, but also prompts for initial state-file content, uses the shared canonical template at `/home/kaddu/.config/cogitator/resources/templates/project-state-template.md`, and automatically switches the current session to the new project.

Wizard inputs for `/new-project`:

- project id
- project name
- description
- goal
- owner
- primary repo path
- additional repo paths
- current focus items
- constraints
- assumptions
- next steps
- tags

Shared resources under `resources/` are intended for shared templates, prompt fragments, and other reusable configuration that should apply across projects rather than living under a single project's `artifacts/` directory. `extensions/workflow-mode.ts` now loads prompt guidance for approval workflow, secret handling, modes, and project-context review from `resources/prompts/` at runtime.

Useful flags:

- `--control-root PATH`
- `--repo PATH` (repeatable)
- `--tag TAG` (repeatable)
- `--context PATH` (repeatable, relative to the project dir)
- `--force`

## Testing

Run unit tests (requires `tsx`):

```bash
npx tsx extensions/tests/unit.ts
```

See [docs/testing.md](docs/testing.md) for details on test structure and coverage.

## Extra binds

If `pi` or a tool later needs additional host files, add them explicitly with:

- `--bind-ro`
- `--bind-rw`
