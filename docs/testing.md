# Testing

## Running unit tests

The flake provides the pi packages the extensions import, so the tests run without
a manual `npm install`. From the repo root:

```bash
nix run .#test          # runs extensions/tests/unit.ts against the working tree
```

Or use the dev shell (`nodejs_24`, `tsx`, and a `cogitator-test` command):

```bash
nix develop
cogitator-test
```

Both stage a `node_modules` tree with `@earendil-works/pi-coding-agent` (+ nested
`pi-ai`/`pi-tui`/`pi-agent-core`) and set `"type": "module"` so Node loads the
ESM-only `pi-ai`; `tsx` resolves the `.js`-specifier `.ts` files. The runner exits
non-zero on any failure.

## Test structure

Tests live in `extensions/tests/unit.ts`. They use plain `node:assert` with no framework dependencies.

Coverage targets (pure functions only):
- `approvals/parse.ts`: `normalizeInputPath`, `extractPendingProposals`, `createProposalId`, `extractCompletedChanges`
- `approvals/format.ts`: `formatProposalSummary`, `formatProposalMenuLabel`, `formatProposalStatusCounts`, `isProposalStatus`
- `approvals/policy.ts`: `isProposalActionable`, `mergePendingProposals`, `markCompletedProposals`, `buildApprovalBlockedReason`
- `project-state.ts`: `buildProjectStatusSnapshot`, `upsertShutdownCheckpointSection`, `formatShutdownTimestamp`
- `resources.ts`: `isSafeCommand`, `formatMode`, `getModeDescriptor`, `getModeTools`

## Adding new tests

Add new `test(...)` calls to `unit.ts`. Each test should use `assert.strictEqual`, `assert.deepStrictEqual`, or `assert.ok`. The runner exits with code 1 on any failure.
