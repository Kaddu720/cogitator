import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Mode, persistMode, restoreMode, persistProjectSelection, restoreStoredProjectId } from "./runtime.js";
import { registerCommands, type CommandHandlers, type ShortcutHandlers } from "./commands.js";
import { registerHooks, type HookHandlers } from "./hooks.js";
import {
  type ProjectRecord,
  type NewProjectWizardResult,
  getControlRoot,
  getProjectsRoot,
  getResolutionBase,
  resolveFrom,
  isSameOrWithin,
  fileExists,
  slugifyProjectId,
  titleizeProjectId,
  parseMultilineList,
  inferRepoName,
  getProjectStatePath,
  getProjectArtifactsPath,
  isApprovalExemptPath,
  matchesRepo,
  isRepoPathVisibleInSession,
  loadProjects,
  createProjectScaffold,
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
  loadProtectedPaths,
  getModeTools,
  getModeDescriptor,
  isSafeCommand,
  formatMode,
  projectStatusLine,
  readPromptFragment,
  CHANGE_PROPOSAL_WORKFLOW_PROMPT_PATH,
  SECRET_SAFETY_PROMPT_PATH,
  PROJECT_CONTEXT_GUIDANCE_PROMPT_PATH,
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

function pathTouchesProtectedPath(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((p) => isSameOrWithin(path, p));
}
function commandTouchesProtectedPath(command: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((p) => command.includes(p));
}

function getToolInputPath(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
  if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
    return typeof event.input.path === "string" ? event.input.path : undefined;
  }
  return undefined;
}

function describeMutation(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
  if (event.toolName === "write") { const c = typeof event.input.content === "string" ? event.input.content : ""; return `write ${c.length} byte(s)`; }
  if (event.toolName === "edit") { const e = Array.isArray(event.input.edits) ? event.input.edits : []; return `edit ${e.length} replacement block(s)`; }
  return undefined;
}

// ─── Runtime state ──────────────────────────────────────────────────────────────

interface WorkflowRuntimeState {
  currentMode: Mode;
  activeProject: ProjectRecord | null;
  activeRepoRoot?: string;
  pendingProposals: PendingProposal[];
  approvalPromptInFlight: boolean;
  approvalPromptDeferred: boolean;
  approvalResumePending: boolean;
}

// ─── Extension entry point ──────────────────────────────────────────────────────

export default function workflowModeExtension(pi: ExtensionAPI): void {
  const protectedPaths = loadProtectedPaths();
  let baseTools: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  const state: WorkflowRuntimeState = {
    currentMode: "plan",
    activeProject: null,
    activeRepoRoot: undefined,
    pendingProposals: [],
    approvalPromptInFlight: false,
    approvalPromptDeferred: false,
    approvalResumePending: false,
  };

  // ─── Proposal state accessors ─────────────────────────────────────────────────

  const ps = () => state.pendingProposals;

  function persistApprovalState(): void { persistApprovalGateState(pi, ps()); }

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

  function applyMode(mode: Mode, ctx: ExtensionContext, notify = true): void {
    state.currentMode = mode;
    pi.setActiveTools(getModeTools(baseTools, state.currentMode));
    persistMode(pi, state.currentMode);
    updateStatus(ctx);
    if (!notify || !ctx.hasUI) return;
    const descriptor = getModeDescriptor(state.currentMode);
    ctx.ui.notify(descriptor.notification(state.activeProject), "info");
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
        if (choice === "Approve") { const message = approveSelectedProposals(approvalDeps, ctx, [proposal.id]); state.approvalResumePending = true; ctx.ui.notify(message, "success"); dispatchApprovalDecision(ctx, message); return; }
        if (choice === "Defer") { const note = await ctx.ui.input("Defer note", "Why should this proposal be deferred?"); const message = deferSelectedProposals(approvalDeps, ctx, [proposal.id], note); ctx.ui.notify(message, "info"); dispatchApprovalDecision(ctx, message); return; }
        const note = await ctx.ui.input("Revision request", "What should change before approval?");
        const message = requestSelectedProposalRevision(approvalDeps, ctx, [proposal.id], note);
        ctx.ui.notify(message, "info"); dispatchApprovalDecision(ctx, message); return;
      }
    } finally { state.approvalPromptInFlight = false; }
  }

  // ─── Project management ────────────────────────────────────────────────────────

  async function setActiveProject(project: ProjectRecord | null, ctx: ExtensionContext, notify = true): Promise<void> {
    state.activeProject = project;
    persistProjectSelection(pi, project?.id ?? null);
    updateStatus(ctx);
    if (!notify || !ctx.hasUI) return;
    if (!project) { ctx.ui.notify("No project loaded for this session.", "info"); return; }
    ctx.ui.notify(`Loaded project: ${project.name}`, "info");
  }

  async function selectProject(ctx: ExtensionContext, promptTitle = "Select project for this session"): Promise<void> {
    const projects = await loadProjects();
    if (projects.length === 0) { if (ctx.hasUI) ctx.ui.notify(`No projects found under ${getProjectsRoot()}`, "warning"); await setActiveProject(null, ctx, false); return; }
    state.activeRepoRoot = await getGitRoot(ctx.cwd);
    const sorted = [...projects].sort((a, b) => {
      const aMatch = matchesRepo(a, state.activeRepoRoot);
      const bMatch = matchesRepo(b, state.activeRepoRoot);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const options = sorted.map((p) => {
      const matchLabel = matchesRepo(p, state.activeRepoRoot) ? "[repo] " : "";
      const desc = p.description ? ` — ${p.description}` : "";
      return `${matchLabel}${p.name} (${p.id})${desc}`;
    });
    options.push("No project");
    if (!ctx.hasUI) { await setActiveProject(sorted[0] ?? null, ctx, false); return; }
    const choice = await ctx.ui.select(promptTitle, options);
    if (!choice || choice === "No project") { await setActiveProject(null, ctx); return; }
    const index = options.indexOf(choice);
    await setActiveProject(sorted[index] ?? null, ctx);
  }

  // ─── Command handler implementations ─────────────────────────────────────────

  const commandHandlers: CommandHandlers = {
    project: async (_args, ctx) => { await selectProject(ctx, "Select project"); },

    "new-project": async (args, ctx) => {
      if (!ctx.hasUI) return;
      const seed = typeof args === "string" ? args.trim() : Array.isArray(args) && args.every((e) => typeof e === "string") ? args.join(" ").trim() : "";
      const seededId = slugifyProjectId(seed);
      const projectIdInput = ((await ctx.ui.input("New project", `Project id (kebab-case)${seededId ? ` [${seededId}]` : ""}`)) ?? "").trim();
      const projectId = slugifyProjectId(projectIdInput || seededId);
      if (!projectId) { ctx.ui.notify("Project creation cancelled: a valid project id is required.", "warning"); return; }
      const existingProjects = await loadProjects();
      if (existingProjects.some((p) => p.id === projectId)) { ctx.ui.notify(`Project already exists: ${projectId}`, "warning"); return; }
      const defaultName = titleizeProjectId(projectId);
      const projectName = ((await ctx.ui.input("Project name", `Human-readable project name [${defaultName}]`)) ?? "").trim() || defaultName;
      const description = ((await ctx.ui.input("Description", "Short description shown in the project picker")) ?? "").trim();
      const goal = ((await ctx.ui.input("Goal", "One-sentence definition of success")) ?? "").trim();
      const owner = ((await ctx.ui.input("Owner", "Project owner")) ?? "").trim();
      const defaultRepo = state.activeRepoRoot || getResolutionBase(ctx.cwd, state.activeRepoRoot);
      const primaryRepoInput = ((await ctx.ui.input("Primary repo", `Primary repository path [${defaultRepo}]`)) ?? "").trim();
      const primaryRepo = resolveFrom(ctx.cwd, normalizeInputPath(primaryRepoInput || defaultRepo), state.activeRepoRoot);
      const additionalReposInput = ((await ctx.ui.input("Additional repos", "Additional repository paths, one per line or comma-separated")) ?? "").trim();
      const currentFocusInput = ((await ctx.ui.input("Current focus", "Initial focus items, one per line or comma-separated")) ?? "").trim();
      const constraintsInput = ((await ctx.ui.input("Constraints", "Important constraints, one per line or comma-separated")) ?? "").trim();
      const assumptionsInput = ((await ctx.ui.input("Assumptions", "Important assumptions, one per line or comma-separated")) ?? "").trim();
      const nextStepsInput = ((await ctx.ui.input("Next steps", "Immediate next steps, one per line or comma-separated")) ?? "").trim();
      const tagsInput = ((await ctx.ui.input("Tags", "Optional tags, one per line or comma-separated")) ?? "").trim();
      const repoPaths = [primaryRepo, ...parseMultilineList(additionalReposInput).map((p) => resolveFrom(ctx.cwd, normalizeInputPath(p), state.activeRepoRoot))].filter((p) => p.length > 0).filter((p, i, v) => v.indexOf(p) === i);
      const project: NewProjectWizardResult = {
        id: projectId, name: projectName, description: description || undefined, goal: goal || undefined, owner: owner || undefined,
        repos: repoPaths.map((p, i) => ({ path: p, name: inferRepoName(p), role: i === 0 ? "primary" : "supporting" })),
        currentFocus: parseMultilineList(currentFocusInput), constraints: parseMultilineList(constraintsInput),
        assumptions: parseMultilineList(assumptionsInput), nextSteps: parseMultilineList(nextStepsInput), tags: parseMultilineList(tagsInput),
      };
      try {
        const created = await createProjectScaffold(project);
        await setActiveProject(created, ctx, false);
        const lines = [`Created project: ${created.name} (${created.id})`, `State: ${getProjectStatePath(created)}`, `Artifacts: ${getProjectArtifactsPath(created)}`, "The new project is now active for this session."];
        if (created.repos.some((r) => !isRepoPathVisibleInSession(r.path, state.activeRepoRoot))) lines.push("Restart cogi to mount any newly linked repositories into the sandbox.");
        ctx.ui.notify(lines.join("\n"), "success");
      } catch (error) { ctx.ui.notify(`Failed to create project: ${String(error)}`, "warning"); }
    },

    "project-status": async (_args, ctx) => {
      const lines = [`Mode: ${state.currentMode}`, `Control root: ${getControlRoot()}`];
      if (state.activeRepoRoot) lines.push(`Repo root: ${state.activeRepoRoot}`);
      if (state.activeProject) { lines.push(`Project: ${state.activeProject.name} (${state.activeProject.id})`); lines.push(`State: ${getProjectStatePath(state.activeProject)}`); lines.push(`Artifacts: ${getProjectArtifactsPath(state.activeProject)}`); }
      else { lines.push("Project: none"); }
      const needingApproval = getPendingApprovalProposals(approvalDeps);
      if (needingApproval.length > 0) { lines.push(`Pending approvals: ${needingApproval.length}`); for (const p of needingApproval) lines.push(`- Change ${p.index}/${p.total}: ${p.file} — ${p.proposedEdit} [${p.status}]`); }
      if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
    },

    "add-repo": async (args, ctx) => {
      if (!state.activeProject) { if (ctx.hasUI) ctx.ui.notify("Load a project first with /project before adding a linked repo.", "warning"); return; }
      const suppliedPath = Array.isArray(args) && args.every((e) => typeof e === "string") ? args.join(" ").trim() : "";
      const rawPath = suppliedPath || (ctx.hasUI ? ((await ctx.ui.input("Add linked repo", "Repository path to add to this project")) ?? "").trim() : "");
      if (!rawPath) return;
      const resolvedRepoPath = resolveFrom(ctx.cwd, normalizeInputPath(rawPath), state.activeRepoRoot);
      if (state.activeProject.repos.some((r) => resolve(r.path) === resolvedRepoPath)) { if (ctx.hasUI) ctx.ui.notify(`Repo already linked to this project: ${resolvedRepoPath}`, "info"); return; }
      const updatedProject: ProjectRecord = { ...state.activeProject, repos: [...state.activeProject.repos, { path: resolvedRepoPath }] };
      const projectJsonPath = resolve(state.activeProject.dir, "project.json");
      let projectJson: Record<string, unknown> = { id: updatedProject.id, name: updatedProject.name, description: updatedProject.description, stateFile: updatedProject.stateFile, artifactsDir: updatedProject.artifactsDir, repos: updatedProject.repos, repoContexts: updatedProject.repoContexts, tags: updatedProject.tags };
      try { const parsed = JSON.parse(await readFile(projectJsonPath, "utf8")) as Record<string, unknown>; if (parsed && typeof parsed === "object") projectJson = { ...parsed, repos: updatedProject.repos }; } catch { /* rebuild */ }
      await writeFile(projectJsonPath, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");
      await setActiveProject(updatedProject, ctx, false);
      if (ctx.hasUI) ctx.ui.notify([`Added linked repo to ${updatedProject.name}: ${resolvedRepoPath}`, "Restart cogi to mount the new repository into the sandbox."].join("\n"), "success");
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
      const sourceLines = states.length > 0 ? states.map((s: WeeklySummaryState) => `- ${s.project.name}: ${s.statePath} (updated ${formatShutdownTimestamp(s.modifiedAt)})`).join("\n") : "- none";
      const artifactContent = ["# Weekly Summary", "", `- generated_at: ${formatShutdownTimestamp(now)}`, `- window_start: ${formatWeeklySummaryDate(since)}`, `- window_end: ${formatWeeklySummaryDate(now)}`, `- active_project: ${state.activeProject.name} (${state.activeProject.id})`, `- scanned_state_files: ${states.length}`, "", "## Top Completed This Week", formatWeeklySummaryBullets(completedItems, "No completed items were found in project state files updated during the last 7 days."), "", "## Top In Progress For Next Week", formatWeeklySummaryBullets(nextWeekItems, "No in-progress or next-step items were found in project state files updated during the last 7 days."), "", "## Source State Files", sourceLines, ""].join("\n");
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
  };

  const shortcutHandlers: ShortcutHandlers = {
    "ctrl+alt+p": async (ctx) => applyMode(state.currentMode === "plan" ? "normal" : "plan", ctx),
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
      state.currentMode = restoredMode === "readonly" ? "readonly" : "plan";
      state.pendingProposals = restoreNormalizedProposals(ctx, ctx.cwd, state.activeRepoRoot);
      const preferredProjectId = restoreStoredProjectId(ctx) ?? process.env.COGITATOR_PROJECT_ID;
      const projects = await loadProjects();
      if (typeof preferredProjectId === "string") {
        state.activeProject = projects.find((p) => p.id === preferredProjectId) ?? null;
        if (state.activeProject) { persistProjectSelection(pi, state.activeProject.id); }
        else if (ctx.hasUI) { ctx.ui.notify(`Stored project '${preferredProjectId}' was not found in ${getProjectsRoot()}`, "warning"); }
      } else if (preferredProjectId === null) { state.activeProject = null; }
      else if (ctx.hasUI) { await selectProject(ctx); }
      pi.setActiveTools(getModeTools(baseTools, state.currentMode));
      updateStatus(ctx);
    },

    session_tree: async (_event, ctx) => {
      baseTools = Array.from(new Set(pi.getAllTools().map((t) => t.name)));
      state.activeRepoRoot = await getGitRoot(ctx.cwd);
      const restoredMode = restoreMode(ctx);
      state.currentMode = restoredMode === "readonly" ? "readonly" : "plan";
      state.pendingProposals = restoreNormalizedProposals(ctx, ctx.cwd, state.activeRepoRoot);
      const restoredProjectId = restoreStoredProjectId(ctx);
      if (restoredProjectId === null) { state.activeProject = null; }
      else if (typeof restoredProjectId === "string") { const projects = await loadProjects(); state.activeProject = projects.find((p) => p.id === restoredProjectId) ?? null; }
      pi.setActiveTools(getModeTools(baseTools, state.currentMode));
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
      const additions: string[] = [await readPromptFragment(CHANGE_PROPOSAL_WORKFLOW_PROMPT_PATH), await readPromptFragment(SECRET_SAFETY_PROMPT_PATH)];
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
      if (ctx.hasUI && !state.approvalPromptDeferred && actionableCount > 0 && (proposals.length > 0 || completedCount > 0)) await promptForApproval(ctx);
    },

    tool_call: async (event, ctx) => {
      if (event.toolName === "bash") {
        const command = String(event.input.command ?? "");
        if (/\bsops\b/i.test(command)) return { block: true, reason: "Access to the sops command is blocked." };
        if (commandTouchesProtectedPath(command, protectedPaths)) return { block: true, reason: "Access to protected secret paths is blocked." };
      }
      const toolInputPath = getToolInputPath(event as { toolName: string; input: Record<string, unknown> });
      if (toolInputPath) {
        const resolvedToolPath = resolveFrom(ctx.cwd, normalizeInputPath(toolInputPath), state.activeRepoRoot);
        if (pathTouchesProtectedPath(resolvedToolPath, protectedPaths)) return { block: true, reason: "Access to protected secret paths is blocked." };
      }
      const toolDescriptor = getModeDescriptor(state.currentMode);
      const isMutationTool = event.toolName === "write" || event.toolName === "edit";

      // blocked modes: block ALL bash and ALL mutations (readonly)
      if (toolDescriptor.writePolicy.blocked) {
        if (event.toolName === "bash") return { block: true, reason: "Read-only mode blocks bash. Use /plan or /normal." };
        if (isMutationTool) return { block: true, reason: "Read-only mode blocks file mutations. Use /plan or /normal." };
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
          const requestedPath = String(event.input.path ?? "");
          const resolvedPath = resolveFrom(ctx.cwd, normalizeInputPath(requestedPath), state.activeRepoRoot);
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
        const requestedPath = String(event.input.path ?? "");
        const resolvedPath = resolveFrom(ctx.cwd, normalizeInputPath(requestedPath), state.activeRepoRoot);
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
    },
  };

  registerHooks(pi, hookHandlers);
}
