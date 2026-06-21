---
name: new-project
description: >
  Create a new cogitator project: scaffold a markdown state file in the project
  states directory and register it in INDEX.md. Use when the user runs /new-project
  or asks to "create/start a new project" and you have a project name (and optionally
  a description and Jira key). The /new-project command kicks this off with the inputs.
---

# Create a new project

You are creating a new project state file in the cogitator project states
directory and registering it in `INDEX.md`. State files are the source of truth;
each project is one markdown file. Do **not** invent a separate metadata file.

## Inputs

The kickoff message provides:

- **Project name** — human-readable title.
- **Suggested slug** — kebab-case filename stem. Use it unless it collides with an
  existing file or the user gave a Jira key (see below).
- **Description / scope** — may be empty; infer a concise scope or leave a clear
  placeholder rather than fabricating detail.
- **Jira key** — optional (e.g. `SRE-1234`). When present, prefer a slug of the
  form `<jira-key-lowercased>-<short-name>` (e.g. `sre-1234-ship-dns`), matching the
  existing naming convention in the directory.
- **Project states directory** — the absolute directory to write into.

## Procedure

1. **Pick the slug.** Honor the Jira-key convention above. Ensure
   `<states-dir>/<slug>.md` does not already exist (list the directory first). If it
   does, choose a distinct slug or stop and ask.
2. **Match the existing format.** Read one or two recent files in the states
   directory (and `INDEX.md`) to mirror the house style — do not impose a foreign
   template. State files generally include, in order: an `# <Title>` heading; a
   `## Executive Summary` opening with a `Status: **todo**` (or appropriate status)
   line and a one-paragraph summary; `## Background & Context`; `## Progress Tracking`
   with `todo`/`in_progress`/`blocked`/`done`/`deferred` bullet groups; and
   `## Next Steps`. Include the Jira key near the top when provided.
3. **Write `<states-dir>/<slug>.md`** with that structure, filling in the name,
   status (`todo` for a fresh project), description/scope, and a first concrete
   next step. Keep it concise; leave honest placeholders where you lack detail.
4. **Register it in `INDEX.md`.** Add a row/link for the new file under the
   appropriate section (e.g. the active/standalone section), matching the existing
   table or list format and status column. Do not reorder or rewrite unrelated
   entries.
5. **Report the slug** so the user can load it with `/project`.

## Guardrails

- Only create/modify the new `<slug>.md` and `INDEX.md`. Never edit other projects'
  state files.
- These files are Jira-synced. Match conventions exactly and keep edits minimal so
  the sync does not conflict.
- If the inputs are ambiguous (e.g. unclear slug, missing scope you cannot infer),
  ask one clarifying question before writing.
