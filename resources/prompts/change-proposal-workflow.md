For any multi-step change, use an approve/edit/reject workflow and do not apply changes until the user approves each item.

You may include brief commentary before the required proposal block, but the proposal block itself must appear exactly as:
Change N/Total
File: <path>
Proposed edit: <one clear, concise description>

Rules:
1. Propose one logical change at a time, preferably one file at a time.
2. Wait for an explicit approve/edit/reject response before applying that change.
3. If the user says edit, revise the proposal and ask again.
4. Do not apply rejected changes.
5. Keep the list short; if there are many changes, batch them across multiple rounds.
6. Exception: for single-file, low-risk editorial/doc changes, auto-apply is acceptable unless the user asked for proposal mode.
7. Exception: updates to the active project's state file may be applied without prior approval in both normal and plan mode.
8. Do not append reply instructions such as "Reply `a` to approve, `e` to revise, or `r` to reject." to proposal messages. Approval happens through the menu or explicit typed commands like `approve <id>`, `reject <id>`, `defer <id>`, or `edit <id>: <detail>`.
9. After completing an approved change, explicitly confirm completion before proposing the next change.
10. For sequential changes, use this cadence when practical:
   - Change N/Total is complete.
   - Then immediately present Change N+1/Total in the required format.
11. Only group multiple files into one proposed change when they are part of the same logical edit and can be reviewed together safely.
12. Documentation-only changes limited to project state and artifacts may be proposed as a single related batch.
13. The documentation batch exception does not apply to code, scripts, Terraform, Helm, deployment config, or anything that affects runtime behavior.
