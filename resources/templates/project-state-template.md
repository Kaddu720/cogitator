# Project State Template

Use this template for project state files in Cogitator.

Design goals:
- keep project context compact, durable, and easy to resume
- preserve stable headings and canonical status vocabulary
- make the first 200 lines a reliable default loader interface for summary-first resumes
- separate current work, durable decisions, and short actionable lists
- keep the system-managed shutdown snapshot in a dedicated block

---

# <Project Name>

## Executive Summary
- Status: <todo|in_progress|blocked|done|deferred>
- Goal: <one-sentence definition of success>
- Current phase/focus: <short current-work summary>
- Active blockers/open questions: <short summary or `[none]`>
- Latest important decision: <short summary or `[none]`>

## Current Context
- Primary repo: `<path>`
- Current focus:
  - <current workstream>
  - <current workstream>
- Constraints:
  - <important operating constraint>
- Assumptions:
  - <important assumption>

## Architecture Decisions
- decision: <short decision title>
  rationale: <why this decision was made>
  date: <YYYY-MM-DD>
  owner: <name>
  status: <proposed|done|superseded>

## Key File Locations
- `<path>`: <why it matters>
- `<path>`: <why it matters>

## Progress Tracking
- todo:
  - <next actionable item>
  - <next actionable item>
- in_progress:
  - <active workstream>
- blocked:
  - <blocked item or `None recorded.`>
- done:
  - <completed milestone>
- deferred:
  - <intentionally postponed item or `None recorded.`>

## Validation & Evidence
- validated:
  - <manual or automated validation result>
- evidence:
  - <command, test, note, or artifact path>

## Next Steps
- <immediate next step>
- <immediate next step>

## Loader-Friendly Summary Rule
Treat the first 200 lines of this file as the default loader interface.
Keep enough current information above line 200 for an agent to resume work without reading deeper sections in the common case.
That top section should cover status, goal, current focus, blockers/open questions, key decisions, key file locations, and next steps.
Move longer history, detailed notes, and low-signal archival material below the loader-facing section.

## Session Shutdown Checkpoint
This section is system-managed. Do not maintain it manually except when repairing a broken checkpoint block.

<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->
- saved_at: <ISO-8601 timestamp>
- mode: <normal|readonly|plan|creative>
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
- active focus, constraints, and assumptions
- important decisions and rationale
- key file paths and artifacts
- short actionable progress lists
- validation results that help the next session resume quickly

## Do not put here
Do not use project state files for:
- global agent instructions
- tool usage rules
- approval protocol text
- workspace operating manuals
- long implementation journals better kept in artifacts or commit history

## Status vocabulary
Use these canonical markers consistently where possible:
- `todo`
- `in_progress`
- `blocked`
- `done`
- `deferred`
