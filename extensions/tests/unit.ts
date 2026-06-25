/**
 * extensions/tests/unit.ts — unit tests for pure functions.
 *
 * Run with: npx tsx extensions/tests/unit.ts
 * No framework dependencies — uses node:assert and manual tracking.
 */

import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Imports under test ─────────────────────────────────────────────────────────

import {
  normalizeInputPath,
  extractPendingProposals,
  createProposalId,
  createProposalVariantId,
  extractCompletedChanges,
  extractMessageText,
  extractAssistantText,
} from "../approvals/parse.js";

import {
  isProposalStatus,
  formatProposalSummary,
  formatProposalMenuLabel,
  formatProposalStatusCounts,
} from "../approvals/format.js";

import {
  isProposalActionable,
  mergePendingProposals,
  markCompletedProposals,
  describeProposalWorkflowState,
  transitionProposalStatus,
} from "../approvals/policy.js";

import {
  getSupersedableProposalsForPath,
  supersedeProposalsForPath,
} from "../approvals/actions.js";

import {
  buildProjectStatusSnapshot,
  buildWorkingMemorySnapshot,
  parseWorkingMemorySnapshotFromCheckpointText,
  upsertShutdownCheckpointSection,
  formatShutdownTimestamp,
  SHUTDOWN_CHECKPOINT_HEADING,
  SHUTDOWN_CHECKPOINT_START,
  SHUTDOWN_CHECKPOINT_END,
} from "../project-state.js";

import { loadProjects } from "../projects.js";

import {
  isBlockedInfraMutationCommand,
  isSafeCommand,
  formatMode,
  getModeDescriptor,
  getModeTools,
} from "../resources.js";

import {
  buildPromptInjectionSignature,
  shouldInjectPromptFragments,
  buildProjectContextSignature,
  shouldInjectProjectContext,
  buildApprovalSummary,
  emptyApprovalSummary,
  getApprovalMenuCandidates,
  getApprovalMenuActions,
} from "../workflow-mode.js";

import type { PendingProposal } from "../approvals/types.js";

// ─── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`FAIL: ${name}\n  ${message}`);
  }
}

// ─── Helper: make a minimal PendingProposal ─────────────────────────────────────

function makeProposal(overrides: Partial<PendingProposal> = {}): PendingProposal {
  return {
    id: "change-1-of-1-test-file-ts",
    index: 1,
    total: 1,
    file: "test-file.ts",
    rawFile: "test-file.ts",
    normalizedFile: "test-file.ts",
    proposedEdit: "Add a comment",
    resolvedPath: "/home/kaddu/.config/cogitator/test-file.ts",
    resolutionBase: "/home/kaddu/.config/cogitator",
    status: "pending",
    ...overrides,
  };
}

// ─── approvals/parse.ts ─────────────────────────────────────────────────────────

test("normalizeInputPath: strips backticks", () => {
  assert.strictEqual(normalizeInputPath("`foo/bar.ts`"), "foo/bar.ts");
});

test("normalizeInputPath: strips quotes", () => {
  assert.strictEqual(normalizeInputPath('"foo/bar.ts"'), "foo/bar.ts");
});

test("normalizeInputPath: strips trailing punctuation", () => {
  assert.strictEqual(normalizeInputPath("foo/bar.ts."), "foo/bar.ts");
  assert.strictEqual(normalizeInputPath("foo/bar.ts,"), "foo/bar.ts");
});

test("normalizeInputPath: strips leading @", () => {
  assert.strictEqual(normalizeInputPath("@foo/bar.ts"), "foo/bar.ts");
});

test("normalizeInputPath: collapses double slashes", () => {
  assert.strictEqual(normalizeInputPath("foo//bar///baz.ts"), "foo/bar/baz.ts");
});

test("normalizeInputPath: extracts markdown link target", () => {
  assert.strictEqual(normalizeInputPath("[README.md](README.md)"), "README.md");
  assert.strictEqual(
    normalizeInputPath("[skills/project-state-management.md](/workspace/skills/project-state-management.md)"),
    "/workspace/skills/project-state-management.md",
  );
});

test("normalizeInputPath: rejects leftover markdown syntax after normalization", () => {
  assert.strictEqual(normalizeInputPath("[README.md](README.md"), "");
});

test("normalizeInputPath: strips trailing slash", () => {
  assert.strictEqual(normalizeInputPath("foo/bar/"), "foo/bar");
});

test("normalizeInputPath: preserves root slash", () => {
  assert.strictEqual(normalizeInputPath("/"), "/");
});

test("normalizeInputPath: empty string", () => {
  assert.strictEqual(normalizeInputPath(""), "");
});

test("createProposalId: generates kebab slug", () => {
  const id = createProposalId(1, 3, "/home/kaddu/test-file.ts");
  assert.ok(id.startsWith("change-1-of-3-"));
  assert.ok(id.includes("test-file-ts"));
});

test("createProposalVariantId: no suffix for variant 1", () => {
  assert.strictEqual(createProposalVariantId("base-id", 1), "base-id");
});

test("createProposalVariantId: adds suffix for variant 2+", () => {
  assert.strictEqual(createProposalVariantId("base-id", 2), "base-id--2");
  assert.strictEqual(createProposalVariantId("base-id", 3), "base-id--3");
});

test("extractPendingProposals: extracts a single proposal", () => {
  const text = `
Change 1/1
File: extensions/resources.ts
Proposed edit: Add a constant
`;
  const proposals = extractPendingProposals(text, "/home/kaddu/.config/cogitator");
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].index, 1);
  assert.strictEqual(proposals[0].total, 1);
  assert.ok(proposals[0].normalizedFile.includes("extensions/resources.ts"));
  assert.strictEqual(proposals[0].proposedEdit, "Add a constant");
});

test("extractPendingProposals: extracts multiple proposals", () => {
  const text = `
Change 1/2
File: file-a.ts
Proposed edit: Edit A

Change 2/2
File: file-b.ts
Proposed edit: Edit B
`;
  const proposals = extractPendingProposals(text, "/tmp");
  assert.strictEqual(proposals.length, 2);
  assert.strictEqual(proposals[0].index, 1);
  assert.strictEqual(proposals[1].index, 2);
});

test("extractPendingProposals: extracts markdown-linked file targets", () => {
  const text = `
Change 1/1
File: [skills/project-state-management.md](/workspace/skills/project-state-management.md)
Proposed edit: Update loader-friendly summary guidance
`;
  const proposals = extractPendingProposals(text, "/tmp");
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].displayFile, "[skills/project-state-management.md](/workspace/skills/project-state-management.md)");
  assert.strictEqual(proposals[0].rawFile, "[skills/project-state-management.md](/workspace/skills/project-state-management.md)");
  assert.strictEqual(proposals[0].normalizedFile, "/workspace/skills/project-state-management.md");
  assert.strictEqual(proposals[0].resolvedPath, "/workspace/skills/project-state-management.md");
});

test("extractPendingProposals: deduplicates identical proposal blocks in one response", () => {
  const text = `
Change 2/2
File: cogitator/extensions/approvals/actions.ts
Proposed edit: Prefer canonical selectors

Change 2/2
File: cogitator/extensions/approvals/actions.ts
Proposed edit: Prefer canonical selectors
`;
  const proposals = extractPendingProposals(text, "/workspace");
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].displayFile, "cogitator/extensions/approvals/actions.ts");
  assert.strictEqual(proposals[0].normalizedFile, "cogitator/extensions/approvals/actions.ts");
});

test("extractPendingProposals: keeps completion marker separate from next proposal", () => {
  const text = `
Change 1/2 is complete.

Change 2/2
File: cogitator/extensions/approvals/actions.ts
Proposed edit: Prefer canonical selectors
`;
  const proposals = extractPendingProposals(text, "/workspace");
  const completed = extractCompletedChanges(text);
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].index, 2);
  assert.strictEqual(completed.length, 1);
  assert.deepStrictEqual(completed[0], { index: 1, total: 2 });
});

test("extractCompletedChanges: finds completion markers", () => {
  const text = "Change 1/2 is complete.\nSome text.\nChange 2/2 is complete.";
  const completed = extractCompletedChanges(text);
  assert.strictEqual(completed.length, 2);
  assert.deepStrictEqual(completed[0], { index: 1, total: 2 });
  assert.deepStrictEqual(completed[1], { index: 2, total: 2 });
});

test("extractCompletedChanges: returns empty for no markers", () => {
  assert.strictEqual(extractCompletedChanges("No markers here").length, 0);
});

test("extractMessageText: handles string", () => {
  assert.strictEqual(extractMessageText("hello"), "hello");
});

test("extractMessageText: handles content blocks array", () => {
  const blocks = [{ type: "text", text: "hello" }, { type: "text", text: "world" }];
  assert.strictEqual(extractMessageText(blocks), "hello\nworld");
});

test("extractAssistantText: finds last assistant message", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "first" },
    { role: "user", content: "continue" },
    { role: "assistant", content: "second" },
  ];
  assert.strictEqual(extractAssistantText(messages), "second");
});

// ─── approvals/format.ts ────────────────────────────────────────────────────────

test("isProposalStatus: recognizes valid statuses", () => {
  for (const s of ["pending", "approved", "applying", "applied", "rejected", "needs_revision", "deferred"]) {
    assert.ok(isProposalStatus(s), `expected ${s} to be valid`);
  }
});

test("isProposalStatus: rejects invalid values", () => {
  assert.ok(!isProposalStatus("unknown"));
  assert.ok(!isProposalStatus(null));
  assert.ok(!isProposalStatus(42));
});

test("formatProposalSummary: formats correctly", () => {
  const p = makeProposal({ index: 2, total: 3, file: "foo.ts", proposedEdit: "Do stuff" });
  assert.strictEqual(formatProposalSummary(p), "Change 2/3 · foo.ts — Do stuff");
});

test("formatProposalMenuLabel: compact format", () => {
  const p = makeProposal({ index: 1, total: 2 });
  assert.strictEqual(formatProposalMenuLabel(p), "Change 1/2");
});

test("formatProposalStatusCounts: empty", () => {
  assert.strictEqual(formatProposalStatusCounts([]), "none");
});

test("formatProposalStatusCounts: counts by status", () => {
  const proposals = [
    makeProposal({ id: "a", status: "applied" }),
    makeProposal({ id: "b", status: "applied" }),
    makeProposal({ id: "c", status: "pending" }),
  ];
  const result = formatProposalStatusCounts(proposals);
  assert.ok(result.includes("applied=2"));
  assert.ok(result.includes("pending=1"));
});

// ─── approvals/policy.ts ────────────────────────────────────────────────────────

test("isProposalActionable: true for pending with no blockers", () => {
  const p = makeProposal({ status: "pending" });
  assert.ok(isProposalActionable([p], p));
});

test("isProposalActionable: false for non-pending", () => {
  const p = makeProposal({ status: "approved" });
  assert.ok(!isProposalActionable([p], p));
});

test("isProposalActionable: false when earlier step is not applied", () => {
  const seq = "seq-key";
  const p1 = makeProposal({ id: "p1", index: 1, total: 2, status: "pending", sequenceKey: seq });
  const p2 = makeProposal({ id: "p2", index: 2, total: 2, status: "pending", sequenceKey: seq });
  assert.ok(isProposalActionable([p1, p2], p1));
  assert.ok(!isProposalActionable([p1, p2], p2));
});

test("markCompletedProposals: transitions approved to applied", () => {
  const p = makeProposal({ status: "approved" });
  const result = markCompletedProposals([p], "Change 1/1 is complete.");
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.proposals[0].status, "applied");
});

test("markCompletedProposals: ignores non-matching markers", () => {
  const p = makeProposal({ index: 2, total: 3, status: "approved" });
  const result = markCompletedProposals([p], "Change 1/3 is complete.");
  assert.strictEqual(result.count, 0);
  assert.strictEqual(result.proposals[0].status, "approved");
});

test("mergePendingProposals: adds new proposals", () => {
  const existing = [makeProposal({ id: "a", status: "applied" })];
  const incoming = [makeProposal({ id: "b", file: "other.ts", normalizedFile: "other.ts", resolvedPath: "/tmp/other.ts" })];
  const result = mergePendingProposals(existing, incoming);
  assert.ok(result.length >= 2);
});

test("describeProposalWorkflowState: actionable pending", () => {
  const p = makeProposal({ status: "pending" });
  assert.strictEqual(describeProposalWorkflowState(p, [p]), "actionable");
});

test("describeProposalWorkflowState: deferred with note", () => {
  const p = makeProposal({ status: "deferred", deferredNote: "later" });
  assert.strictEqual(describeProposalWorkflowState(p, [p]), "deferred: later");
});

// ─── project-state.ts ───────────────────────────────────────────────────────────

test("buildProjectStatusSnapshot: extracts executive status", () => {
  const md = `# Test\n\n## Executive Summary\n- Status: in_progress\n- Goal: Build things\n\n## Next Steps\n- Do X\n`;
  const snapshot = buildProjectStatusSnapshot(md);
  assert.strictEqual(snapshot.executiveStatus, "in_progress");
  assert.strictEqual(snapshot.goal, "Build things");
});

test("buildProjectStatusSnapshot: extracts next steps", () => {
  const md = `# Test\n\n## Executive Summary\n- Status: done\n\n## Next Steps\n- Step one\n- Step two\n`;
  const snapshot = buildProjectStatusSnapshot(md);
  assert.deepStrictEqual(snapshot.nextSteps, ["Step one", "Step two"]);
});

test("buildWorkingMemorySnapshot: extracts core fields", () => {
  const md = `# Test\n\n## Executive Summary\n- Status: in_progress\n- Goal: Build the thing\n\n## Current Context\n- Current focus:\n  - Investigate cluster state\n  - Reduce context burn\n\n## Architecture Decisions\n- decision: Use summary-first project loading\n  rationale: Save context\n  date: 2026-06-24\n  owner: User\n  status: done\n\n## Key File Locations\n- \`projectStates/example.md\`: state file\n- \`artifacts/example/notes.md\`: notes\n\n## Progress Tracking\n- blocked:\n  - Waiting on final review\n- done:\n  - Baseline captured\n\n## Next Steps\n- Implement helper\n- Add tests\n`;
  const memory = buildWorkingMemorySnapshot(md);
  assert.strictEqual(memory.objective, "Build the thing");
  assert.deepStrictEqual(memory.focus, ["Investigate cluster state", "Reduce context burn"]);
  assert.deepStrictEqual(memory.blockers, ["Waiting on final review"]);
  assert.deepStrictEqual(memory.decisions, ["Use summary-first project loading"]);
  assert.deepStrictEqual(memory.nextSteps, ["Implement helper", "Add tests"]);
  assert.deepStrictEqual(memory.keyFiles, ["projectStates/example.md", "artifacts/example/notes.md"]);
  assert.strictEqual(memory.source, "project-state-summary");
});

test("buildWorkingMemorySnapshot: enforces caps", () => {
  const md = `# Test\n\n## Executive Summary\n- Goal: Cap test\n\n## Current Context\n- Current focus:\n  - Focus 1\n  - Focus 2\n  - Focus 3\n  - Focus 4\n\n## Architecture Decisions\n- decision: D1\n  rationale: r\n  date: 2026-06-24\n  owner: U\n  status: done\n- decision: D2\n  rationale: r\n  date: 2026-06-24\n  owner: U\n  status: done\n- decision: D3\n  rationale: r\n  date: 2026-06-24\n  owner: U\n  status: done\n- decision: D4\n  rationale: r\n  date: 2026-06-24\n  owner: U\n  status: done\n\n## Key File Locations\n- \`a.md\`: a\n- \`b.md\`: b\n- \`c.md\`: c\n- \`d.md\`: d\n- \`e.md\`: e\n- \`f.md\`: f\n\n## Progress Tracking\n- blocked:\n  - B1\n  - B2\n  - B3\n  - B4\n\n## Next Steps\n- N1\n- N2\n- N3\n- N4\n`;
  const memory = buildWorkingMemorySnapshot(md);
  assert.deepStrictEqual(memory.focus, ["Focus 1", "Focus 2", "Focus 3"]);
  assert.deepStrictEqual(memory.blockers, ["B1", "B2", "B3"]);
  assert.deepStrictEqual(memory.decisions, ["D1", "D2", "D3"]);
  assert.deepStrictEqual(memory.nextSteps, ["N1", "N2", "N3"]);
  assert.deepStrictEqual(memory.keyFiles, ["a.md", "b.md", "c.md", "d.md", "e.md"]);
});

test("buildWorkingMemorySnapshot: handles missing sections", () => {
  const md = `# Test\n\n## Executive Summary\n- Status: todo\n`;
  const memory = buildWorkingMemorySnapshot(md);
  assert.strictEqual(memory.objective, "[none]");
  assert.deepStrictEqual(memory.focus, []);
  assert.deepStrictEqual(memory.blockers, []);
  assert.deepStrictEqual(memory.decisions, []);
  assert.deepStrictEqual(memory.nextSteps, []);
  assert.deepStrictEqual(memory.keyFiles, []);
});

test("upsertShutdownCheckpointSection: inserts when missing", () => {
  const original = "# Project\n\nSome content\n";
  const result = upsertShutdownCheckpointSection(original, "- key: value");
  assert.ok(result.includes(SHUTDOWN_CHECKPOINT_HEADING));
  assert.ok(result.includes(SHUTDOWN_CHECKPOINT_START));
  assert.ok(result.includes("- key: value"));
  assert.ok(result.includes(SHUTDOWN_CHECKPOINT_END));
});

test("upsertShutdownCheckpointSection: replaces when present", () => {
  const original = `# Project\n\n${SHUTDOWN_CHECKPOINT_HEADING}\n${SHUTDOWN_CHECKPOINT_START}\n- old: data\n${SHUTDOWN_CHECKPOINT_END}\n`;
  const result = upsertShutdownCheckpointSection(original, "- new: data");
  assert.ok(result.includes("- new: data"));
  assert.ok(!result.includes("- old: data"));
});

test("formatShutdownTimestamp: returns ISO-like string without millis", () => {
  const ts = formatShutdownTimestamp(new Date("2026-01-01T12:00:00.123Z"));
  assert.strictEqual(ts, "2026-01-01T12:00:00Z");
});

test("parseWorkingMemorySnapshotFromCheckpointText: restores persisted memory fields", () => {
  const checkpoint = `# Session Shutdown Checkpoint\n\n## Project Status Snapshot\n- executive_status: in_progress\n- goal: Build the thing\n- current_focus: Investigate cluster state | Reduce context burn\n- progress_counts: todo=1, in_progress=2\n- next_steps: Implement helper | Add tests\n- memory_objective: Build the thing\n- memory_focus: Investigate cluster state | Reduce context burn\n- memory_blockers: Waiting on final review\n- memory_decisions: Use summary-first project loading\n- memory_next_steps: Implement helper | Add tests\n- memory_key_files: projectStates/example.md | artifacts/example/notes.md\n- memory_source: checkpoint\n`;
  const memory = parseWorkingMemorySnapshotFromCheckpointText(checkpoint);
  assert.strictEqual(memory.objective, "Build the thing");
  assert.deepStrictEqual(memory.focus, ["Investigate cluster state", "Reduce context burn"]);
  assert.deepStrictEqual(memory.blockers, ["Waiting on final review"]);
  assert.deepStrictEqual(memory.decisions, ["Use summary-first project loading"]);
  assert.deepStrictEqual(memory.nextSteps, ["Implement helper", "Add tests"]);
  assert.deepStrictEqual(memory.keyFiles, ["projectStates/example.md", "artifacts/example/notes.md"]);
  assert.strictEqual(memory.source, "checkpoint");
});

test("parseWorkingMemorySnapshotFromCheckpointText: falls back to goal/current_focus/next_steps", () => {
  const checkpoint = `# Session Shutdown Checkpoint\n\n## Project Status Snapshot\n- goal: Fallback goal\n- current_focus: Focus 1 | Focus 2\n- next_steps: Next 1 | Next 2\n`;
  const memory = parseWorkingMemorySnapshotFromCheckpointText(checkpoint);
  assert.strictEqual(memory.objective, "Fallback goal");
  assert.deepStrictEqual(memory.focus, ["Focus 1", "Focus 2"]);
  assert.deepStrictEqual(memory.blockers, []);
  assert.deepStrictEqual(memory.decisions, []);
  assert.deepStrictEqual(memory.nextSteps, ["Next 1", "Next 2"]);
  assert.deepStrictEqual(memory.keyFiles, []);
  assert.strictEqual(memory.source, "checkpoint");
});

test("buildWorkingMemorySnapshot: provides display-ready empty markers", () => {
  const md = `# Test\n\n## Executive Summary\n- Goal: Inspect memory display\n`;
  const memory = buildWorkingMemorySnapshot(md);
  const display = {
    objective: memory.objective,
    focus: memory.focus.length > 0 ? memory.focus.join(" | ") : "[none]",
    blockers: memory.blockers.length > 0 ? memory.blockers.join(" | ") : "[none]",
    decisions: memory.decisions.length > 0 ? memory.decisions.join(" | ") : "[none]",
    nextSteps: memory.nextSteps.length > 0 ? memory.nextSteps.join(" | ") : "[none]",
    keyFiles: memory.keyFiles.length > 0 ? memory.keyFiles.join(" | ") : "[none]",
  };
  assert.deepStrictEqual(display, {
    objective: "Inspect memory display",
    focus: "[none]",
    blockers: "[none]",
    decisions: "[none]",
    nextSteps: "[none]",
    keyFiles: "[none]",
  });
});

test("buildWorkingMemorySnapshot: refreshed state replaces checkpoint-backed memory content", () => {
  const checkpoint = `# Session Shutdown Checkpoint\n\n## Project Status Snapshot\n- memory_objective: Old objective\n- memory_focus: Old focus\n- memory_blockers: Old blocker\n- memory_decisions: Old decision\n- memory_next_steps: Old next\n- memory_key_files: old.md\n- memory_source: checkpoint\n`;
  const restored = parseWorkingMemorySnapshotFromCheckpointText(checkpoint);
  const stateMd = `# Test\n\n## Executive Summary\n- Goal: New objective\n\n## Current Context\n- Current focus:\n  - New focus\n\n## Architecture Decisions\n- decision: New decision\n  rationale: r\n  date: 2026-06-24\n  owner: U\n  status: done\n\n## Key File Locations\n- \`new.md\`: new\n\n## Progress Tracking\n- blocked:\n  - New blocker\n\n## Next Steps\n- New next\n`;
  const refreshed = buildWorkingMemorySnapshot(stateMd);
  assert.strictEqual(restored.objective, "Old objective");
  assert.strictEqual(restored.source, "checkpoint");
  assert.strictEqual(refreshed.objective, "New objective");
  assert.deepStrictEqual(refreshed.focus, ["New focus"]);
  assert.deepStrictEqual(refreshed.blockers, ["New blocker"]);
  assert.deepStrictEqual(refreshed.decisions, ["New decision"]);
  assert.deepStrictEqual(refreshed.nextSteps, ["New next"]);
  assert.deepStrictEqual(refreshed.keyFiles, ["new.md"]);
  assert.strictEqual(refreshed.source, "project-state-summary");
});

// ─── resources.ts ───────────────────────────────────────────────────────────────

test("isSafeCommand: allows cat", () => {
  assert.ok(isSafeCommand("cat foo.txt"));
});

test("isSafeCommand: allows grep", () => {
  assert.ok(isSafeCommand("grep -r pattern ."));
});

test("isSafeCommand: blocks rm", () => {
  assert.ok(!isSafeCommand("rm -rf /tmp/test"));
});

test("isSafeCommand: blocks git push", () => {
  assert.ok(!isSafeCommand("git push origin main"));
});

test("isSafeCommand: allows git status", () => {
  assert.ok(isSafeCommand("git status"));
});

test("isSafeCommand: blocks unknown commands", () => {
  assert.ok(!isSafeCommand("someRandomCommand --flag"));
});

test("isBlockedInfraMutationCommand: blocks kubectl apply", () => {
  assert.ok(isBlockedInfraMutationCommand("kubectl apply -f deployment.yaml"));
});

test("isBlockedInfraMutationCommand: blocks helm upgrade", () => {
  assert.ok(isBlockedInfraMutationCommand("helm upgrade my-release ./chart"));
});

test("isBlockedInfraMutationCommand: blocks terraform apply", () => {
  assert.ok(isBlockedInfraMutationCommand("terraform apply -auto-approve"));
});

test("isBlockedInfraMutationCommand: allows kubectl get", () => {
  assert.ok(!isBlockedInfraMutationCommand("kubectl get pods -A"));
});

test("isBlockedInfraMutationCommand: allows helm status", () => {
  assert.ok(!isBlockedInfraMutationCommand("helm status my-release"));
});

test("isBlockedInfraMutationCommand: allows terraform state list", () => {
  assert.ok(!isBlockedInfraMutationCommand("terraform state list"));
});

test("formatMode: returns emoji + label", () => {
  assert.strictEqual(formatMode("plan"), "📋 plan");
  assert.strictEqual(formatMode("normal"), "✍ normal");
  assert.strictEqual(formatMode("readonly"), "🔒 readonly");
  assert.strictEqual(formatMode("creative"), "🎨 creative");
});

test("getModeDescriptor: returns correct descriptor for each mode", () => {
  for (const mode of ["plan", "normal", "readonly", "creative"] as const) {
    const desc = getModeDescriptor(mode);
    assert.strictEqual(desc.key, mode);
    assert.ok(typeof desc.label === "string");
    assert.ok(typeof desc.emoji === "string");
  }
});

test("getModeTools: readonly filters to read-only tools", () => {
  const all = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const filtered = getModeTools(all, "readonly");
  assert.ok(filtered.includes("read"));
  assert.ok(filtered.includes("grep"));
  assert.ok(!filtered.includes("bash"));
  assert.ok(!filtered.includes("write"));
  assert.ok(!filtered.includes("edit"));
});

test("getModeTools: normal returns all tools", () => {
  const all = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const filtered = getModeTools(all, "normal");
  assert.deepStrictEqual(filtered, all);
});

test("buildPromptInjectionSignature: stays stable for unchanged inputs", () => {
  const a = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "example-project",
    projectScopeOnly: true,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  const b = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "example-project",
    projectScopeOnly: true,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  assert.strictEqual(a, b);
  assert.strictEqual(shouldInjectPromptFragments(a, b), false);
});

test("buildPromptInjectionSignature: changes when mode or project changes", () => {
  const base = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "example-project",
    projectScopeOnly: true,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  const changedMode = buildPromptInjectionSignature({
    mode: "normal",
    modePromptPath: "/tmp/mode-normal.md",
    projectId: "example-project",
    projectScopeOnly: false,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  const changedProject = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "other-project",
    projectScopeOnly: true,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  assert.notStrictEqual(base, changedMode);
  assert.notStrictEqual(base, changedProject);
  assert.strictEqual(shouldInjectPromptFragments(base, changedMode), true);
  assert.strictEqual(shouldInjectPromptFragments(base, changedProject), true);
});

test("buildPromptInjectionSignature: changes when workspace context availability changes", () => {
  const withContext = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "example-project",
    projectScopeOnly: true,
    workspaceContextPath: "/tmp/workspace-context.md",
  });
  const withoutContext = buildPromptInjectionSignature({
    mode: "plan",
    modePromptPath: "/tmp/mode-plan.md",
    projectId: "example-project",
    projectScopeOnly: true,
    workspaceContextPath: null,
  });
  assert.notStrictEqual(withContext, withoutContext);
  assert.strictEqual(shouldInjectPromptFragments(withContext, withoutContext), true);
});

test("buildProjectContextSignature: stays stable for unchanged inputs", () => {
  const workingMemory = {
    objective: "Ship the workflow cleanup",
    focus: ["lazy context injection"],
    blockers: [],
    decisions: ["prefer compact summaries"],
    nextSteps: ["add tests"],
    keyFiles: ["cogitator/extensions/workflow-mode.ts"],
    source: "checkpoint" as const,
  };
  const a = buildProjectContextSignature({
    mode: "plan",
    projectId: "workflow-tool-research-codex-vs-pi-dev",
    workingMemory,
    approvalSummary: {
      actionable: 1,
      pending: 2,
      approved: 0,
      deferred: 0,
      needsRevision: 0,
      rejected: 0,
    },
  });
  const b = buildProjectContextSignature({
    mode: "plan",
    projectId: "workflow-tool-research-codex-vs-pi-dev",
    workingMemory,
    approvalSummary: {
      actionable: 1,
      pending: 2,
      approved: 0,
      deferred: 0,
      needsRevision: 0,
      rejected: 0,
    },
  });
  assert.strictEqual(a, b);
  assert.strictEqual(shouldInjectProjectContext(a, b), false);
});

test("buildProjectContextSignature: changes when project memory or approvals change", () => {
  const base = buildProjectContextSignature({
    mode: "plan",
    projectId: "workflow-tool-research-codex-vs-pi-dev",
    workingMemory: {
      objective: "Ship the workflow cleanup",
      focus: ["lazy context injection"],
      blockers: [],
      decisions: [],
      nextSteps: ["add tests"],
      keyFiles: ["cogitator/extensions/workflow-mode.ts"],
      source: "project-state-summary",
    },
    approvalSummary: {
      actionable: 1,
      pending: 1,
      approved: 0,
      deferred: 0,
      needsRevision: 0,
      rejected: 0,
    },
  });
  const changedMemory = buildProjectContextSignature({
    mode: "plan",
    projectId: "workflow-tool-research-codex-vs-pi-dev",
    workingMemory: {
      objective: "Ship the workflow cleanup",
      focus: ["lazy context injection", "approval hydration"],
      blockers: [],
      decisions: [],
      nextSteps: ["add tests"],
      keyFiles: ["cogitator/extensions/workflow-mode.ts"],
      source: "project-state-summary",
    },
    approvalSummary: {
      actionable: 1,
      pending: 1,
      approved: 0,
      deferred: 0,
      needsRevision: 0,
      rejected: 0,
    },
  });
  const changedApprovals = buildProjectContextSignature({
    mode: "plan",
    projectId: "workflow-tool-research-codex-vs-pi-dev",
    workingMemory: {
      objective: "Ship the workflow cleanup",
      focus: ["lazy context injection"],
      blockers: [],
      decisions: [],
      nextSteps: ["add tests"],
      keyFiles: ["cogitator/extensions/workflow-mode.ts"],
      source: "project-state-summary",
    },
    approvalSummary: {
      actionable: 0,
      pending: 0,
      approved: 1,
      deferred: 0,
      needsRevision: 0,
      rejected: 0,
    },
  });
  assert.notStrictEqual(base, changedMemory);
  assert.notStrictEqual(base, changedApprovals);
  assert.strictEqual(shouldInjectProjectContext(base, changedMemory), true);
  assert.strictEqual(shouldInjectProjectContext(base, changedApprovals), true);
});

test("emptyApprovalSummary: returns zeroed compact state", () => {
  assert.deepStrictEqual(emptyApprovalSummary(), {
    total: 0,
    actionable: 0,
    pending: 0,
    approved: 0,
    deferred: 0,
    needsRevision: 0,
    rejected: 0,
    items: [],
  });
});

test("buildApprovalSummary: builds compact counts and labels", () => {
  const proposals = [
    makeProposal({
      id: "change-1",
      index: 1,
      total: 2,
      file: "a.ts",
      proposedEdit: "Edit A",
      status: "pending",
    }),
    makeProposal({
      id: "change-2",
      index: 2,
      total: 2,
      file: "b.ts",
      proposedEdit: "Edit B",
      status: "approved",
    }),
    makeProposal({
      id: "change-3",
      index: 3,
      total: 3,
      file: "c.ts",
      proposedEdit: "Edit C",
      status: "deferred",
    }),
    makeProposal({
      id: "change-4",
      index: 4,
      total: 4,
      file: "d.ts",
      proposedEdit: "Edit D",
      status: "needs-revision",
    }),
    makeProposal({
      id: "change-5",
      index: 5,
      total: 5,
      file: "e.ts",
      proposedEdit: "Edit E",
      status: "rejected",
    }),
  ];
  const summary = buildApprovalSummary(proposals);
  assert.strictEqual(summary.total, 5);
  assert.strictEqual(summary.actionable, 1);
  assert.strictEqual(summary.pending, 1);
  assert.strictEqual(summary.approved, 1);
  assert.strictEqual(summary.deferred, 1);
  assert.strictEqual(summary.needsRevision, 1);
  assert.strictEqual(summary.rejected, 1);
  assert.deepStrictEqual(summary.items.map((item) => item.label), [
    "a.ts — Edit A",
    "b.ts — Edit B",
    "c.ts — Edit C",
    "d.ts — Edit D",
    "e.ts — Edit E",
  ]);
});

test("buildApprovalSummary: keeps compact labels free of proposal numbering", () => {
  const summary = buildApprovalSummary([
    makeProposal({
      id: "change-1",
      index: 7,
      total: 9,
      file: "workflow-mode.ts",
      proposedEdit: "Trim approval payloads",
      status: "pending",
    }),
  ]);
  assert.deepStrictEqual(summary.items.map((item) => item.label), [
    "workflow-mode.ts — Trim approval payloads",
  ]);
});

test("getApprovalMenuCandidates: includes pending and approved proposals only", () => {
  const proposals = [
    makeProposal({ id: "pending", status: "pending" }),
    makeProposal({ id: "approved", status: "approved" }),
    makeProposal({ id: "deferred", status: "deferred" }),
    makeProposal({ id: "rejected", status: "rejected" }),
    makeProposal({ id: "applied", status: "applied" }),
  ];
  assert.deepStrictEqual(getApprovalMenuCandidates(proposals).map((proposal) => proposal.id), ["pending", "approved"]);
});

test("getApprovalMenuActions: returns apply action for approved proposals", () => {
  assert.deepStrictEqual(getApprovalMenuActions(makeProposal({ status: "approved" })), ["Apply approved change", "Revise", "Defer"]);
  assert.deepStrictEqual(getApprovalMenuActions(makeProposal({ status: "pending" })), ["Approve", "Revise", "Defer"]);
});

test("getApprovalMenuCandidates: matches /approval-status resumable states", () => {
  const nonResumable = [
    makeProposal({ id: "deferred", status: "deferred" }),
    makeProposal({ id: "rejected", status: "rejected" }),
    makeProposal({ id: "applied", status: "applied" }),
    makeProposal({ id: "needs-revision", status: "needs_revision" }),
  ];
  assert.deepStrictEqual(getApprovalMenuCandidates(nonResumable).map((proposal) => proposal.id), []);

  const resumable = [
    makeProposal({ id: "approved", status: "approved" }),
    makeProposal({ id: "applied", status: "applied" }),
  ];
  assert.deepStrictEqual(getApprovalMenuCandidates(resumable).map((proposal) => proposal.id), ["approved"]);
});

test("isProposalStatus: recognizes superseded", () => {
  assert.strictEqual(isProposalStatus("superseded"), true);
});

test("transitionProposalStatus: stores supersession metadata", () => {
  const result = transitionProposalStatus(makeProposal({ id: "old-change" }), "superseded", {
    supersededById: "new-change",
    supersededReason: "Superseded by a newer proposal for the same file.",
  });
  assert.strictEqual(result.status, "superseded");
  assert.strictEqual(result.supersededById, "new-change");
  assert.strictEqual(result.supersededReason, "Superseded by a newer proposal for the same file.");
  assert.ok(result.supersededAt);
});

test("getSupersedableProposalsForPath: returns unresolved same-file proposals only", () => {
  const targetPath = "/tmp/example.ts";
  const deps = {
    proposals: () => [
      makeProposal({ id: "pending", resolvedPath: targetPath, status: "pending" }),
      makeProposal({ id: "approved", resolvedPath: targetPath, status: "approved" }),
      makeProposal({ id: "deferred", resolvedPath: targetPath, status: "deferred" }),
      makeProposal({ id: "applied", resolvedPath: targetPath, status: "applied" }),
      makeProposal({ id: "other-file", resolvedPath: "/tmp/other.ts", status: "pending" }),
    ],
    setProposals: () => {},
    persist: () => {},
    updateStatus: () => {},
  };
  const result = getSupersedableProposalsForPath(deps, targetPath, "approved");
  assert.deepStrictEqual(result.map((proposal) => proposal.id), ["pending", "deferred"]);
});

test("supersedeProposalsForPath: marks old same-file proposals superseded", () => {
  const targetPath = "/tmp/example.ts";
  let current = [
    makeProposal({ id: "old-pending", resolvedPath: targetPath, status: "pending" }),
    makeProposal({ id: "old-approved", resolvedPath: targetPath, status: "approved" }),
    makeProposal({ id: "new-change", resolvedPath: targetPath, status: "pending" }),
    makeProposal({ id: "other-file", resolvedPath: "/tmp/other.ts", status: "pending" }),
  ];
  const deps = {
    proposals: () => current,
    setProposals: (updated: PendingProposal[]) => { current = updated; },
    persist: () => {},
    updateStatus: () => {},
  };
  const matched = supersedeProposalsForPath(deps, targetPath, "new-change");
  assert.deepStrictEqual(matched.map((proposal) => proposal.id), ["old-pending", "old-approved"]);
  const superseded = current.filter((proposal) => proposal.status === "superseded");
  assert.deepStrictEqual(superseded.map((proposal) => proposal.id), ["old-pending", "old-approved"]);
  assert.ok(superseded.every((proposal) => proposal.supersededById === "new-change"));
  assert.strictEqual(current.find((proposal) => proposal.id === "new-change")?.status, "pending");
});

test("loadProjects: returns only indexed existing files in index order", async () => {
  const root = mkdtempSync(join(tmpdir(), "cogitator-projects-"));
  const previous = process.env.COGITATOR_PROJECT_STATES_DIR;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "INDEX.md"), [
      "# Project States Index",
      "",
      "## Standalone Active (`in_progress`)",
      "",
      "| Project | File | Last Date |",
      "|---|---|---|",
      "| Bravo Project | [bravo.md](bravo.md) | todo |",
      "| Alpha Project | [alpha.md](alpha.md) | finished |",
      "| Missing Project | [missing.md](missing.md) | to_do |",
      "",
      "## Deferred (Jira: On Hold)",
      "",
      "| Project | File | Last Date |",
      "|---|---|---|",
      "| Deferred Project | [deferred.md](deferred.md) | 2026-06-20 |",
      "",
    ].join("\n"));
    writeFileSync(join(root, "alpha.md"), "# Alpha Project\n\nStatus: **in_progress**\n");
    writeFileSync(join(root, "bravo.md"), "# Bravo Project\n\nStatus: **todo**\n");
    writeFileSync(join(root, "orphan.md"), "# Orphan Project\n\nStatus: **in_progress**\n");
    writeFileSync(join(root, "deferred.md"), "# Deferred Project\n\nStatus: **deferred**\n");
    process.env.COGITATOR_PROJECT_STATES_DIR = root;

    const projects = await loadProjects();
    assert.deepStrictEqual(projects.map((project) => project.id), ["bravo", "alpha", "deferred"]);
    assert.deepStrictEqual(projects.map((project) => project.name), ["Bravo Project", "Alpha Project", "Deferred Project"]);
    assert.deepStrictEqual(projects.map((project) => project.status), ["todo", "done", "deferred"]);
    assert.ok(projects.every((project) => project.statePath === join(root, `${project.id}.md`)));
  } finally {
    if (previous === undefined) delete process.env.COGITATOR_PROJECT_STATES_DIR;
    else process.env.COGITATOR_PROJECT_STATES_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Report ─────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failures.length > 0) {
  console.log("");
  for (const f of failures) console.log(f);
  console.log("");
  process.exit(1);
}
console.log("All tests passed.");
