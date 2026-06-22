/**
 * approvals/state.ts — approval gate session persistence and proposal normalization.
 *
 * This module owns reading and writing approval state to the pi session branch.
 * It also handles the legacy migration from path-count tracking to proposal IDs.
 *
 * Import direction: workflow-mode.ts → approvals/state.ts → approvals/types.ts
 *                                                          → approvals/parse.ts
 *                                                          → ../projects.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PendingProposal, type StoredApprovalGateState } from "./types.js";
import { normalizePendingProposal } from "./parse.js";
import { type ResolutionOptions, getResolutionBase } from "../projects.js";

// ─── Legacy migration helpers ───────────────────────────────────────────────────

/**
 * Convert a legacy `{ path → count }` record into a Map for migration during
 * `normalizePendingProposals`. Ignores non-positive counts.
 */
export function recordToCounts(record: Record<string, number> | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!record || typeof record !== "object") return counts;
  for (const [path, count] of Object.entries(record)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) counts.set(path, count);
  }
  return counts;
}

// ─── Proposal normalization ─────────────────────────────────────────────────────

/**
 * Normalize a raw pending-proposal array restored from session storage.
 *
 * - Deserializes each entry via `normalizePendingProposal`.
 * - Migrates any legacy `approvedPathCounts` entries by upgrading matching
 *   `pending` proposals to `approved` status.
 */
export function normalizePendingProposals(
  pending: unknown,
  resolutionBase: string,
  legacyApprovedPathCounts?: Record<string, number>,
): PendingProposal[] {
  if (!Array.isArray(pending)) return [];
  const approvedCounts = recordToCounts(legacyApprovedPathCounts);

  return pending
    .map((p) => normalizePendingProposal(p, resolutionBase))
    .filter((p): p is PendingProposal => p !== undefined && p.normalizedFile.length > 0 && p.resolvedPath.length > 0)
    .map((p) => {
      if (p.status !== "pending") return p;
      const remaining = approvedCounts.get(p.resolvedPath) ?? 0;
      if (remaining <= 0) return p;
      if (remaining === 1) { approvedCounts.delete(p.resolvedPath); }
      else { approvedCounts.set(p.resolvedPath, remaining - 1); }
      return { ...p, status: "approved" as const };
    });
}

// ─── Session persistence ────────────────────────────────────────────────────────

/**
 * Append the current pending proposal array to the pi session branch as a
 * custom `approval-gate` entry. The latest entry wins on restore.
 */
export function persistApprovalGateState(pi: ExtensionAPI, pending: PendingProposal[]): void {
  pi.appendEntry<StoredApprovalGateState>("approval-gate", { pending });
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
 * Convenience wrapper: restore the approval gate state and normalize the
 * pending proposals array in one call.
 */
export function restoreNormalizedProposals(ctx: ExtensionContext, cwd: string | undefined, options?: ResolutionOptions): PendingProposal[] {
  const stored = restoreApprovalGateState(ctx);
  const resolutionBase = getResolutionBase(cwd, options);
  return normalizePendingProposals(stored?.pending, resolutionBase, stored?.approvedPathCounts);
}
