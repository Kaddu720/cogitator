# Testing

## Running unit tests

```bash
npx tsx extensions/tests/unit.ts
```

If `tsx` is not available, add it to `flake.nix` by creating a `devShells.default` output:

```nix
devShells.default = pkgs.mkShell {
  packages = [ pkgs.nodePackages.tsx ];
};
```

Then enter the dev shell with `nix develop` before running tests.

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
