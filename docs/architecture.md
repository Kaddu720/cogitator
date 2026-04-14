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
| `projects.ts` | Project record types, loading, scaffolding, path resolution, context building. |
| `project-state.ts` | State markdown parsing, weekly summaries, shutdown checkpoint persistence. |
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
| `~/.local/share/cogitator` | Mutable control root: projects, sessions, uploads |
| `~/.local/share/cogitator/projects/<id>/` | Per-project: project.json, state.md, artifacts/, repoContexts/ |
| `~/.local/share/cogitator/sessions/` | Persistent cogi session files |

## Sandbox model

`cogi` uses `bubblewrap` (`bwrap`) to create a sandboxed environment:

- `/nix/store` mounted read-only
- Workspace and linked repos mounted read-write
- Control root mounted with a synthetic view (only matching project dirs + sessions)
- `HOME` isolated to `/tmp/home`
- Private `/tmp`
- Network disabled by default (use `--net` to enable)
- Host `~/.pi/agent` config imported but full `~/.pi` not exposed
