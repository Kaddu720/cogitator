/**
 * approvals/format.ts — pure display-string formatters for the approval subsystem.
 *
 * All functions are pure: no mutable state, no side effects, no imports from
 * sibling approvals/ files beyond types.ts.
 *
 * Import direction: workflow-mode.ts → approvals/format.ts → approvals/types.ts
 *                   approvals/policy.ts → approvals/format.ts → approvals/types.ts
 */

import { type PendingProposal, type ProposalStatus } from "./types.js";

// ─── Type guard ─────────────────────────────────────────────────────────────────

export function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    value === "pending" || value === "approved" || value === "applying" ||
    value === "applied" || value === "rejected" || value === "needs_revision" || value === "deferred"
  );
}

// ─── Proposal summary formatters ────────────────────────────────────────────────

/**
 * Single-line summary used in diagnostic output and shutdown checkpoints.
 * Example: `Change 2/3 · extensions/workflow-mode.ts — Add import from ./projects.js`
 */
export function formatProposalSummary(proposal: PendingProposal): string {
  return `Change ${proposal.index}/${proposal.total} · ${proposal.file} — ${proposal.proposedEdit}`;
}

/**
 * Compact label shown in the approval-menu action picker.
 * Example: `Change 2/3`
 */
export function formatProposalMenuLabel(proposal: PendingProposal): string {
  return `Change ${proposal.index}/${proposal.total}`;
}

// ─── Status count summary ───────────────────────────────────────────────────────

/**
 * Summarize a proposal array as a comma-separated `status=count` string.
 * Returns `"none"` for an empty array.
 * Example: `applied=16, applying=1`
 */
export function formatProposalStatusCounts(proposals: PendingProposal[]): string {
  if (proposals.length === 0) return "none";
  const counts = new Map<ProposalStatus, number>();
  for (const p of proposals) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, c]) => `${s}=${c}`)
    .join(", ");
}
