# Project Model

Cogitator is **markdown-first**: each project is a single markdown state file in a
flat project-states directory. There is no `project.json` and no central control
root for project records — the state files are the source of truth (and are
typically Jira-synced and owned by you, not cogitator).

## Project states directory

```
~/Projects/projectStates/          # default; override with COGITATOR_PROJECT_STATES_DIR
  INDEX.md                         # curated index: names, statuses, ordering, meta-projects
  ARCHIVE.md                       # completed projects (not offered as selectable)
  <project-slug>.md                # one markdown state file per project
  artifacts/
    <project-slug>/
      latest-shutdown.md           # rolling session checkpoint (written by cogitator)
      ...                          # other generated artifacts
```

- Location resolves from `COGITATOR_PROJECT_STATES_DIR`, the `cogi --project-states-dir PATH`
  flag, or the default `~/Projects/projectStates`.
- `INDEX.md` and `ARCHIVE.md` are not themselves projects.

## `ProjectRecord`

There is no on-disk metadata file. A record is derived from the filesystem +
`INDEX.md`:

```ts
interface ProjectRecord {
  id: string;          // filename slug without .md (e.g. "sre-3382-ship-vm-to-k8s-migration")
  name: string;        // from INDEX.md, else the file's first `# ` heading, else titleized id
  statePath: string;   // absolute path to <slug>.md
  artifactsDir: string;// <states-dir>/artifacts/<slug>
  status?: string;     // from INDEX.md or the state file (in_progress/todo/blocked/done/deferred)
}
```

## Selection

`loadProjects()` lists `*.md` (excluding `INDEX.md`/`ARCHIVE.md`), then:
1. Parses `INDEX.md` for display names, statuses, and ordering (any line with a
   markdown link to a `*.md` file; a status token on the line is captured).
2. For files absent from `INDEX.md`, reads the first `# ` heading and a `status:`
   line for the name/status.
3. Sorts by `INDEX.md` order first (curated/active first), then alphabetically.

`/project` shows the resulting list (`(id) name · status`). There is no repo-based
auto-matching — the markdown-first model has no structured repo links.

## State file format

State files use your own house format (cogitator does not impose a template).
Parsing is tolerant and looks for, when present:
- `## Executive Summary` with a `Status:` line (e.g. `Status: **in_progress**`)
- `## Background & Context`
- `## Progress Tracking` with `todo`/`in_progress`/`blocked`/`done`/`deferred` bullet groups
- `## Next Steps`

## `/new-project`

`/new-project` collects a name (and optional description / Jira key) via quick
prompts, then scaffolds `<slug>.md` directly from the house format, adds an
`INDEX.md` entry under the appropriate section, and loads the new project
immediately. The command uses a narrow bootstrap write path so it still works
before any project is active.

## Shutdown checkpoint persistence (artifacts-only)

On session shutdown, `writeProjectShutdownCheckpoint()` in `project-state.ts`:
1. Builds a status snapshot by parsing the state file (read-only).
2. Writes `artifacts/<slug>/latest-shutdown.md` with timestamps, mode, proposals, status, `repo_root`, and `canonical_checkout_path`.

`repo_root` is the repository root as seen inside the Gondolin VM (often under `/workspace`).
`canonical_checkout_path` is the operator-intended checkout or worktree path for this session.
When both are present, cogitator uses the canonical checkout path for proposal normalization,
path resolution, and mutation gating so approvals stay attached to the intended checkout instead
of drifting to a same-named `/workspace` mirror with a different layout.

Cogitator **never writes into the state file** — no checkpoint block is injected —
so it never conflicts with your Jira sync. On resume, the rolling shutdown artifact
is read for the latest checkpoint.

## Session storage

Persistent `cogi` session files live under the control root at
`<control-root>/sessions/` (default `~/.local/share/cogitator/sessions`, set with
`--control-root`). The control root is now only cogitator runtime state (sessions +
its `.gitignore`); it no longer holds project records. `~/.pi/agent` holds pi
config/auth only.
