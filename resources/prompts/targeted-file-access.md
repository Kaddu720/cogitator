Use targeted file access. Prefer narrow, scoped reads over broad exploration.

Rules:
1. If the user already gave you an exact file path, read that file directly. Do not search for it again.
2. Otherwise, search before reading. Use `grep`, `find`, or `ls` to locate relevant files before opening them with `read`.
3. Use globs when searching. Always provide a `glob` pattern when running `grep` or `find` from a repo root or broad path (e.g. `*.ts`, `extensions/**/*.ts`). Catch-all globs like `*`, `**`, or `**/*` do not count as narrowing and will be rejected.
4. Use windowed reads for large files. When reading a large file, use `offset` and `limit` to read only the section you need. Do not read the whole file unless it is small. Never request more than 200 lines in a single `read` call, and prefer 100–150 lines by default unless you truly need more.
5. Do not sweep a file by reading it in sequential adjacent chunks. If you need to understand a large file, search first to find the relevant section, then read only that region. Adjacent windowed reads that cover the whole file will be blocked.
6. Do not reread unchanged files. If you already read a file in this session and nothing has changed, use what you already know. Rereading wastes context. Repeated full reads and repeated identical windowed reads on the same file will be blocked.
7. Do not scan the whole repo unless the user explicitly asks for broad research. Prefer targeted globs and specific paths.
8. Provide a reasonable `limit` when using `grep` or `find`. Do not omit it for repo-wide searches. Start with a small targeted limit — usually 20–60 for `grep` and 20–50 for `find`. Limits above 100 will be rejected. If the first search is insufficient, narrow the pattern or path before increasing the limit.
9. For `find`, a narrowing `pattern` (e.g. `**/*.ts`, `extensions/**/*.ts`) satisfies the glob requirement even when the search path is `.`.
10. Do not use bash for repo search or file inspection. Do not use `rg`, `grep -R`, `find .`, `ls -R`, `tree`, `nl -ba`, `sed -n`, or similar shell commands to search or inspect the repo. Use the structured `grep`, `find`, `read`, and `ls` tools instead. If the user explicitly asks to use bash for repo inspection, do not attempt bash first — briefly explain that bash repo inspection is blocked here, then switch directly to structured tools. Bash repo-search commands will be blocked even when chained with other commands.
11. Exception: the active project state file and rolling shutdown artifact are exempt from reread blocking. They may be reread when the user explicitly asks for a refresh or when the task requires updated project-tracking context.
12. Terraform and Helm: isolate the target structural block before reading, then bound your windowed `read` (rule 4) to the returned line numbers — never read sequential chunks without a structural boundary. Use the structured `grep` tool (not bash) to find the boundary:
    - Terraform (`*.tf`, HCL): find block headers with pattern `^(resource|module|data|variable|output|provider|locals)\b`, or target a specific block with `resource "[^"]+" "NAME"`. Read from the matched header line to the next header.
    - Helm chart templates (`**/templates/**/*.yaml`): find named template definitions with pattern `\{\{-?\s*define`. These files mix YAML with Go templating, so rely on these markers rather than YAML structure.
    - Helmfile / plain YAML (`helmfile.yaml`, `values.yaml`, manifests): grep for the top-level key (e.g. `^releases:`, `^<key>:`) to locate the block, then windowed-read it.
