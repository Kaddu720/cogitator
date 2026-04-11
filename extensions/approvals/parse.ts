/**
 * approvals/parse.ts — proposal extraction, normalization, and ID generation.
 *
 * All functions are pure (no mutable state, no side effects). They extract
 * proposal data from assistant text and normalize raw path strings into the
 * resolved paths used for gating comparisons.
 *
 * Import direction: workflow-mode.ts → approvals/parse.ts → approvals/types.ts
 *                                                           → ../projects.ts
 */

import { isAbsolute, resolve } from "node:path";
import { type PendingProposal, type ProposalStatus } from "./types.js";
import { getResolutionBase, resolveFrom } from "../projects.js";

// ─── Path normalization ─────────────────────────────────────────────────────────

/**
 * Strip balanced wrapping tokens (backticks, quotes, brackets) from a path
 * string as it might appear in an assistant proposal block.
 */
function unwrapPathToken(path: string): string {
  const pairs: Array<readonly [string, string]> = [
    ["`", "`"], ['"', '"'], ["'", "'"], ["<", ">"], ["(", ")"], ["[", "]"],
  ];
  let value = path.trim();
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    for (const [start, end] of pairs) {
      if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
        value = value.slice(start.length, value.length - end.length).trim();
        changed = true;
      }
    }
  }
  return value;
}

/**
 * Normalize a raw path token extracted from a proposal block.
 *
 * Strips leading `@`, wrapping punctuation, trailing sentence punctuation,
 * and collapses repeated slashes. Also used by workflow-mode.ts to normalize
 * tool-call input paths before gating comparisons.
 */
export function normalizeInputPath(path: string): string {
  let normalized = unwrapPathToken(path);
  if (normalized.startsWith("@")) normalized = normalized.slice(1).trim();
  normalized = normalized.replace(/[.,;:!?]+$/, "").trim();
  if (normalized.length === 0) return normalized;
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

// ─── Proposal ID helpers ────────────────────────────────────────────────────────

export function createProposalId(index: number, total: number, resolvedPath: string): string {
  const slug = resolvedPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-48) || "path";
  return `change-${index}-of-${total}-${slug}`;
}

export function createProposalVariantId(baseId: string, variant: number): string {
  return variant <= 1 ? baseId : `${baseId}--${variant}`;
}

export function isProposalIdVariant(id: string, baseId: string): boolean {
  return id === baseId || id.startsWith(`${baseId}--`);
}

export function isSameProposalContent(a: PendingProposal, b: PendingProposal): boolean {
  return (
    a.index === b.index && a.total === b.total &&
    a.normalizedFile === b.normalizedFile && a.resolvedPath === b.resolvedPath &&
    a.proposedEdit === b.proposedEdit
  );
}

export function getProposalMergeReuseRank(proposal: PendingProposal): number {
  switch (proposal.status) {
    case "applying": return 0;
    case "approved": return 1;
    case "pending": return 2;
    case "needs_revision": return 3;
    case "deferred": return 4;
    default: return 5;
  }
}

/**
 * Find or generate a stable ID for merging a new proposal into an existing set.
 *
 * Re-uses an existing pending record if the content matches exactly.
 * Re-uses the active variant if one exists and has not been applied/rejected.
 * Otherwise allocates a new `--N` variant suffix.
 */
export function resolveProposalIdForMerge(proposal: PendingProposal, existing: Iterable<PendingProposal>): string {
  const baseId = createProposalId(proposal.index, proposal.total, proposal.resolvedPath);
  const related = Array.from(existing).filter((e) => isProposalIdVariant(e.id, baseId));
  const reusable = related.find((e) => e.status === "pending" && isSameProposalContent(e, proposal));
  if (reusable) return reusable.id;

  const activeVariant = related
    .filter((e) => ["pending", "approved", "applying", "needs_revision", "deferred"].includes(e.status))
    .sort((a, b) => {
      const r = getProposalMergeReuseRank(a) - getProposalMergeReuseRank(b);
      return r !== 0 ? r : a.id.localeCompare(b.id);
    })[0];
  if (activeVariant) return activeVariant.id;

  const usedIds = new Set(related.map((e) => e.id));
  let variant = 1;
  let candidate = createProposalVariantId(baseId, variant);
  while (usedIds.has(candidate)) { variant += 1; candidate = createProposalVariantId(baseId, variant); }
  return candidate;
}

export function createProposalSequenceKey(proposals: PendingProposal[]): string | undefined {
  if (proposals.length <= 1) return undefined;
  const total = proposals[0]?.total ?? 0;
  if (total <= 1) return undefined;
  const fingerprint = proposals.map((p) => `${p.index}:${p.normalizedFile}`).sort().join("|");
  const slug = fingerprint.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || `total-${total}`;
  return `sequence-${total}-${slug}`;
}

// ─── Proposal normalization ─────────────────────────────────────────────────────

function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    value === "pending" || value === "approved" || value === "applying" ||
    value === "applied" || value === "rejected" || value === "needs_revision" || value === "deferred"
  );
}

/**
 * Normalize a raw deserialized value into a `PendingProposal`, or return
 * `undefined` if the value is missing required fields.
 */
export function normalizePendingProposal(value: unknown, resolutionBase: string): PendingProposal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Record<string, unknown>;
  const index = Number(maybe.index);
  const total = Number(maybe.total);
  const rawFile =
    typeof maybe.rawFile === "string" ? maybe.rawFile.trim()
    : typeof maybe.file === "string" ? maybe.file.trim() : "";
  const normalizedFile = normalizeInputPath(rawFile);
  const proposedEdit = typeof maybe.proposedEdit === "string" ? maybe.proposedEdit.trim() : "";

  if (!Number.isFinite(index) || !Number.isFinite(total) || !rawFile || !normalizedFile || !proposedEdit) {
    return undefined;
  }

  const proposalBase =
    typeof maybe.resolutionBase === "string" && maybe.resolutionBase.trim().length > 0
      ? getResolutionBase(maybe.resolutionBase) : resolutionBase;
  const resolvedPath =
    typeof maybe.resolvedPath === "string" && maybe.resolvedPath.trim().length > 0
      ? resolve(maybe.resolvedPath) : resolveFrom(proposalBase, normalizedFile);
  const file =
    typeof maybe.file === "string" && maybe.file.trim().length > 0
      ? normalizeInputPath(maybe.file) || normalizedFile : normalizedFile;
  const id =
    typeof maybe.id === "string" && maybe.id.trim().length > 0
      ? maybe.id.trim() : createProposalId(index, total, resolvedPath);
  const status = isProposalStatus(maybe.status) ? maybe.status : "pending";
  const sq = (k: string) =>
    typeof maybe[k] === "string" && (maybe[k] as string).trim().length > 0 ? (maybe[k] as string).trim() : undefined;

  return {
    id, index, total, file, rawFile, normalizedFile, proposedEdit, resolvedPath,
    resolutionBase: proposalBase, status,
    sequenceKey: sq("sequenceKey"), revisionNote: sq("revisionNote"), deferredNote: sq("deferredNote"),
    approvedAt: sq("approvedAt"), applyingAt: sq("applyingAt"), appliedAt: sq("appliedAt"), deferredAt: sq("deferredAt"),
  };
}

// ─── Text extraction ────────────────────────────────────────────────────────────

/**
 * Extract all `Change N/Total / File: ... / Proposed edit: ...` proposal blocks
 * from assistant message text and return normalized proposals.
 */
export function extractPendingProposals(text: string, cwd: string | undefined, repoRoot?: string): PendingProposal[] {
  const proposals: PendingProposal[] = [];
  const resolutionBase = getResolutionBase(cwd, repoRoot);
  const pattern = /(?:^|\n)[ \t]*Change\s+(\d+)\/(\d+)\s*\n[ \t]*File:\s*(.+)\n[ \t]*Proposed edit:\s*(.+)(?=\n|$)/gm;

  for (const match of text.matchAll(pattern)) {
    const index = Number(match[1]);
    const total = Number(match[2]);
    const rawFile = match[3].trim();
    const proposedEdit = match[4].trim();
    const proposal = normalizePendingProposal(
      { index, total, file: rawFile, rawFile, proposedEdit, resolutionBase },
      resolutionBase,
    );
    if (proposal) proposals.push(proposal);
  }

  const groupedByTotal = new Map<number, PendingProposal[]>();
  for (const proposal of proposals) {
    const group = groupedByTotal.get(proposal.total);
    if (group) { group.push(proposal); } else { groupedByTotal.set(proposal.total, [proposal]); }
  }
  for (const group of groupedByTotal.values()) {
    const sequenceKey = createProposalSequenceKey(group);
    if (!sequenceKey) continue;
    for (const proposal of group) { proposal.sequenceKey = sequenceKey; }
  }

  return proposals;
}

// ─── Assistant message extraction ────────────────────────────────────────────────
// These helpers exist to feed extractPendingProposals and markCompletedProposals.
// Moved here from workflow-mode.ts so all assistant-text parsing lives in parse.ts.

/**
 * Extract plain text from a message content value, which may be a raw string
 * or an array of content blocks (OpenAI/Anthropic API format).
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: unknown; text?: unknown } => Boolean(b) && typeof b === "object")
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string).join("\n").trim();
  }
  return "";
}

/**
 * Scan the messages array from newest to oldest and return the text of the
 * most recent assistant message. Returns empty string if none is found.
 */
export function extractAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== "assistant") continue;
    const text = extractMessageText(m.content);
    if (text) return text;
  }
  return "";
}

/**
 * Extract `Change N/Total is complete.` markers from assistant text.
 * Returns an array of `{ index, total }` pairs.
 */
export function extractCompletedChanges(text: string): Array<{ index: number; total: number }> {
  const completed: Array<{ index: number; total: number }> = [];
  const pattern = /(?:^|\n)[ \t]*Change\s+(\d+)\/(\d+)\s+is\s+complete\.?[ \t]*(?=\n|$)/gm;
  for (const match of text.matchAll(pattern)) {
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isFinite(index) && Number.isFinite(total)) completed.push({ index, total });
  }
  return completed;
}
