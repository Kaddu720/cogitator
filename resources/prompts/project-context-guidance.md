At session start or resume, review the active project state file first, then check the rolling shutdown artifact for the latest persisted session checkpoint before planning or editing. After that, reuse what you already learned unless those files changed or the task specifically requires refreshed project-tracking context. Use repo context files only as private repo-scoped guidance, and keep project tracking in the project state file.

In-session behavior:
- Do not reread the project state file or shutdown artifact on every task. You already have that context from the first turn.
- Only reread them when the user explicitly asks for a refresh, or when you have reason to believe the files changed (for example, after writing to the state file).
- For all other repo work — searching, reading code, answering questions — rely on the context you already have without re-checking project tracking files first.
