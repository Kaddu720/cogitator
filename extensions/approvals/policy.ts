/**
 * approvals/policy.ts — approval gate logic and proposal state transitions.
 *
 * All functions take explicit `proposals: PendingProposal[]` parameters instead
 * of closing over mutable session state. Callers in workflow-mode.ts pass
 * `state.pendingProposals` and receive updated arrays or query results back.
 *
 * Import direction:
 *   workflow-mode.ts → approvals/policy.ts → approvals/types.ts
 *                                           → approvals/parse.ts
 *                                           → approvals/format.ts
 */

import { type PendingProposal, type ProposalStatus } from "./types.js";
import { extractCompletedChanges, resolveProposalIdForMerge } from "./parse.js";
import { formatProposalSummary } from "./format.js";

// ─── Status transitions ─────────────────────────────────────────────────────────

/**
 * Return a new proposal with the given status applied and the appropriate
 * timestamp field set. Does not mutate the input.
 */
export function transitionProposalStatus(
  proposal: PendingProposal,
  status: ProposalStatus,
  detail?: { revisionNote?: string; deferredNote?: string; supersededById?: string; supersededReason?: string },
): PendingProposal {
  const now = new Date().toISOString();
  if (status === "approved") return { ...proposal, status, approvedAt: now };
  if (status === "applying") return { ...proposal, status, applyingAt: now };
  if (status === "applied") return { ...proposal, status, appliedAt: now };
  if (status === "needs_revision") return { ...proposal, status, revisionNote: detail?.revisionNote ?? proposal.revisionNote };
  if (status === "deferred") return { ...proposal, status, deferredAt: now, deferredNote: detail?.deferredNote ?? proposal.deferredNote };
  if (status === "superseded") {
    return {
      ...proposal,
      status,
      supersededAt: now,
      supersededById: detail?.supersededById ?? proposal.supersededById,
      supersededReason: detail?.supersededReason ?? proposal.supersededReason,
    };
  }
  return { ...proposal, status };
}

// ─── Sequence helpers ───────────────────────────────────────────────────────────

/**
 * Return all proposals that belong to the given sequence key, sorted by index.
 */
export function getSequenceProposals(proposals: PendingProposal[], sequenceKey: string | undefined): PendingProposal[] {
  if (!sequenceKey) return [];
  return proposals
    .filter((p) => p.sequenceKey === sequenceKey)
    .sort((a, b) => a.index !== b.index ? a.index - b.index : a.id.localeCompare(b.id));
}

/**
 * Return the first earlier proposal in the same sequence that is not yet applied.
 * Returns `undefined` if the proposal can proceed immediately.
 */
export function getBlockingSequenceProposal(proposals: PendingProposal[], proposal: PendingProposal): PendingProposal | undefined {
  if (!proposal.sequenceKey || proposal.total <= 1) return undefined;
  return getSequenceProposals(proposals, proposal.sequenceKey).find(
    (c) => c.index < proposal.index && c.status !== "applied",
  );
}

/**
 * Return true if the proposal is pending and not blocked by an earlier step.
 */
export function isProposalActionable(proposals: PendingProposal[], proposal: PendingProposal): boolean {
  if (proposal.status !== "pending") return false;
  return !getBlockingSequenceProposal(proposals, proposal);
}

// ─── Workflow state description ─────────────────────────────────────────────────

/**
 * Return a short human-readable description of a proposal's workflow state for
 * use in diagnostic output and `/approval-status`.
 */
export function describeProposalWorkflowState(proposal: PendingProposal, proposals: PendingProposal[]): string {
  if (proposal.status === "pending") {
    const blocking = getBlockingSequenceProposal(proposals, proposal);
    return blocking ? `blocked by Change ${blocking.index}/${blocking.total}` : "actionable";
  }
  if (proposal.status === "needs_revision") return proposal.revisionNote ? `needs revision: ${proposal.revisionNote}` : "needs revision";
  if (proposal.status === "deferred") return proposal.deferredNote ? `deferred: ${proposal.deferredNote}` : "deferred";
  return proposal.status;
}

// ─── Approval gate diagnostic ───────────────────────────────────────────────────

/**
 * Build the detailed block message shown when a file mutation is denied by the
 * approval gate. Takes all current proposals and the pre-resolved resolution
 * base so it can be called without access to ExtensionContext.
 */
export function buildApprovalBlockedReason(
  requestedPath: string,
  proposals: PendingProposal[],
  resolutionBase: string,
  detail?: { toolName?: string; mutationSummary?: string },
): string {
  const lines = [
    "Transactional approval gate blocked this file mutation.",
    `Requested path: ${requestedPath}`,
    `Resolution base: ${resolutionBase}`,
  ];
  if (detail?.toolName) lines.push(`Requested tool: ${detail.toolName}`);
  if (detail?.mutationSummary) lines.push(`Requested mutation: ${detail.mutationSummary}`);

  const proposalsForPath = proposals.filter((p) => p.resolvedPath === requestedPath);
  const authorizedForPath = proposalsForPath.filter((p) => p.status === "approved" || p.status === "applying");

  if (authorizedForPath.length > 1) {
    lines.push("Multiple approved or applying proposals target this same path, so the intended change is ambiguous.");
    lines.push("Resolve the ambiguity by completing, rejecting, or revising the extra approved proposal(s) before mutating this file.");
  }

  if (proposalsForPath.length > 0) {
    lines.push("Recorded proposals for this path:");
    for (const p of proposalsForPath.slice(0, 5)) {
      lines.push(`- ${formatProposalSummary(p)} [${p.status}]`);
      lines.push(`  workflow=${describeProposalWorkflowState(p, proposals)}`);
      lines.push(`  id=${p.id}`);
    }
    if (proposalsForPath.length > 5) lines.push(`- ... ${proposalsForPath.length - 5} more proposal(s) for this path`);
  }

  if (authorizedForPath.length === 1) {
    lines.push("An approved or applying proposal exists for this path, but the approval gate could not safely match it to this mutation.");
  } else if (proposalsForPath.some((p) => p.status === "pending")) {
    lines.push("This path has a pending proposal, but it has not been approved yet.");
  } else if (proposalsForPath.length > 0) {
    lines.push("This path has recorded proposals, but none are currently approved for application.");
  }

  if (proposalsForPath.length === 0) {
    const approvedElsewhere = proposals.filter((p) => p.status === "approved" || p.status === "applying");
    if (approvedElsewhere.length > 0) {
      lines.push("Approved or applying proposals exist, but for different paths:");
      for (const p of approvedElsewhere.slice(0, 5)) {
        lines.push(`- ${formatProposalSummary(p)}`);
        lines.push(`  id=${p.id}`);
        lines.push(`  resolved=${p.resolvedPath}`);
      }
      if (approvedElsewhere.length > 5) lines.push(`- ... ${approvedElsewhere.length - 5} more approved proposal(s)`);
    }
    const pendingActionable = proposals.filter((p) => p.status === "pending" && isProposalActionable(proposals, p));
    if (pendingActionable.length > 0) {
      lines.push("Actionable proposals awaiting approval:");
      for (const p of pendingActionable.slice(0, 5)) {
        lines.push(`- ${formatProposalSummary(p)}`);
        lines.push(`  workflow=${describeProposalWorkflowState(p, proposals)}`);
        lines.push(`  id=${p.id}`);
        lines.push(`  resolved=${p.resolvedPath}`);
      }
      if (pendingActionable.length > 5) lines.push(`- ... ${pendingActionable.length - 5} more actionable proposal(s)`);
    } else if (approvedElsewhere.length === 0) {
      lines.push("No approved proposal matches this path.");
      lines.push("The assistant must first propose the change using:");
      lines.push("Change N/Total"); lines.push("File: <path>"); lines.push("Proposed edit: <summary>");
      lines.push("Then wait for user approval.");
    }
  }

  lines.push("Use /approval-status to inspect proposal ids, statuses, workflow state, and resolved paths.");
  lines.push("Approve from the menu when prompted, or reply with approve <id>, reject <id>, defer <id>, or edit <id>: <detail> for an individual proposal.");
  return lines.join("\n");
}

// ─── Array operations ───────────────────────────────────────────────────────────

/**
 * Scan assistant text for `Change N/Total is complete.` markers and return a
 * new proposals array with matching approved/applying proposals transitioned to
 * `applied`, plus a count of how many were changed.
 */
export function getCurrentProposalVariants(proposals: PendingProposal[]): PendingProposal[] {
  const unresolved = proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "approved" || proposal.status === "applying");
  const latestBySlot = new Map<string, PendingProposal>();
  for (const proposal of unresolved) {
    const slotKey = `${proposal.index}/${proposal.total}::${proposal.resolvedPath}`;
    const existing = latestBySlot.get(slotKey);
    if (!existing || proposal.id.localeCompare(existing.id) > 0) {
      latestBySlot.set(slotKey, proposal);
    }
  }
  return unresolved.filter((proposal) => latestBySlot.get(`${proposal.index}/${proposal.total}::${proposal.resolvedPath}`)?.id === proposal.id);
}

export function getResumableProposalSet(proposals: PendingProposal[]): PendingProposal[] {
  return getCurrentProposalVariants(proposals)
    .filter((proposal) => proposal.status === "pending" || proposal.status === "approved")
    .sort((a, b) => {
      if (a.total !== b.total) return a.total - b.total;
      if (a.index !== b.index) return a.index - b.index;
      return a.id.localeCompare(b.id);
    });
}

export function markCompletedProposals(
  proposals: PendingProposal[],
  text: string,
): { proposals: PendingProposal[]; count: number } {
  const completed = extractCompletedChanges(text);
  if (completed.length === 0) return { proposals, count: 0 };

  const authorizedCurrent = getCurrentProposalVariants(proposals).filter(
    (proposal) => proposal.status === "approved" || proposal.status === "applying",
  );
  const completionIds = new Set<string>();
  for (const entry of completed) {
    const matches = authorizedCurrent
      .filter((proposal) => proposal.index === entry.index && proposal.total === entry.total)
      .sort((a, b) => a.id.localeCompare(b.id));
    const newest = matches.at(-1);
    if (newest) completionIds.add(newest.id);
  }

  if (completionIds.size === 0) return { proposals, count: 0 };

  let count = 0;
  const updated = proposals.map((proposal) => {
    if (!completionIds.has(proposal.id)) return proposal;
    count += 1;
    return transitionProposalStatus(proposal, "applied");
  });
  return { proposals: updated, count };
}

/**
 * Merge a batch of freshly-extracted proposals into the current proposals array.
 *
 * Rules:
 * - Existing `needs_revision` and `deferred` statuses reset to `pending` when the
 *   same proposal content is seen again (the author revised and reposted).
 * - Existing `applied`, `rejected`, `approved`, `applying`, and `superseded`
 *   statuses are preserved.
 * - New proposals that don't match any existing ID get a stable variant suffix.
 *
 * Returns a new sorted array; does not mutate either input.
 */
export function mergePendingProposals(current: PendingProposal[], next: PendingProposal[]): PendingProposal[] {
  const unresolved = current.filter((proposal) => proposal.status === "pending" || proposal.status === "approved" || proposal.status === "applying");
  const merged = new Map(unresolved.map((proposal) => [proposal.id, proposal]));

  for (const proposal of next) {
    const proposalId = resolveProposalIdForMerge(proposal, merged.values());
    const existing = merged.get(proposalId);
    const existingStatus = existing?.status;
    const mergedStatus: ProposalStatus =
      !existing ? "pending"
      : existingStatus === "approved" || existingStatus === "applying" ? existingStatus
      : "pending";

    merged.set(proposalId, {
      ...proposal,
      id: proposalId,
      status: mergedStatus,
      sequenceKey: proposal.sequenceKey ?? existing?.sequenceKey,
      approvedAt: existing?.approvedAt,
      applyingAt: existing?.applyingAt,
    });
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.index !== b.index) return a.index - b.index;
    const fc = a.file.localeCompare(b.file);
    return fc !== 0 ? fc : a.id.localeCompare(b.id);
  });
}
