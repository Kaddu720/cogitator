/**
 * project-state.ts — project state markdown parsing, weekly summaries, and shutdown checkpoint utilities.
 *
 * This module owns:
 *   - Markdown section extraction helpers used to read project state files
 *   - buildProjectStatusSnapshot — parses a state.md into a structured snapshot
 *   - Weekly summary collection and formatting (WeeklySummaryState, collectWeeklySummaryStates, ...)
 *   - Shutdown checkpoint constants and upsertShutdownCheckpointSection
 *   - Text utilities shared by snapshot and checkpoint formatting (summarizeInline, summarizeItems)
 *   - formatShutdownTimestamp
 *
 * Import direction: workflow-mode.ts → project-state.ts → projects.ts (never the reverse).
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Mode } from "./runtime.js";
import { type ProjectRecord, getProjectStatePath, getProjectArtifactsPath, loadProjects, escapeRegExp } from "./projects.js";
import { type PendingProposal } from "./approvals/types.js";
import { formatProposalStatusCounts, formatProposalSummary } from "./approvals/format.js";

// ─── Shutdown checkpoint constants ─────────────────────────────────────────────

export const SHUTDOWN_CHECKPOINT_HEADING = "## Session Shutdown Checkpoint";
export const SHUTDOWN_CHECKPOINT_START = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->";
export const SHUTDOWN_CHECKPOINT_END = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:END -->";

// ─── Text utilities ─────────────────────────────────────────────────────────────
// These are small enough to live here for now; they will move to resources.ts in Phase 4.

export function summarizeInline(text: string, maxChars = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function summarizeItems(items: string[], maxChars = 240): string {
  if (items.length === 0) return "[none]";
  return summarizeInline(items.join(" | "), maxChars);
}

// ─── Markdown section extraction ────────────────────────────────────────────────

function extractMarkdownSection(markdown: string, heading: string): string {
  // No `/m` flag: with multiline mode `$` matches every line end, so a lazy
  // capture would stop after the first line. `(?:^|\n)` anchors the heading at a
  // line start; the capture runs to the next `## ` heading or end of document.
  const pattern = new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? "";
}

const SNAPSHOT_STATUS_TOKENS = ["in_progress", "todo", "blocked", "done", "deferred"] as const;

/** Find the first lifecycle status token near a `status:` label, tolerant of
 *  `- Status: x`, `Status: **x**`, and `- status: \`x\`` formats. */
function extractStatusToken(text: string): string {
  const pattern = new RegExp(`status[\`*:\\s]*\\b(${SNAPSHOT_STATUS_TOKENS.join("|")})\\b`, "i");
  return text.match(pattern)?.[1]?.toLowerCase() ?? "";
}

function extractTopLevelBulletValue(sectionText: string, label: string): string {
  const pattern = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.*)$`, "mi");
  return sectionText.match(pattern)?.[1]?.trim() ?? "";
}

function extractIndentedBulletsAfterLabel(sectionText: string, label: string): string[] {
  const lines = sectionText.split(/\r?\n/);
  const target = `- ${label}:`.toLowerCase();
  const items: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (!collecting) {
      if (line.trim().toLowerCase() === target) collecting = true;
      continue;
    }
    const bulletMatch = line.match(/^\s{2,}-\s+(.*)$/);
    if (bulletMatch) {
      const value = bulletMatch[1].trim();
      if (value) items.push(value);
      continue;
    }
    if (/^-\s+/.test(line.trim())) break;
    if (line.trim().length === 0) continue;
    break;
  }

  return items;
}

function parseCompactItemSummary(text: string): string[] {
  const normalized = text.trim();
  if (!normalized || normalized === "[none]") return [];
  return normalized.split("|").map((item) => item.trim()).filter(Boolean);
}

function parseProgressCounts(text: string): Record<string, number> {
  const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, deferred: 0 };
  for (const part of text.split(",")) {
    const match = part.trim().match(/^([a-z_]+)=(\d+)$/i);
    if (!match) continue;
    const key = match[1] as keyof typeof counts;
    if (key in counts) counts[key] = Number.parseInt(match[2], 10);
  }
  return counts;
}

function extractShutdownCheckpointBody(markdown: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(SHUTDOWN_CHECKPOINT_START)}\\n([\\s\\S]*?)\\n${escapeRegExp(SHUTDOWN_CHECKPOINT_END)}`,
    "m",
  );
  return markdown.match(pattern)?.[1]?.trim() ?? "";
}

// ─── Project status snapshot ────────────────────────────────────────────────────

export interface ProjectStatusSnapshot {
  executiveStatus: string;
  goal: string;
  currentFocus: string[];
  nextSteps: string[];
  progressCounts: Record<string, number>;
}

export interface WorkingMemorySnapshot {
  objective: string;
  focus: string[];
  blockers: string[];
  decisions: string[];
  nextSteps: string[];
  keyFiles: string[];
  source: "project-state-summary" | "checkpoint";
}

export function parseProjectStatusSnapshotFromCheckpointText(markdown: string): Partial<ProjectStatusSnapshot> {
  const snapshotSection = extractMarkdownSection(markdown, "Project Status Snapshot");
  const checkpointBody = extractShutdownCheckpointBody(markdown);
  const source = snapshotSection || checkpointBody;
  if (!source) return {};

  return {
    executiveStatus: extractTopLevelBulletValue(source, "executive_status") || undefined,
    goal: extractTopLevelBulletValue(source, "goal") || undefined,
    currentFocus: parseCompactItemSummary(extractTopLevelBulletValue(source, "current_focus")),
    nextSteps: parseCompactItemSummary(extractTopLevelBulletValue(source, "next_steps")),
    progressCounts: parseProgressCounts(extractTopLevelBulletValue(source, "progress_counts")),
  };
}

export function parseWorkingMemorySnapshotFromCheckpointText(markdown: string): Partial<WorkingMemorySnapshot> {
  const snapshotSection = extractMarkdownSection(markdown, "Project Status Snapshot");
  const checkpointBody = extractShutdownCheckpointBody(markdown);
  const source = snapshotSection || checkpointBody;
  if (!source) return {};

  return {
    objective: extractTopLevelBulletValue(source, "memory_objective") || extractTopLevelBulletValue(source, "goal") || undefined,
    focus: parseCompactItemSummary(extractTopLevelBulletValue(source, "memory_focus") || extractTopLevelBulletValue(source, "current_focus")),
    blockers: parseCompactItemSummary(extractTopLevelBulletValue(source, "memory_blockers")),
    decisions: parseCompactItemSummary(extractTopLevelBulletValue(source, "memory_decisions")),
    nextSteps: parseCompactItemSummary(extractTopLevelBulletValue(source, "memory_next_steps") || extractTopLevelBulletValue(source, "next_steps")),
    keyFiles: parseCompactItemSummary(extractTopLevelBulletValue(source, "memory_key_files")),
    source: "checkpoint",
  };
}

export function buildProjectStatusSnapshot(stateText: string): ProjectStatusSnapshot {
  const executiveSummary = extractMarkdownSection(stateText, "Executive Summary");
  const context = extractMarkdownSection(stateText, "Current Context") || extractMarkdownSection(stateText, "Background & Context");
  const progressTracking = extractMarkdownSection(stateText, "Progress Tracking");
  const nextStepsSection = extractMarkdownSection(stateText, "Next Steps");
  const checkpointSnapshot = parseProjectStatusSnapshotFromCheckpointText(stateText);
  const countItems = (label: string) => extractIndentedBulletsAfterLabel(progressTracking, label).length;
  const directCurrentFocus = extractIndentedBulletsAfterLabel(context, "current focus");
  const directNextSteps = nextStepsSection
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
  const hasProgressTracking = progressTracking.trim().length > 0;

  return {
    executiveStatus: extractStatusToken(executiveSummary) || extractTopLevelBulletValue(executiveSummary, "Status") || checkpointSnapshot.executiveStatus || "[unknown]",
    goal: extractTopLevelBulletValue(executiveSummary, "Goal") || checkpointSnapshot.goal || "[none]",
    currentFocus: directCurrentFocus.length > 0 ? directCurrentFocus : (checkpointSnapshot.currentFocus ?? []),
    nextSteps: directNextSteps.length > 0 ? directNextSteps : (checkpointSnapshot.nextSteps ?? []),
    progressCounts: hasProgressTracking
      ? {
          todo: countItems("todo"),
          in_progress: countItems("in_progress"),
          blocked: countItems("blocked"),
          done: countItems("done"),
          deferred: countItems("deferred"),
        }
      : (checkpointSnapshot.progressCounts ?? { todo: 0, in_progress: 0, blocked: 0, done: 0, deferred: 0 }),
  };
}

export function buildWorkingMemorySnapshot(stateText: string): WorkingMemorySnapshot {
  const executiveSummary = extractMarkdownSection(stateText, "Executive Summary");
  const context = extractMarkdownSection(stateText, "Current Context") || extractMarkdownSection(stateText, "Background & Context");
  const decisionsSection = extractMarkdownSection(stateText, "Architecture Decisions");
  const progressTracking = extractMarkdownSection(stateText, "Progress Tracking");
  const nextStepsSection = extractMarkdownSection(stateText, "Next Steps");
  const keyFileSection = extractMarkdownSection(stateText, "Key File Locations");

  const take = (items: string[], max: number) => items.filter(Boolean).slice(0, max);
  const nextSteps = take(
    nextStepsSection
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s+(.*)$/)?.[1]?.trim() ?? ""),
    3,
  );
  const keyFiles = take(
    keyFileSection
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s+`?([^`:\n]+(?:`?[^:\n]*)?)\s*:/)?.[1]?.replace(/`/g, "").trim() ?? "")
      .filter(Boolean),
    5,
  );
  const decisions = take(
    decisionsSection
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*-\s*decision:\s*(.*)$/i)?.[1]?.trim() ?? "")
      .filter(Boolean),
    3,
  );

  return {
    objective: extractTopLevelBulletValue(executiveSummary, "Goal") || "[none]",
    focus: take(extractIndentedBulletsAfterLabel(context, "current focus"), 3),
    blockers: take(extractIndentedBulletsAfterLabel(progressTracking, "blocked").filter((item) => item.trim().toLowerCase() !== "none recorded."), 3),
    decisions,
    nextSteps,
    keyFiles,
    source: "project-state-summary",
  };
}

// ─── Weekly summary ─────────────────────────────────────────────────────────────

export interface WeeklySummaryState {
  project: ProjectRecord;
  statePath: string;
  modifiedAt: Date;
  completedItems: string[];
  inProgressItems: string[];
  nextSteps: string[];
}

function extractProgressItems(stateText: string, label: string): string[] {
  return extractIndentedBulletsAfterLabel(
    extractMarkdownSection(stateText, "Progress Tracking"),
    label,
  ).filter((item) => item.trim().toLowerCase() !== "none recorded");
}

function normalizeWeeklySummaryItem(item: string): string {
  return item.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function collectWeeklySummaryStates(since: Date): Promise<WeeklySummaryState[]> {
  const projects = await loadProjects();
  const summaries: WeeklySummaryState[] = [];

  for (const project of projects) {
    const statePath = getProjectStatePath(project);
    try {
      const stats = await stat(statePath);
      if (stats.mtime < since) continue;
      const stateText = await readFile(statePath, "utf8");
      const statusSnapshot = buildProjectStatusSnapshot(stateText);
      summaries.push({
        project,
        statePath,
        modifiedAt: stats.mtime,
        completedItems: extractProgressItems(stateText, "done"),
        inProgressItems: extractProgressItems(stateText, "in_progress"),
        nextSteps: statusSnapshot.nextSteps,
      });
    } catch {
      // Ignore missing or unreadable state files.
    }
  }

  return summaries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export function collectTopWeeklySummaryItems(
  states: WeeklySummaryState[],
  key: "completedItems" | "inProgressItems" | "nextSteps",
  maxItems = 10,
  seen = new Set<string>(),
): string[] {
  const lines: string[] = [];
  const includeProjectName = states.length > 1;

  for (const state of states) {
    for (const item of state[key]) {
      const normalized = normalizeWeeklySummaryItem(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      lines.push(`${includeProjectName ? `[(${state.project.id}) ${state.project.name}] ` : ""}${item}`);
      if (lines.length >= maxItems) return lines;
    }
  }
  return lines;
}

export function formatWeeklySummaryBullets(items: string[], emptyMessage: string): string {
  if (items.length === 0) return `- ${emptyMessage}`;
  return items.map((item) => `- ${item}`).join("\n");
}

export function formatWeeklySummaryFilename(date = new Date()): string {
  return `weekly-summary-${date.toISOString().slice(0, 10)}.md`;
}

export function formatWeeklySummaryDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─── Shutdown checkpoint formatting ────────────────────────────────────────────

export function formatShutdownTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ─── Shutdown checkpoint orchestration ────────────────────────────────────────

/**
 * All runtime state needed to write a shutdown checkpoint artifact.
 * Callers pre-compute actionableProposalCount to avoid importing from approvals/policy.
 */
export interface ShutdownCheckpointInput {
  project: ProjectRecord;
  mode: Mode;
  repoRoot: string | undefined;
  canonicalCheckoutPath?: string;
  sessionFile: string;
  proposals: PendingProposal[];
  workingMemory?: WorkingMemorySnapshot | null;
  /** Pre-computed by caller: proposals.filter(p => p.status === 'pending' && isProposalActionable(...)).length */
  actionableProposalCount: number;
}

/**
 * Write the session shutdown checkpoint artifact and update the state file
 * checkpoint block. Extracted from workflow-mode.ts so all checkpoint
 * formatting lives in project-state.ts.
 */
export async function writeProjectShutdownCheckpoint(input: ShutdownCheckpointInput): Promise<void> {
  const { project, mode, repoRoot, canonicalCheckoutPath, sessionFile, proposals, workingMemory, actionableProposalCount } = input;
  const timestamp = formatShutdownTimestamp();
  const artifactsPath = getProjectArtifactsPath(project);
  const artifactPath = resolve(artifactsPath, "latest-shutdown.md");
  const statePath = getProjectStatePath(project);
  const proposalLines = proposals.length > 0
    ? proposals.map((p) => `- [${p.status}] ${formatProposalSummary(p)} (id: ${p.id})`).join("\n")
    : "- none";
  let stateText = `# ${project.name}\n`;
  try { stateText = await readFile(statePath, "utf8"); } catch { /* use fallback */ }
  const statusSnapshot = buildProjectStatusSnapshot(stateText);
  const memorySnapshot = workingMemory ?? buildWorkingMemorySnapshot(stateText);
  const progressCounts = Object.entries(statusSnapshot.progressCounts).map(([l, c]) => `${l}=${c}`).join(", ");
  const artifactContent = [
    "# Session Shutdown Checkpoint", "",
    `- saved_at: ${timestamp}`, `- project: (${project.id}) ${project.name}`,
    `- mode: ${mode}`, `- session_file: ${sessionFile}`, `- state_file: ${statePath}`,
    `- repo_root: ${repoRoot ?? "[none]"}`, `- canonical_checkout_path: ${canonicalCheckoutPath ?? "[none]"}`, `- pending_proposals: ${proposals.length}`,
    `- actionable_approval_steps: ${actionableProposalCount}`, `- proposal_status_counts: ${formatProposalStatusCounts(proposals)}`, "",
    "## Project Status Snapshot",
    `- executive_status: ${statusSnapshot.executiveStatus}`, `- goal: ${statusSnapshot.goal}`,
    `- current_focus: ${summarizeItems(statusSnapshot.currentFocus)}`, `- progress_counts: ${progressCounts}`,
    `- next_steps: ${summarizeItems(statusSnapshot.nextSteps)}`,
    `- memory_objective: ${memorySnapshot.objective}`,
    `- memory_focus: ${summarizeItems(memorySnapshot.focus)}`,
    `- memory_blockers: ${summarizeItems(memorySnapshot.blockers)}`,
    `- memory_decisions: ${summarizeItems(memorySnapshot.decisions)}`,
    `- memory_next_steps: ${summarizeItems(memorySnapshot.nextSteps)}`,
    `- memory_key_files: ${summarizeItems(memorySnapshot.keyFiles)}`,
    `- memory_source: ${memorySnapshot.source}`,
    "", "## Pending Proposals", proposalLines, "",
  ].join("\n");
  await mkdir(artifactsPath, { recursive: true });
  await writeFile(artifactPath, artifactContent, "utf8");
  // The checkpoint is written to the artifact only. The (Jira-synced) state file
  // is never mutated by cogitator; on resume we read this artifact instead.
}

/**
 * Insert or replace the shutdown checkpoint block in a state file.
 *
 * If the block already exists it is replaced in-place. If it does not exist
 * it is appended at the end of the file, separated by a blank line.
 */
export function upsertShutdownCheckpointSection(stateText: string, body: string): string {
  const block = `${SHUTDOWN_CHECKPOINT_HEADING}\n${SHUTDOWN_CHECKPOINT_START}\n${body.trimEnd()}\n${SHUTDOWN_CHECKPOINT_END}`;
  const pattern = new RegExp(
    `${escapeRegExp(SHUTDOWN_CHECKPOINT_HEADING)}\\n${escapeRegExp(SHUTDOWN_CHECKPOINT_START)}[\\s\\S]*?${escapeRegExp(SHUTDOWN_CHECKPOINT_END)}`,
    "m",
  );

  if (pattern.test(stateText)) {
    return `${stateText.replace(pattern, block).replace(/\s*$/, "")}\n`;
  }

  return `${stateText.replace(/\s*$/, "")}\n\n${block}\n`;
}
