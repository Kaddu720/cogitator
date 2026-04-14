/**
 * approvals/actions.ts — approval query helpers, selector/mutation helpers,
 * and user-facing approve/reject/revise/defer action operations.
 *
 * All functions receive an ApprovalActionDeps first argument instead of
 * closing over session state. This keeps the module stateless and testable.
 *
 * Import direction: workflow-mode.ts → approvals/actions.ts → approvals/policy.ts
 *                                                            → approvals/parse.ts
 *                                                            → approvals/types.ts
 *
 * Do NOT import from workflow-mode.ts, runtime.ts, or persistApprovalGateState.
 * Persistence and status updates happen only through deps.persist() and
 * deps.updateStatus(ctx).
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type PendingProposal, type ProposalStatus } from "./types.js";
import { normalizeInputPath } from "./parse.js";
import { isProposalActionable, transitionProposalStatus } from "./policy.js";

// ─── Dependency contract ────────────────────────────────────────────────────────

/**
 * Minimal runtime callbacks needed by approval action helpers.
 * Callers build this object once and pass it to every function in this module.
 *
 * workflow-mode.ts builds it as:
 *
 *   const approvalDeps: ApprovalActionDeps = {
 *     proposals: ps,
 *     setProposals: (updated) => { state.pendingProposals = updated; },
 *     persist: persistApprovalState,
 *     updateStatus,
 *   };
 */
export interface ApprovalActionDeps {
  /** Return the current proposal array (typically `() => state.pendingProposals`). */
  proposals: () => PendingProposal[];
  /** Replace the proposal array in runtime state. */
  setProposals: (proposals: PendingProposal[]) => void;
  /** Persist approval state to session storage. */
  persist: () => void;
  /** Update the UI status line. */
  updateStatus: (ctx: ExtensionContext) => void;
}

// ─── Query helpers ──────────────────────────────────────────────────────────────

export function getPendingApprovalProposals(deps: ApprovalActionDeps): PendingProposal[] {
  return deps.proposals().filter((p) => p.status === "pending" && isProposalActionable(deps.proposals(), p));
}

export function getApprovedProposals(deps: ApprovalActionDeps): PendingProposal[] {
  return deps.proposals().filter((p) => p.status === "approved");
}

export function getApplyingProposals(deps: ApprovalActionDeps): PendingProposal[] {
  return deps.proposals().filter((p) => p.status === "applying");
}

export function getRejectableProposals(deps: ApprovalActionDeps): PendingProposal[] {
  return deps.proposals().filter((p) => p.status === "pending" || p.status === "approved" || p.status === "applying");
}

export function getProposalsForResolvedPath(deps: ApprovalActionDeps, resolvedPath: string): PendingProposal[] {
  return deps.proposals().filter((p) => p.resolvedPath === resolvedPath);
}

export function getAuthorizedProposalsForPath(deps: ApprovalActionDeps, resolvedPath: string): PendingProposal[] {
  return deps.proposals().filter((p) => p.resolvedPath === resolvedPath && (p.status === "approved" || p.status === "applying"));
}

export function findAuthorizedProposalForPath(deps: ApprovalActionDeps, resolvedPath: string): PendingProposal | undefined {
  const authorized = getAuthorizedProposalsForPath(deps, resolvedPath);
  return authorized.length === 1 ? authorized[0] : undefined;
}

// ─── Selector helpers ───────────────────────────────────────────────────────────

/** Return all selectors that can identify a proposal: id, index, "N/total", file paths. */
export function getProposalSelectors(proposal: PendingProposal): string[] {
  return [proposal.id, String(proposal.index), `${proposal.index}/${proposal.total}`, proposal.file, proposal.rawFile, proposal.normalizedFile, proposal.resolvedPath];
}

export function findProposalBySelector(deps: ApprovalActionDeps, selector: string, allowedStatuses: ProposalStatus[] = ["pending"]): PendingProposal | undefined {
  const normalizedSelector = normalizeInputPath(selector).toLowerCase();
  if (!normalizedSelector) return undefined;
  return deps.proposals().find((p) => allowedStatuses.includes(p.status) && getProposalSelectors(p).some((c) => normalizeInputPath(c).toLowerCase() === normalizedSelector));
}

/** Split a comma-separated selector list into individual selector strings. */
export function parseSelectorList(value: string): string[] {
  return value.split(",").map((e) => e.trim()).filter((e) => e.length > 0);
}

/** Return the proposal statuses that are valid sources for a transition to `status`. */
export function getAllowedStatusesForTransition(status: ProposalStatus): ProposalStatus[] {
  if (status === "approved") return ["pending"];
  if (status === "deferred") return ["pending", "approved", "applying", "needs_revision"];
  return ["pending", "approved", "applying"];
}

// ─── Mutation helpers ───────────────────────────────────────────────────────────

/**
 * Transition the proposals identified by `ids` to `status`.
 * Body change from workflow-mode.ts: replaces `state.pendingProposals = ps().map(...)`
 * with `deps.setProposals(deps.proposals().map(...))`.
 */
export function updateProposalStatusById(
  deps: ApprovalActionDeps,
  ids: string[],
  status: ProposalStatus,
  detail?: { revisionNote?: string; deferredNote?: string },
): void {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  deps.setProposals(deps.proposals().map((p) => idSet.has(p.id) ? transitionProposalStatus(p, status, detail) : p));
}

/** Transition proposals matching any of `selectors` to `status`. Returns the matched proposals. */
export function updateProposalStatusBySelectors(
  deps: ApprovalActionDeps,
  selectors: string[],
  status: ProposalStatus,
  detail?: { revisionNote?: string; deferredNote?: string },
): PendingProposal[] {
  const allowedStatuses = getAllowedStatusesForTransition(status);
  const matched: PendingProposal[] = [];
  for (const selector of selectors) {
    const proposal = findProposalBySelector(deps, selector, allowedStatuses);
    if (!proposal) continue;
    if (status === "approved" && !isProposalActionable(deps.proposals(), proposal)) continue;
    if (!matched.some((e) => e.id === proposal.id)) matched.push(proposal);
  }
  updateProposalStatusById(deps, matched.map((p) => p.id), status, detail);
  return matched;
}

/**
 * Return the unique authorized proposal for `resolvedPath` without mutating
 * proposal state. This keeps tool-call authorization non-sticky so a
 * successful file mutation followed by a resume/provider failure does not
 * leave the proposal wedged in `applying`.
 */
export function beginApplyingProposalForPath(
  deps: ApprovalActionDeps,
  resolvedPath: string,
  _ctx: ExtensionContext,
): PendingProposal | undefined {
  return findAuthorizedProposalForPath(deps, resolvedPath);
}

// ─── User-facing action operations ─────────────────────────────────────────────

export function approveSelectedProposals(deps: ApprovalActionDeps, ctx: ExtensionContext, selectors: string[]): string {
  const matched = updateProposalStatusBySelectors(deps, selectors, "approved");
  deps.persist(); deps.updateStatus(ctx);
  return matched.length > 0
    ? `Approved ${matched.length} proposal(s). Apply only the approved proposal(s) exactly as approved.`
    : "No pending proposal matched that selector. Use /approval-status to inspect available proposal ids.";
}

export function approvePendingProposals(deps: ApprovalActionDeps, ctx: ExtensionContext): string {
  const pending = getPendingApprovalProposals(deps);
  if (pending.length === 0) return "No pending proposals are awaiting approval.";
  if (pending.length > 1) return "Multiple pending proposals require individual approval. Use the approval menu to pick one proposal, or reply with approve <id>.";
  return approveSelectedProposals(deps, ctx, [pending[0].id]);
}

export function rejectSelectedProposals(deps: ApprovalActionDeps, ctx: ExtensionContext, selectors: string[]): string {
  const matched = updateProposalStatusBySelectors(deps, selectors, "rejected");
  deps.persist(); deps.updateStatus(ctx);
  return matched.length > 0
    ? `Rejected ${matched.length} proposal(s). Do not apply those proposals.`
    : "No pending or approved proposal matched that selector. Use /approval-status to inspect available proposal ids.";
}

export function rejectPendingProposals(deps: ApprovalActionDeps, ctx: ExtensionContext): string {
  const rejectable = getRejectableProposals(deps);
  if (rejectable.length === 0) return "No pending or approved proposals are awaiting a decision.";
  if (rejectable.length > 1) return "Multiple pending or approved proposals require an individual decision. Reply with reject <id> or /reject <id> to reject one specific proposal.";
  return rejectSelectedProposals(deps, ctx, [rejectable[0].id]);
}

export function requestSelectedProposalRevision(deps: ApprovalActionDeps, ctx: ExtensionContext, selectors: string[], detail?: string): string {
  const editRequest = detail && detail.trim().length > 0 ? detail.trim() : "Revise the proposal and ask again for approval.";
  const matched = updateProposalStatusBySelectors(deps, selectors, "needs_revision", { revisionNote: editRequest });
  deps.persist(); deps.updateStatus(ctx);
  return matched.length > 0
    ? `The selected proposal(s) need revision. ${editRequest}`
    : "No pending or approved proposal matched that selector. Use /approval-status to inspect available proposal ids.";
}

export function requestProposalRevision(deps: ApprovalActionDeps, ctx: ExtensionContext, detail?: string): string {
  const pending = getPendingApprovalProposals(deps);
  if (pending.length === 0) return "No pending proposals are awaiting revision.";
  if (pending.length > 1) return "Multiple pending proposals require an individual revision request. Use the approval menu to pick one proposal, or reply with edit <id>: <detail>.";
  return requestSelectedProposalRevision(deps, ctx, [pending[0].id], detail);
}

export function deferSelectedProposals(deps: ApprovalActionDeps, ctx: ExtensionContext, selectors: string[], detail?: string): string {
  const deferNote = detail && detail.trim().length > 0 ? detail.trim() : "Deferred for later follow-up.";
  const matched = updateProposalStatusBySelectors(deps, selectors, "deferred", { deferredNote: deferNote });
  deps.persist(); deps.updateStatus(ctx);
  return matched.length > 0
    ? `Deferred ${matched.length} proposal(s). ${deferNote}`
    : "No pending or approved proposal matched that selector. Use /approval-status to inspect available proposal ids.";
}

export function deferPendingProposals(deps: ApprovalActionDeps, ctx: ExtensionContext, detail?: string): string {
  const pending = getPendingApprovalProposals(deps);
  if (pending.length === 0) return "No pending proposals are awaiting a deferral decision.";
  if (pending.length > 1) return "Multiple pending proposals require an individual defer decision. Use the approval menu to pick one proposal first.";
  return deferSelectedProposals(deps, ctx, [pending[0].id], detail);
}
