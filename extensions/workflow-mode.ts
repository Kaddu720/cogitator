import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Mode, persistMode, restoreMode, persistProjectSelection, restoreStoredProjectId } from "./runtime.js";
import { registerCommands, type CommandHandlers, type ShortcutHandlers } from "./commands.js";
import { registerHooks, type HookHandlers } from "./hooks.js";
import {
  type ProjectRecord,
  getProjectStatesDir,
  getResolutionBase,
  resolveFrom,
  isSameOrWithin,
  fileExists,
  slugifyProjectId,
  getProjectStatePath,
  getProjectArtifactsPath,
  isApprovalExemptPath,
  loadProjects,
  buildProjectContext,
} from "./projects.js";
import {
  type WeeklySummaryState,
  writeProjectShutdownCheckpoint,
  collectWeeklySummaryStates,
  collectTopWeeklySummaryItems,
  formatWeeklySummaryBullets,
  formatWeeklySummaryFilename,
  formatWeeklySummaryDate,
  formatShutdownTimestamp,
} from "./project-state.js";
import { type PendingProposal, type ProposalStatus } from "./approvals/types.js";
import { normalizeInputPath, extractPendingProposals, extractMessageText, extractAssistantText } from "./approvals/parse.js";
import { formatProposalSummary, formatProposalMenuLabel } from "./approvals/format.js";
import {
  isProposalActionable,
  describeProposalWorkflowState,
  buildApprovalBlockedReason,
  markCompletedProposals,
  mergePendingProposals,
} from "./approvals/policy.js";
import { persistApprovalGateState, restoreNormalizedProposals } from "./approvals/state.js";
import {
  type ApprovalActionDeps,
  getPendingApprovalProposals,
  getApprovedProposals,
  getRejectableProposals,
  parseSelectorList,
  approveSelectedProposals,
  approvePendingProposals,
  rejectSelectedProposals,
  rejectPendingProposals,
  requestSelectedProposalRevision,
  requestProposalRevision,
  deferSelectedProposals,
  deferPendingProposals,
  beginApplyingProposalForPath,
} from "./approvals/actions.js";
import {
  JIRA_TMP_PREFIX,
  getModeTools,
  getModeDescriptor,
  getReadAccessPolicy,
  hasReasonableSearchLimit,
  isBroadInspectionBash,
  isBroadSearchPath,
  isSafeCommand,
  isWindowedReadRequest,
  getRequestedReadLimit,
  getRequestedSearchLimit,
  requiresSearchGlob,
  formatMode,
  projectStatusLine,
  readPromptFragment,
  CHANGE_PROPOSAL_WORKFLOW_PROMPT_PATH,
  SECRET_SAFETY_PROMPT_PATH,
  PROJECT_CONTEXT_GUIDANCE_PROMPT_PATH,
  TARGETED_FILE_ACCESS_PROMPT_PATH,
  COMPUTE_IN_VM_PROMPT_PATH,
} from "./resources.js";

// ─── Helpers retained in workflow-mode ─────────────────────────────────────────

async function getGitRoot(start: string | undefined): Promise<string | undefined> {
  let current = resolve(getResolutionBase(start));
  while (true) {
    if (await fileExists(resolve(current, ".git"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return undefined;
    current = parent;
  }
}


function describeMutation(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
  if (event.toolName === "write") { const c = typeof event.input.content === "string" ? event.input.content : ""; return `write ${c.length} byte(s)`; }
  if (event.toolName === "edit") { const e = Array.isArray(event.input.edits) ? event.input.edits : []; return `edit ${e.length} replacement block(s)`; }
  return undefined;
}

function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

// ─── Runtime state ──────────────────────────────────────────────────────────────

interface ReadLedgerEntry {
  fullRead: boolean;
  readCount: number;
  lastReadAt: number;
  lastWindowStart?: number;
  lastWindowEnd?: number;
  contiguousWindowedLines?: number;
}

interface WorkflowRuntimeState {
  currentMode: Mode;
  activeProject: ProjectRecord | null;
  activeRepoRoot?: string;
  pendingProposals: PendingProposal[];
  approvalPromptInFlight: boolean;
  approvalPromptDeferred: boolean;
  approvalResumePending: boolean;
  proposalOnlyRequested: boolean;
  readLedger: Map<string, ReadLedgerEntry>;
}

// ─── Extension entry point ──────────────────────────────────────────────────────

export default function workflowModeExtension(pi: ExtensionAPI): void {
  const planResearchTools = ["web_search", "fetch_content", "get_search_content", "code_search"];
  let baseTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const state: WorkflowRuntimeState = {
    currentMode: "plan",
    activeProject: null,
    activeRepoRoot: undefined,
    pendingProposals: [],
    approvalPromptInFlight: false,
    approvalPromptDeferred: false,
    approvalResumePending: false,
    proposalOnlyRequested: false,
    readLedger: new Map(),
  };

  // ─── Proposal state accessors ─────────────────────────────────────────────────

  const ps = () => state.pendingProposals;

  function getActiveToolsForMode(mode: Mode): string[] {
    const tools = getModeTools(baseTools, mode);
    if (mode !== "plan") return tools;
    return [...new Set([...tools, ...planResearchTools.filter((tool) => baseTools.includes(tool))])];
  }

  function persistApprovalState(): void { persistApprovalGateState(pi, ps()); }

  // ─── Read ledger helpers ──────────────────────────────────────────────────────

  function getReadLedgerPath(path: string, ctx: ExtensionContext): string {
    return resolveFrom(ctx.cwd, normalizeInputPath(path), state.activeRepoRoot);
  }

  function getRequestedReadWindow(input: Record<string, unknown>): { start: number; end: number; size: number } | null {
    const limit = getRequestedReadLimit(input);
    if (limit === undefined) return null;
    const offsetRaw = typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.trunc(input.offset) : 1;
    const start = offsetRaw > 0 ? offsetRaw : 1;
    return { start, end: start + limit - 1, size: limit };
  }

  function recordFullRead(path: string, ctx: ExtensionContext): ReadLedgerEntry {
    const resolvedPath = getReadLedgerPath(path, ctx);
    const next: ReadLedgerEntry = {
      fullRead: true,
      readCount: (state.readLedger.get(resolvedPath)?.readCount ?? 0) + 1,
      lastReadAt: Date.now(),
      lastWindowStart: undefined,
      lastWindowEnd: undefined,
      contiguousWindowedLines: undefined,
    };
    state.readLedger.set(resolvedPath, next);
    return next;
  }

  function wouldBecomeWindowedSweep(path: string, window: { start: number; end: number }, ctx: ExtensionContext, threshold: number): boolean {
    const resolvedPath = getReadLedgerPath(path, ctx);
    const previous = state.readLedger.get(resolvedPath);
    if (!previous || previous.fullRead || previous.lastWindowStart === undefined || previous.lastWindowEnd === undefined) return false;
    const adjacent = window.start <= previous.lastWindowEnd + 1 && window.end >= previous.lastWindowStart - 1;
    if (!adjacent) return false;
    const mergedStart = Math.min(previous.lastWindowStart, window.start);
    const mergedEnd = Math.max(previous.lastWindowEnd, window.end);
    return (mergedEnd - mergedStart + 1) > threshold;
  }

  function recordWindowedRead(path: string, window: { start: number; end: number; size: number }, ctx: ExtensionContext): ReadLedgerEntry {
    const resolvedPath = getReadLedgerPath(path, ctx);
    const previous = state.readLedger.get(resolvedPath);
    let lastWindowStart = window.start;
    let lastWindowEnd = window.end;
    let contiguousWindowedLines = window.size;
    if (previous && !previous.fullRead && previous.lastWindowStart !== undefined && previous.lastWindowEnd !== undefined) {
      const adjacent = window.start <= previous.lastWindowEnd + 1 && window.end >= previous.lastWindowStart - 1;
      if (adjacent) {
        lastWindowStart = Math.min(previous.lastWindowStart, window.start);
        lastWindowEnd = Math.max(previous.lastWindowEnd, window.end);
        contiguousWindowedLines = lastWindowEnd - lastWindowStart + 1;
      }
    }
    const next: ReadLedgerEntry = {
      fullRead: false,
      readCount: (previous?.readCount ?? 0) + 1,
      lastReadAt: Date.now(),
      lastWindowStart,
      lastWindowEnd,
      contiguousWindowedLines,
    };
    state.readLedger.set(resolvedPath, next);
    return next;
  }

  function hasRepeatedIdenticalTopWindowRead(path: string, window: { start: number; end: number }, ctx: ExtensionContext): boolean {
    const resolvedPath = getReadLedgerPath(path, ctx);
    const previous = state.readLedger.get(resolvedPath);
    if (!previous || previous.fullRead) return false;
    return previous.lastWindowStart === window.start && previous.lastWindowEnd === window.end && window.start === 1;
  }

  function hasRepeatedFullReread(path: string, ctx: ExtensionContext): boolean {
    const resolvedPath = getReadLedgerPath(path, ctx);
    return (state.readLedger.get(resolvedPath)?.fullRead ?? false) && (state.readLedger.get(resolvedPath)?.readCount ?? 0) > 0;
  }

  function isRefreshExemptReadPath(path: string, ctx: ExtensionContext): boolean {
    if (!state.activeProject) return false;
    const resolvedPath = getReadLedgerPath(path, ctx);
    const statePath = getProjectStatePath(state.activeProject);
    const shutdownArtifactPath = resolve(getProjectArtifactsPath(state.activeProject), "latest-shutdown.md");
    return resolvedPath === statePath || resolvedPath === shutdownArtifactPath;
  }

  // ─── Mode and status ───────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    let text = projectStatusLine(state.activeProject, state.currentMode);
    // Inline actionable count to avoid circular dependency with approvalDeps
    const awaitingApproval = state.pendingProposals.filter(
      (p) => p.status === "pending" && isProposalActionable(state.pendingProposals, p),
    ).length;
    if (awaitingApproval > 0) text += ` · awaiting approval ${awaitingApproval}`;
    const { themeColor } = getModeDescriptor(state.currentMode);
    const colored = ctx.ui.theme.fg(themeColor, text);
    ctx.ui.setStatus("cogitator", colored);
  }

  interface ModeModelTarget {
    provider: string;
    modelId: string;
  }

  interface ModeModelPair {
    primary: ModeModelTarget;
    alternate: ModeModelTarget;
  }

  const MODE_MODEL_PAIRS: Partial<Record<Mode, ModeModelPair>> = {
    plan: {
      primary: { provider: "anthropic", modelId: "claude-opus-4-6" },
      alternate: { provider: "azure", modelId: "gpt-5.4-kaddu" },
    },
    normal: {
      primary: { provider: "azure", modelId: "gpt-5.4-kaddu" },
      alternate: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    },
  };

  function getRestoredStartupMode(restoredMode: Mode | undefined): Mode {
    if (!restoredMode) return "plan";
    return getModeDescriptor(restoredMode).persistAcrossRestart ? restoredMode : "plan";
  }

  function getRestoredTreeMode(restoredMode: Mode | undefined): Mode {
    return restoredMode ?? "plan";
  }

  function isCurrentModelTarget(target: ModeModelTarget, ctx: ExtensionContext): boolean {
    return ctx.model?.provider === target.provider && ctx.model?.id === target.modelId;
  }

  function requiresAnthropicSafety(target: ModeModelTarget): boolean {
    return target.provider === "anthropic";
  }

  async function switchToModelTarget(
    target: ModeModelTarget,
    ctx: ExtensionContext,
    reason: string,
    notifyOnSuccess = false,
  ): Promise<boolean> {
    if (requiresAnthropicSafety(target) && !ctx.isIdle()) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Switched mode, but deferred model change to ${target.provider}/${target.modelId}. Anthropic model switching is only allowed at an idle turn boundary. Wait for the current turn to finish, then run /alt-model or switch modes again.`,
          "warning",
        );
      }
      return false;
    }

    const model = ctx.modelRegistry.find(target.provider, target.modelId);
    if (!model) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Switched mode, but ${target.provider}/${target.modelId} is not available in this session. Keeping the current model for ${reason}.`,
          "warning",
        );
      }
      return false;
    }

    const changed = await pi.setModel(model);
    if (!changed) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Switched mode, but pi could not activate ${target.provider}/${target.modelId}. Keeping the current model for ${reason}.`,
          "warning",
        );
      }
      return false;
    }

    if (notifyOnSuccess && ctx.hasUI) {
      const anthropicHint = requiresAnthropicSafety(target)
        ? " If Anthropic rejects inherited tool history, start a fresh branch/session before continuing."
        : "";
      ctx.ui.notify(`Model switched to ${target.provider}/${target.modelId} for ${reason}.${anthropicHint}`, "info");
    }
    return true;
  }

  async function applyModeDefaultModel(mode: Mode, ctx: ExtensionContext): Promise<void> {
    const pair = MODE_MODEL_PAIRS[mode];
    if (!pair) return;
    await switchToModelTarget(pair.primary, ctx, `${mode} mode`);
  }

  async function toggleAlternateModelForCurrentMode(ctx: ExtensionContext): Promise<void> {
    const pair = MODE_MODEL_PAIRS[state.currentMode];
    if (!pair) {
      if (ctx.hasUI) {
        const message = state.currentMode === "creative"
          ? "Creative mode does not define an alternate model. Use /model."
          : `Mode ${state.currentMode} does not define an alternate model.`;
        ctx.ui.notify(message, "info");
      }
      return;
    }

    const target = isCurrentModelTarget(pair.alternate, ctx) ? pair.primary : pair.alternate;
    await switchToModelTarget(target, ctx, `${state.currentMode} mode`, true);
  }

  async function applyMode(mode: Mode, ctx: ExtensionContext, notify = true): Promise<void> {
    state.currentMode = mode;
    pi.setActiveTools(getActiveToolsForMode(state.currentMode));
    persistMode(pi, state.currentMode);
    updateStatus(ctx);
    if (notify && ctx.hasUI) {
      const descriptor = getModeDescriptor(state.currentMode);
      ctx.ui.notify(descriptor.notification(state.activeProject), "info");
    }
    await applyModeDefaultModel(mode, ctx);
  }

  // ─── Approval action context ──────────────────────────────────────────────────

  const approvalDeps: ApprovalActionDeps = {
    proposals: ps,
    setProposals: (updated) => { state.pendingProposals = updated; },
    persist: persistApprovalState,
    updateStatus,
  };

  // ─── Approval UI orchestration ─────────────────────────────────────────────────

  function dispatchApprovalDecision(ctx: ExtensionContext, message: string): void {
    if (!message.trim()) return;
    if (ctx.isIdle()) { pi.sendUserMessage(message); return; }
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  async function promptForApproval(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || getPendingApprovalProposals(approvalDeps).length === 0 || state.approvalPromptInFlight) return;
    state.approvalPromptInFlight = true;
    try {
      const selectProposal = async (title: string): Promise<PendingProposal | undefined> => {
        const pending = getPendingApprovalProposals(approvalDeps);
        if (pending.length === 0) return undefined;
        const options = pending.map((p) => formatProposalMenuLabel(p));
        const choice = await ctx.ui.select(title, [...options, "Back"]);
        if (!choice || choice === "Back") return undefined;
        const index = options.indexOf(choice);
        return index >= 0 ? pending[index] : undefined;
      };
      while (getPendingApprovalProposals(approvalDeps).length > 0) {
        const proposalsNeedingApproval = getPendingApprovalProposals(approvalDeps);
        const proposal = proposalsNeedingApproval.length === 1 ? proposalsNeedingApproval[0] : await selectProposal("Choose a proposed change to review");
        if (!proposal) return;
        const choice = await ctx.ui.select(`Review the proposal in the transcript, then choose an action for ${formatProposalMenuLabel(proposal)}.`, ["Approve", "Revise", "Defer"]);
        if (!choice) return;
        state.approvalPromptDeferred = false;
        if (choice === "Approve") {
          const message = approveSelectedProposals(approvalDeps, ctx, [proposal.id]);
          state.approvalResumePending = true;
          ctx.ui.notify(message, "success");
          dispatchApprovalDecision(ctx, message);
          return;
        }
        if (choice === "Defer") { const note = await ctx.ui.input("Defer note", "Why should this proposal be deferred?"); const message = deferSelectedProposals(approvalDeps, ctx, [proposal.id], note); ctx.ui.notify(message, "info"); dispatchApprovalDecision(ctx, message); return; }
        const note = await ctx.ui.input("Revision request", "What should change before approval?");
        const message = requestSelectedProposalRevision(approvalDeps, ctx, [proposal.id], note);
        ctx.ui.notify(message, "info"); dispatchApprovalDecision(ctx, message); return;
      }
    } catch (error) {
      ctx.ui.notify(`Approval prompt failed: ${formatErrorDetails(error)}`, "warning");
    } finally { state.approvalPromptInFlight = false; }
  }

  // ─── Project management ────────────────────────────────────────────────────────

  async function setActiveProject(project: ProjectRecord | null, ctx: ExtensionContext, notify = true): Promise<void> {
    state.activeProject = project;
    persistProjectSelection(pi, project?.id ?? null);
    updateStatus(ctx);
    if (!notify || !ctx.hasUI) return;
    if (!project) { ctx.ui.notify("No project loaded for this session.", "info"); return; }
    ctx.ui.notify(`Loaded project: (${project.id}) ${project.name}`, "info");
  }

  async function selectProject(ctx: ExtensionContext, promptTitle = "Select project for this session"): Promise<void> {
    const projects = await loadProjects();
    state.activeRepoRoot = await getGitRoot(ctx.cwd);

    const NEW_PROJECT = "+ New project…";
    const NO_PROJECT = "No project";

    // INDEX.md order (active first); no repo matching in the markdown-first model.
    const options = projects.map((p) => `(${p.id}) ${p.name}${p.status ? ` · ${p.status}` : ""}`);
    options.push(NEW_PROJECT, NO_PROJECT);

    if (!ctx.hasUI) { await setActiveProject(null, ctx, false); return; }

    const choice = await ctx.ui.select(promptTitle, options);
    if (choice === NEW_PROJECT) { await commandHandlers["new-project"]("", ctx); return; }
    if (!choice || choice === NO_PROJECT) { await setActiveProject(null, ctx); return; }
    const index = options.indexOf(choice);
    await setActiveProject(projects[index] ?? null, ctx);
  }

  // ─── Command handler implementations ─────────────────────────────────────────

  const commandHandlers: CommandHandlers = {
    project: async (_args, ctx) => { await selectProject(ctx, "Select project"); },

    "new-project": async (args, ctx) => {
      if (!ctx.hasUI) return;
      const seed = typeof args === "string" ? args.trim() : Array.isArray(args) && args.every((e) => typeof e === "string") ? args.join(" ").trim() : "";
      const projectName = (((await ctx.ui.input("New project", "Project title / name")) ?? "").trim()) || seed;
      if (!projectName) { ctx.ui.notify("Project creation cancelled: a project name is required.", "warning"); return; }
      const suggestedSlug = slugifyProjectId(projectName);
      const existing = await loadProjects();
      const slugCollision = existing.some((p) => p.id === suggestedSlug);
      const description = ((await ctx.ui.input("Description", "Short description / scope (optional)")) ?? "").trim();
      const jiraKey = ((await ctx.ui.input("Jira key", "Jira issue key, e.g. SRE-1234 (optional)")) ?? "").trim();

      // Delegate file creation + INDEX.md update to the new-project skill so the
      // agent follows the project-state conventions (template + INDEX section).
      const directive = [
        "Run the new-project skill to scaffold a new project and register it. Inputs:",
        `- Project name: ${projectName}`,
        `- Suggested slug: ${suggestedSlug}${slugCollision ? " (a state file with this slug already exists — pick a distinct slug)" : ""}`,
        `- Description / scope: ${description || "(none provided — infer a brief scope or leave a clear placeholder)"}`,
        `- Jira key: ${jiraKey || "(none)"}`,
        `- Project states directory: ${getProjectStatesDir()}`,
        "Create <project states directory>/<slug>.md from the standard project-state template, add an INDEX.md row under the appropriate section, then report the new slug so it can be loaded with /project.",
      ].join("\n");

      ctx.ui.notify(`Starting the new-project skill for "${projectName}"…`, "info");
      if (ctx.isIdle()) pi.sendUserMessage(directive);
      else pi.sendUserMessage(directive, { deliverAs: "followUp" });
    },

    "project-status": async (_args, ctx) => {
      const lines = [`Mode: ${state.currentMode}`, `Project states: ${getProjectStatesDir()}`];
      if (state.activeRepoRoot) lines.push(`Repo root: ${state.activeRepoRoot}`);
      if (state.activeProject) { lines.push(`Project: (${state.activeProject.id}) ${state.activeProject.name}${state.activeProject.status ? ` · ${state.activeProject.status}` : ""}`); lines.push(`State: ${getProjectStatePath(state.activeProject)}`); lines.push(`Artifacts: ${getProjectArtifactsPath(state.activeProject)}`); }
      else { lines.push("Project: none"); }
      const needingApproval = getPendingApprovalProposals(approvalDeps);
      if (needingApproval.length > 0) { lines.push(`Pending approvals: ${needingApproval.length}`); for (const p of needingApproval) lines.push(`- Change ${p.index}/${p.total}: ${p.file} — ${p.proposedEdit} [${p.status}]`); }
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },

    "weekly-summary": async (_args, ctx) => {
      if (!state.activeProject) { if (ctx.hasUI) ctx.ui.notify("Load a project first with /project before generating a weekly summary.", "warning"); return; }
      const now = new Date();
      const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const states = await collectWeeklySummaryStates(since);
      const seen = new Set<string>();
      const completedItems = collectTopWeeklySummaryItems(states, "completedItems", 10, seen);
      const nextWeekItems = collectTopWeeklySummaryItems(states, "inProgressItems", 10, seen);
      if (nextWeekItems.length < 10) nextWeekItems.push(...collectTopWeeklySummaryItems(states, "nextSteps", 10 - nextWeekItems.length, seen));
      const artifactsPath = getProjectArtifactsPath(state.activeProject);
      const artifactPath = resolve(artifactsPath, formatWeeklySummaryFilename(now));
      const sourceLines = states.length > 0 ? states.map((s: WeeklySummaryState) => `- (${s.project.id}) ${s.project.name}: ${s.statePath} (updated ${formatShutdownTimestamp(s.modifiedAt)})`).join("\n") : "- none";
      const artifactContent = ["# Weekly Summary", "", `- generated_at: ${formatShutdownTimestamp(now)}`, `- window_start: ${formatWeeklySummaryDate(since)}`, `- window_end: ${formatWeeklySummaryDate(now)}`, `- active_project: (${state.activeProject.id}) ${state.activeProject.name}`, `- scanned_state_files: ${states.length}`, "", "## Top Completed This Week", formatWeeklySummaryBullets(completedItems, "No completed items were found in project state files updated during the last 7 days."), "", "## Top In Progress For Next Week", formatWeeklySummaryBullets(nextWeekItems, "No in-progress or next-step items were found in project state files updated during the last 7 days."), "", "## Source State Files", sourceLines, ""].join("\n");
      await mkdir(artifactsPath, { recursive: true });
      await writeFile(artifactPath, artifactContent, "utf8");
      if (ctx.hasUI) ctx.ui.notify([`Weekly summary written: ${artifactPath}`, `Completed items: ${completedItems.length}`, `Next-week items: ${nextWeekItems.length}`, `Scanned state files: ${states.length}`].join("\n"), "success");
    },

    "approval-status": async (_args, ctx) => {
      if (ps().length === 0) { if (ctx.hasUI) ctx.ui.notify("No change proposals recorded for this session.", "info"); return; }
      const lines = ["Change proposals:"];
      for (const p of ps()) {
        lines.push(formatProposalSummary(p));
        lines.push(`  id: ${p.id}`, `  status: ${p.status}`, `  workflow: ${describeProposalWorkflowState(p, ps())}`);
        lines.push(`  raw path: ${p.rawFile}`, `  normalized path: ${p.normalizedFile}`, `  resolved path: ${p.resolvedPath}`, `  resolution base: ${p.resolutionBase}`);
        if (p.revisionNote) lines.push(`  revision note: ${p.revisionNote}`);
        if (p.deferredNote) lines.push(`  deferred note: ${p.deferredNote}`);
      }
      lines.push("Use the approval menu when prompted. You can also reply with approve <id>, reject <id>, defer <id>, or edit <id>: <detail>. Selectors may use proposal ids, change numbers, or file paths.");
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },

    reject: async (args, ctx) => {
      const rawSelectors = typeof args === "string" ? args.trim() : Array.isArray(args) && args.every((e) => typeof e === "string") ? args.join(" ").trim() : "";
      const selectors = rawSelectors ? parseSelectorList(rawSelectors) : [];
      const message = selectors.length > 0 ? rejectSelectedProposals(approvalDeps, ctx, selectors) : rejectPendingProposals(approvalDeps, ctx);
      if (ctx.hasUI) ctx.ui.notify(message, message.startsWith("Rejected ") ? "success" : "info");
      dispatchApprovalDecision(ctx, message);
    },

    defer: async (args, ctx) => {
      const rawSelectors = typeof args === "string" ? args.trim() : Array.isArray(args) && args.every((e) => typeof e === "string") ? args.join(" ").trim() : "";
      const selectors = rawSelectors ? parseSelectorList(rawSelectors) : [];
      const message = selectors.length > 0 ? deferSelectedProposals(approvalDeps, ctx, selectors) : deferPendingProposals(approvalDeps, ctx);
      if (ctx.hasUI) ctx.ui.notify(message, message.startsWith("Deferred ") ? "success" : "info");
    },

    normal: async (_args, ctx) => applyMode("normal", ctx),
    readonly: async (_args, ctx) => applyMode(state.currentMode === "readonly" ? "normal" : "readonly", ctx),
    plan: async (_args, ctx) => applyMode(state.currentMode === "plan" ? "normal" : "plan", ctx),
    creative: async (_args, ctx) => applyMode("creative", ctx),
    "alt-model": async (_args, ctx) => toggleAlternateModelForCurrentMode(ctx),
  };

  const shortcutHandlers: ShortcutHandlers = {
    "ctrl+alt+p": async (ctx) => applyMode(state.currentMode === "plan" ? "normal" : "plan", ctx),
    "shift+tab": async (ctx) => applyMode(state.currentMode === "plan" ? "normal" : "plan", ctx),
    "ctrl+alt+r": async (ctx) => applyMode(state.currentMode === "readonly" ? "normal" : "readonly", ctx),
  };

  registerCommands(pi, commandHandlers, shortcutHandlers);

  const makeBashTool = (cwd: string) => createBashTool(cwd, { spawnHook: ({ command, cwd, env }) => ({ command, cwd, env: { ...env } }) });
  const baseBashTool = makeBashTool(process.cwd());
  pi.registerTool({ ...baseBashTool, execute: async (id, params, signal, onUpdate, ctx) => { const tool = makeBashTool(getResolutionBase(ctx.cwd, state.activeRepoRoot)); return tool.execute(id, params, signal, onUpdate); } });

  // ─── Lifecycle hook implementations ───────────────────────────────────────────

  const hookHandlers: HookHandlers = {
    session_start: async (_event, ctx) => {
      baseTools = Array.from(new Set(pi.getAllTools().map((t) => t.name)));
      state.activeRepoRoot = await getGitRoot(ctx.cwd);
      const restoredMode = restoreMode(ctx);
      state.currentMode = getRestoredStartupMode(restoredMode);
      state.pendingProposals = restoreNormalizedProposals(ctx, ctx.cwd, state.activeRepoRoot);
      const preferredProjectId = restoreStoredProjectId(ctx) ?? process.env.COGITATOR_PROJECT_ID;
      if (typeof preferredProjectId === "string") {
        const projects = await loadProjects();
        state.activeProject = projects.find((p) => p.id === preferredProjectId) ?? null;
        if (state.activeProject) persistProjectSelection(pi, state.activeProject.id);
      }
      if (ctx.hasUI && !state.activeProject) { await selectProject(ctx); }
      pi.setActiveTools(getActiveToolsForMode(state.currentMode));
      updateStatus(ctx);
    },

    session_tree: async (_event, ctx) => {
      baseTools = Array.from(new Set(pi.getAllTools().map((t) => t.name)));
      state.activeRepoRoot = await getGitRoot(ctx.cwd);
      const restoredMode = restoreMode(ctx);
      state.currentMode = getRestoredTreeMode(restoredMode);
      state.pendingProposals = restoreNormalizedProposals(ctx, ctx.cwd, state.activeRepoRoot);
      const restoredProjectId = restoreStoredProjectId(ctx);
      if (restoredProjectId === null) { state.activeProject = null; }
      else if (typeof restoredProjectId === "string") { const projects = await loadProjects(); state.activeProject = projects.find((p) => p.id === restoredProjectId) ?? null; }
      pi.setActiveTools(getActiveToolsForMode(state.currentMode));
      updateStatus(ctx);
    },

    session_shutdown: async (_event, ctx) => {
      if (!state.activeProject) return;
      try {
        await writeProjectShutdownCheckpoint({
          project: state.activeProject,
          mode: state.currentMode,
          repoRoot: state.activeRepoRoot,
          sessionFile: ctx.sessionManager.getSessionFile() ?? "ephemeral",
          proposals: ps(),
          actionableProposalCount: getPendingApprovalProposals(approvalDeps).length,
        });
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Failed to save shutdown checkpoint: ${String(error)}`, "warning"); }
    },

    input: async (event, ctx) => {
      const raw = event.text.trim();
      const lower = raw.toLowerCase();
      state.proposalOnlyRequested = /(do not apply( it)? yet|don't apply( it)? yet|proposal-only|proposal only)/i.test(raw);
      if (raw === "r" || lower === "reject") { state.approvalPromptDeferred = false; return { action: "transform" as const, text: rejectPendingProposals(approvalDeps, ctx) }; }
      const rejectMatch = raw.match(/^(r|reject)\s+(.+)$/i);
      if (rejectMatch) { state.approvalPromptDeferred = false; return { action: "transform" as const, text: rejectSelectedProposals(approvalDeps, ctx, parseSelectorList(rejectMatch[2])) }; }
      if (raw === "d" || lower === "defer") { state.approvalPromptDeferred = false; return { action: "transform" as const, text: deferPendingProposals(approvalDeps, ctx) }; }
      const deferMatch = raw.match(/^(d|defer)\s+(.+)$/i);
      if (deferMatch) { state.approvalPromptDeferred = false; return { action: "transform" as const, text: deferSelectedProposals(approvalDeps, ctx, parseSelectorList(deferMatch[2])) }; }
      if (getPendingApprovalProposals(approvalDeps).length === 0) {
        if (state.approvalResumePending && getApprovedProposals(approvalDeps).length > 0) { state.approvalResumePending = false; return { action: "continue" as const }; }
        state.approvalResumePending = false; return { action: "continue" as const };
      }
      if (raw === "a" || lower === "approve" || raw === "Approved. Apply only the previously proposed change set exactly as approved. Do not expand scope or modify other files.") {
        state.approvalPromptDeferred = false; return { action: "transform" as const, text: approvePendingProposals(approvalDeps, ctx) };
      }
      const approveMatch = raw.match(/^(a|approve)\s+(.+)$/i);
      if (approveMatch) { state.approvalPromptDeferred = false; return { action: "transform" as const, text: approveSelectedProposals(approvalDeps, ctx, parseSelectorList(approveMatch[2])) }; }
      if (raw === "e" || lower === "edit") { state.approvalPromptDeferred = false; return { action: "transform" as const, text: requestProposalRevision(approvalDeps, ctx) }; }
      const editMatch = raw.match(/^(e|edit)\s+([^:]+?)(?:\s*:\s*(.+))?$/i);
      if (editMatch) { state.approvalPromptDeferred = false; return { action: "transform" as const, text: requestSelectedProposalRevision(approvalDeps, ctx, parseSelectorList(editMatch[2]), editMatch[3]) }; }
      if (state.approvalResumePending && getApprovedProposals(approvalDeps).length > 0) { state.approvalResumePending = false; return { action: "continue" as const }; }
      state.approvalResumePending = false;
      if (ctx.hasUI && !state.approvalPromptDeferred) { await promptForApproval(ctx); return { action: "handled" as const }; }
      return { action: "continue" as const };
    },

    before_agent_start: async (event) => {
      const additions: string[] = [await readPromptFragment(CHANGE_PROPOSAL_WORKFLOW_PROMPT_PATH), await readPromptFragment(SECRET_SAFETY_PROMPT_PATH), await readPromptFragment(TARGETED_FILE_ACCESS_PROMPT_PATH), await readPromptFragment(COMPUTE_IN_VM_PROMPT_PATH)];
      const modeDescriptor = getModeDescriptor(state.currentMode);
      additions.push(await readPromptFragment(modeDescriptor.promptPath));
      if (modeDescriptor.writePolicy.projectScopeOnly && state.activeProject) {
        additions.push(`Active project write scope: state file ${getProjectStatePath(state.activeProject)}; artifacts directory ${getProjectArtifactsPath(state.activeProject)}; Jira closeout drafts ${JIRA_TMP_PREFIX}<ISSUE-KEY>.txt.`);
      }
      if (!state.activeProject) { if (additions.length === 0) return; return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` }; }
      additions.push(await readPromptFragment(PROJECT_CONTEXT_GUIDANCE_PROMPT_PATH));
      const message = { customType: "cogitator-project-context", content: await buildProjectContext(state.activeProject, event.cwd, state.activeRepoRoot, state.currentMode), display: false };
      if (additions.length === 0) return { message };
      return { message, systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
    },

    agent_end: async (event, ctx) => {
      try {
        const assistantText = extractAssistantText(event.messages as unknown[]);
        const markResult = markCompletedProposals(ps(), assistantText);
        const completedCount = markResult.count;
        if (completedCount > 0) { state.pendingProposals = markResult.proposals; }
        const proposals = extractPendingProposals(assistantText, ctx.cwd, state.activeRepoRoot);
        let stateChanged = completedCount > 0;
        if (completedCount > 0 && ctx.hasUI) ctx.ui.notify(`Marked ${completedCount} approved or applying proposal(s) complete.`, "success");
        if (proposals.length > 0) {
          state.pendingProposals = mergePendingProposals(ps(), proposals.map((p) => ({ ...p, status: "pending" as const })));
          state.approvalPromptDeferred = false; stateChanged = true;
        }
        if (stateChanged) { persistApprovalState(); updateStatus(ctx); }
        const actionableCount = getPendingApprovalProposals(approvalDeps).length;
        if (proposals.length > 0 && ctx.hasUI) {
          const actionableMessage = actionableCount > 0 ? `${actionableCount} actionable step(s) can be reviewed now.` : "No step is actionable yet; complete earlier approved steps first.";
          ctx.ui.notify(`Captured ${proposals.length} proposed change(s). ${actionableMessage}`, "info");
        }
        const shouldPromptForApproval = !state.proposalOnlyRequested && ctx.hasUI && !state.approvalPromptDeferred && actionableCount > 0 && (proposals.length > 0 || completedCount > 0);
        state.proposalOnlyRequested = false;
        if (shouldPromptForApproval) await promptForApproval(ctx);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Approval lifecycle handling failed after the turn: ${formatErrorDetails(error)}`, "warning");
      }
    },

    tool_call: async (event, ctx) => {
      try {
        if (event.toolName === "bash") {
          const command = String(event.input.command ?? "");
          if (/\bsops\b/i.test(command)) return { block: true, reason: "Access to the sops command is blocked." };
        }
        const toolDescriptor = getModeDescriptor(state.currentMode);
        const isMutationTool = event.toolName === "write" || event.toolName === "edit";
        const requestedPath = typeof event.input.path === "string" ? event.input.path : "";
        const resolvedPath = requestedPath ? resolveFrom(ctx.cwd, normalizeInputPath(requestedPath), state.activeRepoRoot) : "";

        // blocked modes: block ALL bash and ALL mutations (readonly)
        if (toolDescriptor.writePolicy.blocked) {
          if (event.toolName === "bash") return { block: true, reason: "Read-only mode blocks bash. Use /plan or /normal." };
          if (isMutationTool) return { block: true, reason: "Read-only mode blocks file mutations. Use /plan or /normal." };
          return;
        }

        if (event.toolName === "bash" && isBroadInspectionBash(String(event.input.command ?? ""))) {
          return {
            block: true,
            reason: "Use structured tools instead of broad shell inspection. Do not use bash rg/grep -R/find for repo search. Use grep/find directly with a narrowing glob and reasonable limit, then read only the relevant file section.",
          };
        }

        if (event.toolName === "read" && requestedPath) {
          const readPolicy = getReadAccessPolicy(state.currentMode);
          const refreshExempt = isRefreshExemptReadPath(requestedPath, ctx);
          const requestedLimit = getRequestedReadLimit(event.input);
          if (requestedLimit !== undefined && requestedLimit > readPolicy.maxDirectReadLines) {
            return {
              block: true,
              reason: `This read requests ${requestedLimit} lines, which is too broad for direct reading. Use read with offset and limit, keeping limit at or below ${readPolicy.maxDirectReadLines} lines.`,
            };
          }
          if (isWindowedReadRequest(event.input)) {
            const requestedWindow = getRequestedReadWindow(event.input);
            const sweepThreshold = Math.max(readPolicy.maxDirectReadLines * 2, readPolicy.requireWindowedReadAboveLines * 2);
            if (!refreshExempt && requestedWindow && hasRepeatedIdenticalTopWindowRead(requestedPath, requestedWindow, ctx)) {
              return {
                block: true,
                reason: "This file section was already read in the current session. Reuse what you already learned, or request a different narrower window if you need another part of the file.",
              };
            }
            if (!refreshExempt && requestedWindow && wouldBecomeWindowedSweep(requestedPath, requestedWindow, ctx, sweepThreshold)) {
              return {
                block: true,
                reason: "This sequence of adjacent windowed reads is turning into an effective whole-file sweep. Search first to narrow the relevant section, then read only the matching region with offset and limit.",
              };
            }
            if (requestedWindow) recordWindowedRead(requestedPath, requestedWindow, ctx);
            return;
          }
          if (!refreshExempt && readPolicy.blockRepeatedFullReads && hasRepeatedFullReread(requestedPath, ctx)) {
            return {
              block: true,
              reason: "This file was already fully read in the current session. Reuse what you already learned, or request a narrower read with offset/limit if you need a specific section.",
            };
          }
          recordFullRead(requestedPath, ctx);
          return;
        }

        if ((event.toolName === "grep" || event.toolName === "find")) {
          const broadSearch = isBroadSearchPath(event.input.path, ctx.cwd, state.activeRepoRoot);
          const requestedLimit = getRequestedSearchLimit(event.input);
          if (requiresSearchGlob(event.input, ctx.cwd, state.activeRepoRoot, state.currentMode, event.toolName === "find" ? "find" : "grep")) {
            return {
              block: true,
              reason: "Broad repo-wide search requires a glob. Add a glob such as extensions/**/*.ts or resources/**/*.md to narrow the search before reading files.",
            };
          }
          if (broadSearch && requestedLimit === undefined) {
            return {
              block: true,
              reason: "Broad repo-wide search requires an explicit limit. Add a reasonable limit so the search stays targeted.",
            };
          }
          if (!hasReasonableSearchLimit(event.input, state.currentMode)) {
            return {
              block: true,
              reason: "This search limit is too high. Use a smaller, targeted limit before expanding the search further.",
            };
          }
          if (event.toolName === "find") {
            const pattern = typeof event.input.pattern === "string" ? event.input.pattern.trim() : "";
            if (!pattern) return { block: true, reason: "find requires a pattern. Use a targeted glob such as extensions/**/*.ts or **/*.spec.ts." };
            if (broadSearch && /^(?:\*\*\/)?\*$/.test(pattern)) {
              return {
                block: true,
                reason: "This find pattern is too broad for a repo-wide search. Use a narrower pattern such as extensions/**/*.ts and include a reasonable limit.",
              };
            }
          }
          return;
        }

        // safe-bash modes: only allow safe read-only bash (plan)
        if (event.toolName === "bash" && toolDescriptor.requiresSafeBash) {
          const command = String(event.input.command ?? "");
          if (!isSafeCommand(command)) return { block: true, reason: `Plan mode only allows safe read-only bash commands. Use /normal for mutating commands.\nCommand: ${command}` };
          return;
        }

        // unrestricted modes: approval gate only (normal)
        if (toolDescriptor.writePolicy.unrestricted) {
          if (isMutationTool) {
            if (!isApprovalExemptPath(resolvedPath, state.activeProject)) {
              const approvedProposal = beginApplyingProposalForPath(approvalDeps, resolvedPath, ctx);
              if (!approvedProposal) return { block: true, reason: buildApprovalBlockedReason(resolvedPath, ps(), getResolutionBase(ctx.cwd, state.activeRepoRoot), { toolName: event.toolName, mutationSummary: describeMutation(event as { toolName: string; input: Record<string, unknown> }) }) };
            }
          }
          return;
        }

        // project-scope modes: scope gate + approval gate (plan)
        if (toolDescriptor.writePolicy.projectScopeOnly) {
          if (!isMutationTool) return;
          if (!state.activeProject) return { block: true, reason: "Plan mode requires an active project before state or artifact files may be edited. Use /project first." };
          const statePath = getProjectStatePath(state.activeProject);
          const artifactsPath = getProjectArtifactsPath(state.activeProject);
          const jiraAllowed = resolvedPath.startsWith(JIRA_TMP_PREFIX) && resolvedPath.endsWith(".txt");
          const allowed = resolvedPath === statePath || isSameOrWithin(resolvedPath, artifactsPath) || jiraAllowed;
          if (!allowed) return { block: true, reason: ["Plan mode only allows file mutations for the active project control files.", `Active project state file: ${statePath}`, `Active project artifacts directory: ${artifactsPath}`, `Allowed Jira draft path pattern: ${JIRA_TMP_PREFIX}<ISSUE-KEY>.txt`, `Requested path: ${resolvedPath}`, "Use /normal to edit repository files."].join("\n") };
          if (!isApprovalExemptPath(resolvedPath, state.activeProject)) {
            const approvedProposal = beginApplyingProposalForPath(approvalDeps, resolvedPath, ctx);
            if (!approvedProposal) return { block: true, reason: buildApprovalBlockedReason(resolvedPath, ps(), getResolutionBase(ctx.cwd, state.activeRepoRoot), { toolName: event.toolName, mutationSummary: describeMutation(event as { toolName: string; input: Record<string, unknown> }) }) };
          }
        }
      } catch (error) {
        const detail = formatErrorDetails(error);
        if (ctx.hasUI) ctx.ui.notify(`Approval gate failed during ${event.toolName}: ${detail}`, "warning");
        return { block: true, reason: `Approval gate internal error while processing ${event.toolName}.\n${detail}` };
      }
    },
  };

  registerHooks(pi, hookHandlers);
}
