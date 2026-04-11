# Project State Template

Use this template for project state files in Cogitator.

Design goals:
- keep project context compact, durable, and easy to resume
- preserve stable headings and canonical status vocabulary
- separate active work, backlog, validation, and deferred approval items
- support optional external metadata without turning the state file into workspace policy
- reserve system-managed runtime snapshots for a dedicated managed block

---

# <Project Name>

## Executive Summary
- Status: <todo|in_progress|blocked|done|deferred>
- Goal: <one-sentence definition of success>
- Updated: <YYYY-MM-DD>
- Owner: <name>

## Project Metadata
Include this section only when the project needs deterministic links to external systems or shared documentation.

- Jira Issue Key: <ABC-123>
- Jira Sync Scope: <comment-only|approved-scope>
- Confluence Page ID: <id>
- Confluence Page Title: <title>
- Confluence Space Key: <space>
- Confluence Base URL: <url>
- Confluence Sync Scope: <executive-summary-only|approved-scope>
- Systems We Run Files:
  - <path or identifier>

## Background & Context
- status: <todo|in_progress|blocked|done|deferred>
- repo(s):
  - <primary repo path>
  - <additional repo path>
- current focus:
  - <current workstream>
  - <current workstream>
- constraints:
  - <important operating constraint>
  - <important operating constraint>
- assumptions:
  - <assumption>
  - <assumption>

## Architecture Decisions
- decision: <short decision title>
  rationale: <why this decision was made>
  date: <YYYY-MM-DD>
  owner: <name>
  status: <proposed|done|superseded>

## Implementation Plan
- [ ] <planned implementation step>
- [ ] <planned implementation step>
- [x] <completed implementation step>

## Open Questions & Blockers
- status: <none|in_progress|blocked>
- <question, risk, dependency, or blocker>
- <question, risk, dependency, or blocker>

## Key File Locations
- `<path>`: <why it matters>
- `<path>`: <why it matters>

## Requested Backlog
- State files
  - <backlog item>
- Approval gate
  - <backlog item>
- Projects
  - <backlog item>
- UI / modes
  - <backlog item>
- Other
  - <backlog item>

## Progress Tracking
- todo:
  - <next actionable item>
  - <next actionable item>
- in_progress:
  - <active workstream>
- blocked:
  - <blocked item>
- done:
  - <completed milestone>
- deferred:
  - <intentionally postponed item>

## Deferred Approval Items
Use this section for changes intentionally postponed from the approval flow.

- proposal_id: <proposal-id>
  summary: <short proposal summary>
  files:
    - <path>
  deferred_at: <YYYY-MM-DD>
  reason: <why it was deferred>
  revisit_trigger: <what should cause this to be revisited>
  status: deferred

## Validation & Evidence
- validated:
  - <manual or automated validation result>
- evidence:
  - <command, test, screenshot, note, or artifact path>

## Next Steps
- <immediate next step>
- <immediate next step>

## Session Shutdown Checkpoint
This section is system-managed. Do not maintain it manually except when repairing a broken checkpoint block.

<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->
- saved_at: <ISO-8601 timestamp>
- mode: <normal|readonly|plan>
- session_file: <path>
- repo_root: <path>
- pending_proposals: <count>
- actionable_approval_steps: <count>
- proposal_status_counts: <summary>
- executive_status: <status>
- goal: <goal or [none]>
- current_focus: <focus summary or [none]>
- progress_counts: todo=<n>, in_progress=<n>, blocked=<n>, done=<n>, deferred=<n>
- next_steps: <single-line summary>
- artifact: <path>
<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:END -->

---

# Guidance

## Keep in the state file
Keep durable project-tracking information here:
- current goal and status
- active focus and constraints
- important decisions and rationale
- key file paths and artifacts
- actionable progress lists
- deferred approval records
- evidence that helps the next session resume quickly

## Do not put here
Do not use project state files for:
- global agent instructions
- tool usage rules
- approval protocol text
- workspace operating manuals
- environment-wide security or infrastructure standards unless they are project-specific constraints

## Status vocabulary
Use these canonical markers consistently where possible:
- `todo`
- `in_progress`
- `blocked`
- `done`
- `deferred`

## What belongs in `todo`
Put items here that are:
- actionable soon
- not currently blocked
- small enough to pick up directly in a working session

Examples:
- Implement deferred todo writing for approval-gate `Defer`
- Validate sequential approval gating for `Change 1/3 -> 2/3 -> 3/3`

## What belongs in `deferred`
Put items in `Progress Tracking -> deferred` when work is intentionally postponed.
These should usually also appear in `## Deferred Approval Items` if they originated from an approval decision.

Examples:
- Revisit README cleanup after approval-gate behavior stabilizes
- Delay nix store minimization until current workflow validation finishes

## Recommended deferred approval item format
When the approval flow chooses `Defer`, write both:
1. a short entry under `Progress Tracking -> deferred`
2. a structured record under `## Deferred Approval Items`

Suggested short entry:
- Revisit deferred change: <summary> (proposal <id>; files: <paths>)

## Maintenance guidance
- Keep heading order stable.
- Prefer bullets over prose outside the executive summary.
- Keep `Executive Summary` short and current.
- Update `Progress Tracking` and `Next Steps` frequently.
- Move stale todos to `deferred` instead of letting `todo` grow indefinitely.
- Record durable decisions in `Architecture Decisions` rather than burying them in `done`.
- Link important artifacts from `Key File Locations` or `Validation & Evidence`.
- Use optional metadata only when the project actually integrates with those systems.
