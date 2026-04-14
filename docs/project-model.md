# Project Model

## Control root structure

```
~/.local/share/cogitator/
  .gitignore
  sessions/
  projects/
    <project-id>/
      project.json
      state.md
      artifacts/
        latest-shutdown.md
      repoContexts/
```

## `project.json` schema

```json
{
  "id": "string (kebab-case)",
  "name": "string (human-readable)",
  "description": "string (optional, shown in picker)",
  "stateFile": "state.md",
  "artifactsDir": "artifacts",
  "repos": [
    {
      "path": "/absolute/path/to/repo",
      "name": "repo-name (optional)",
      "role": "primary | supporting (optional)"
    }
  ],
  "repoContexts": ["repoContexts/file.md"],
  "tags": ["optional", "tags"]
}
```

## State file template

The canonical template lives at `resources/templates/project-state-template.md` in the config repo. `/new-project` uses this template when scaffolding a new project.

Key sections:
- **Executive Summary** — status, goal
- **Background & Context** — status, repos, current focus
- **Architecture Decisions** — decision records with rationale, date, owner, status
- **Implementation Plan** — checkbox list of work items
- **Open Questions & Blockers**
- **Key File Locations**
- **Requested Backlog**
- **Progress Tracking** — todo, in_progress, blocked, done, deferred sub-lists
- **Next Steps**
- **Session Shutdown Checkpoint** — auto-updated on shutdown

## Linked repos and `/add-repo`

Projects can link multiple repositories. Each linked repo is mounted into the sandbox on `cogi` startup. `/add-repo` persists a new repo path to `project.json` immediately, but a restart is required before the sandbox mounts the new path.

## `/new-project` wizard

Interactive inputs: project id, name, description, goal, owner, primary repo, additional repos, current focus, constraints, assumptions, next steps, tags.

Creates `project.json`, `state.md` (from template), `artifacts/`, and `repoContexts/` under the control root, then activates the project for the current session.

## Shutdown checkpoint persistence

On session shutdown, `writeProjectShutdownCheckpoint()` in `project-state.ts`:
1. Builds a status snapshot by parsing `state.md`
2. Writes `artifacts/latest-shutdown.md` with timestamps, mode, proposals, and project status
3. Upserts a `## Session Shutdown Checkpoint` block into `state.md`

## Session storage

Persistent session files live at `<control-root>/sessions/`. This is separate from `~/.pi/agent` which holds pi config/auth only.
