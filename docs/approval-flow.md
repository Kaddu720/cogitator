# Approval Flow

## Proposal lifecycle

```
pending → approved → applying → applied
                ↘ rejected
pending → needs_revision → (re-proposed) → pending
pending → deferred
```

### States

| Status | Meaning |
|--------|---------|
| `pending` | Proposed by the assistant, awaiting user decision |
| `approved` | User approved; the assistant may now mutate the file |
| `applying` | The assistant's tool call matched the approved proposal; mutation in progress |
| `applied` | The assistant confirmed completion with `Change N/Total is complete.` |
| `rejected` | User rejected the proposal |
| `needs_revision` | User requested changes; the assistant should re-propose |
| `deferred` | User deferred for later; optionally with a note |

## Per-change approval

Every file mutation (`write` or `edit` tool call) requires exactly one approved proposal whose `resolvedPath` matches the target file. The assistant must propose changes using:

```
Change N/Total
File: <path>
Proposed edit: <summary>
```

Then wait for explicit user approval before calling any mutation tool.

## Sequence gating

When proposals form a sequence (e.g., Change 1/3, 2/3, 3/3), only the next unapplied step is actionable. Earlier steps must reach `applied` status before later steps become available for approval.

## Approval-exempt paths

The active project's state file (`<project-states-dir>/<slug>.md`) is exempt from the approval gate in all modes. It can be written without a proposal.

## Mode interactions

- **Normal mode:** Approval gate applies to all file mutations (except the active project's state file).
- **Plan mode:** Approval gate applies, but only project state file + artifacts dir + Jira draft paths are writable at all.
- **Readonly mode:** All mutations blocked regardless of approval state.

## Completion markers

The assistant must emit `Change N/Total is complete.` after successfully applying an approved change. This transitions the proposal to `applied` status and unblocks any subsequent sequence steps.

## `/approval-status` behavior

`/approval-status` can reopen the interactive approval menu, but that menu now shows only actionable `pending` proposals. Already-approved proposals may still appear in the text summary for inspection, but they are no longer shown as interactive approval-list candidates.

## Path resolution requirements

Approval application is keyed by the proposal's resolved path. The approved proposal path and the eventual mutation target must resolve identically. If a proposal is approved against `/workspace/...` but a later mutation targets a host path like `/Users/...`, the approval gate will block the mutation even when the file is logically the same.

## Known issues

- Proposals in `applying` state block path writes but cannot be targeted by `reject` or `edit` commands. They resolve on completion marker or session restart.
- Historical collided proposal IDs may appear in `/approval-status` alongside current proposals.
- Host-path versus guest-path mismatches can cause valid-looking approvals to fail application when the resolved paths differ.
