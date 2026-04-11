/**
 * approvals/types.ts — shared types for the Cogitator approval subsystem.
 *
 * All other approvals/ modules import from here. No imports from sibling
 * approvals/ files or from extensions/ parents.
 *
 * Import direction:
 *   workflow-mode.ts → approvals/parse.ts → approvals/types.ts
 *   workflow-mode.ts → approvals/format.ts → approvals/types.ts
 *   workflow-mode.ts → approvals/policy.ts → approvals/types.ts
 *   workflow-mode.ts → approvals/state.ts  → approvals/types.ts
 */

export type ProposalStatus =
  | "pending"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "needs_revision"
  | "deferred";

export interface PendingProposal {
  id: string;
  index: number;
  total: number;
  /** Display path used in UI — may be relative or wrapped. */
  file: string;
  /** Raw path string as it appeared in the proposal block. */
  rawFile: string;
  /** Path after stripping quotes, backticks, and punctuation. */
  normalizedFile: string;
  proposedEdit: string;
  /** Absolute resolved path used for gating comparisons. */
  resolvedPath: string;
  /** cwd used when resolvedPath was computed. */
  resolutionBase: string;
  status: ProposalStatus;
  sequenceKey?: string;
  revisionNote?: string;
  deferredNote?: string;
  approvedAt?: string;
  applyingAt?: string;
  appliedAt?: string;
  deferredAt?: string;
}

export interface StoredApprovalGateState {
  pending: PendingProposal[];
  /** Legacy field from path-count tracking; preserved for migration only. */
  approvedPathCounts?: Record<string, number>;
}
