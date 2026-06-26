/**
 * approvals/state.ts — approval gate session persistence and compact summary restore.
 *
 * This module owns reading and writing approval state to the pi session branch.
 * Live proposal detail is intentionally not restored across resumed sessions.
 *
 * Import direction: workflow-mode.ts → approvals/state.ts → approvals/types.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PendingProposal, type StoredApprovalGateState, type StoredApprovalSummaryState } from "./types.js";
import { type ResolutionOptions } from "../projects.js";

// ─── Session persistence ────────────────────────────────────────────────────────

/**
 * Append the current pending proposal array to the pi session branch as a
 * custom `approval-gate` entry. The latest entry wins on restore.
 */
export function persistApprovalGateState(
  pi: ExtensionAPI,
  pending: PendingProposal[],
  summary?: StoredApprovalSummaryState,
): void {
  pi.appendEntry<StoredApprovalGateState>("approval-gate", { pending, summary });
}

/**
 * Restore the most recent `approval-gate` entry from the current session branch.
 * Returns `undefined` if no entry exists yet.
 */
export function restoreApprovalGateState(ctx: ExtensionContext): StoredApprovalGateState | undefined {
  let restored: StoredApprovalGateState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "approval-gate") {
      const data = entry.data as StoredApprovalGateState | undefined;
      if (data) restored = data;
    }
  }
  return restored;
}

/**
 * Restore live approval proposals for the current session.
 *
 * Approval proposal detail is intentionally not rehydrated from persisted
 * session-branch history. This avoids resurrecting stale historical proposals
 * into a fresh resumed session. Only compact summary state may be restored for
 * status display; live proposals begin empty and repopulate from new turns.
 */
export function restoreNormalizedProposals(_ctx: ExtensionContext, _cwd: string | undefined, _options?: ResolutionOptions): PendingProposal[] {
  return [];
}

export function restoreApprovalSummaryState(ctx: ExtensionContext): StoredApprovalSummaryState | undefined {
  return restoreApprovalGateState(ctx)?.summary;
}
