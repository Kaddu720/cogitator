# Architecture

## Module map

Cogitator is a pi extension that provides project-aware sessions, mode enforcement, and a transactional approval gate for file mutations.

### Extension files (`extensions/`)

| File | Ownership |
|------|-----------|
| `workflow-mode.ts` | Entry point. Wires runtime state, hooks, commands, and delegates to all other modules. |
| `commands.ts` | All `pi.registerCommand` / `pi.registerShortcut` calls and descriptions. |
| `hooks.ts` | All `pi.on` calls and per-event return-type aliases. |
| `runtime.ts` | `Mode` type (`normal \| readonly \| plan \| creative`), `persistMode`, `restoreMode` (includes legacy `architect`→`plan` and `executor`→`normal` mapping), `persistProjectSelection`, `restoreStoredProjectId`. |
| `resources.ts` | Prompt fragment loading, bash safety, mode tool allowlists, `ModeDescriptor` map (4 entries: plan, normal, readonly, creative), display formatters. |
| `projects.ts` | Markdown-first project store: `ProjectRecord`, `loadProjects` (project-states dir + `INDEX.md`), path resolution, context building, `new-project` scaffolding helper. |
| `project-state.ts` | Tolerant state-markdown parsing, weekly summaries, artifacts-only shutdown checkpoint. |
| `approvals/types.ts` | Shared types: `ProposalStatus`, `PendingProposal`, `StoredApprovalGateState`. |
| `approvals/parse.ts` | Proposal extraction from assistant text, path normalization, ID generation. |
| `approvals/format.ts` | Pure display-string formatters for proposals. |
| `approvals/policy.ts` | Gate logic, status transitions, merge/complete operations. |
| `approvals/actions.ts` | Query/mutation helpers that operate on the proposal array via `ApprovalActionDeps`. |
| `approvals/state.ts` | Session persistence for approval gate state. |

### Import direction rules

```
workflow-mode.ts → commands.ts, hooks.ts, runtime.ts, resources.ts, projects.ts, project-state.ts, approvals/*
commands.ts      → (no extension imports; receives handlers from workflow-mode.ts)
hooks.ts         → (no extension imports; receives handlers from workflow-mode.ts)
runtime.ts       → (standalone)
resources.ts     → runtime.ts, projects.ts
projects.ts      → (standalone, no extension imports)
project-state.ts → runtime.ts, projects.ts, approvals/types.ts, approvals/format.ts
approvals/*      → approvals/types.ts, projects.ts (parse.ts), approvals/parse.ts (policy.ts)
```

No circular imports. `workflow-mode.ts` is the only file that imports from all modules.

## Runtime state

All mutable state lives in a single `WorkflowRuntimeState` object inside `workflow-mode.ts`:

```ts
interface WorkflowRuntimeState {
  currentMode: Mode;  // "normal" | "readonly" | "plan" | "creative"
  activeProject: ProjectRecord | null;
  activeRepoRoot?: string;
  pendingProposals: PendingProposal[];
  approvalPromptInFlight: boolean;
  approvalPromptDeferred: boolean;
  approvalResumePending: boolean;
}
```

## Directory boundaries

| Path | Purpose |
|------|---------|
| `~/.config/cogitator` | Repo: extension code, flake, resources, docs |
| `~/.pi/agent` | Host pi config and auth (settings.json, auth.json, models.json) |
| `~/Projects/projectStates` | Project state files + `INDEX.md` (default; `COGITATOR_PROJECT_STATES_DIR` / `--project-states-dir`) |
| `~/Projects/projectStates/artifacts/<slug>/` | Per-project artifacts incl. `latest-shutdown.md` |
| `~/.local/share/cogitator` | Control root: cogitator runtime state (sessions + `.gitignore`) |
| `~/.local/share/cogitator/sessions/` | Persistent cogi session files |

Per-run, `cogi` also builds a temporary agent dir (`mktemp -d`) holding merged
`settings.json`/`models.json` and staged provider secrets; it is removed on exit.

## Isolation model

Process isolation is provided by **Gondolin** (a local QEMU micro-VM), wired in as
a pi extension — not by wrapping `pi` in an OS sandbox. `cogi` runs `pi` directly on
the host; there is no `bubblewrap` or Seatbelt.

- The Gondolin extension overrides `pi`'s `read`/`write`/`edit`/`bash` tools (and `!`
  commands) so they execute inside the micro-VM, with the workspace mounted at
  `/workspace`. It boots on `session_start`; guest images (~200 MB) are fetched and
  cached on first use.
- Runs on Linux and macOS via the QEMU backend (`qemu` is on the runtime path);
  KVM acceleration is used on Linux when available.
- The agent dir (with staged secrets) lives outside the workspace, so VM-routed
  tools cannot read it.

What protects what:
- **OS/process isolation** comes from Gondolin.
- **Workflow/write-policy** (modes, the transactional approval gate, `sops` blocking,
  targeted-read discipline) comes from this extension, inside `pi`.
