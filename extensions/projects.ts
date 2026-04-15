/**
 * projects.ts — project types, constants, path utilities, and project CRUD/context.
 *
 * This module owns:
 *   - Project domain types (ProjectRecord, ProjectRepoLink, NewProjectWizardResult)
 *   - Control-root and project-store path helpers (getControlRoot, getProjectsRoot, ...)
 *   - Shared path utilities also used by workflow-mode.ts (getResolutionBase, resolveFrom,
 *     isSameOrWithin, fileExists, truncate, escapeRegExp) — these will move to resources.ts
 *     in Phase 4
 *   - Project loading, scaffolding, and context-building functions
 *
 * Import direction: workflow-mode.ts → projects.ts (never the reverse).
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectRepoLink {
  path: string;
  name?: string;
  role?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  dir: string;
  stateFile: string;
  artifactsDir: string;
  repos: ProjectRepoLink[];
  repoContexts: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface NewProjectWizardResult {
  id: string;
  name: string;
  description?: string;
  repos: ProjectRepoLink[];
}

export interface InitialStateGenerationOptions {
  model?: Parameters<typeof complete>[0] | null;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONTROL_ROOT = "/home/kaddu/.local/share/cogitator";
const PROJECTS_DIRNAME = "projects";
const REPO_CONTEXTS_DIRNAME = "repoContexts";

export const STATE_FILE_DEFAULT = "state.md";
export const ARTIFACTS_DIR_DEFAULT = "artifacts";

/** Maximum characters included when embedding file content into project context. */
const PROJECT_CONTEXT_LIMIT = 32000;

const SHARED_PROJECT_STATE_TEMPLATE_PATH = fileURLToPath(
  new URL("../resources/templates/project-state-template.md", import.meta.url),
);

// ─── Shared path utilities ─────────────────────────────────────────────────────
// These are general enough to eventually live in resources.ts (Phase 4).
// They are exported here so workflow-mode.ts can import them without circular deps.

export function getControlRoot(): string {
  return process.env.COGITATOR_CONTROL_ROOT || DEFAULT_CONTROL_ROOT;
}

export function getProjectsRoot(): string {
  return resolve(getControlRoot(), PROJECTS_DIRNAME);
}

export function getRepoContextsRoot(): string {
  return resolve(getControlRoot(), REPO_CONTEXTS_DIRNAME);
}

export function getResolutionBase(cwd: string | undefined, repoRoot?: string): string {
  if (typeof cwd === "string") {
    const trimmed = cwd.trim();
    if (trimmed.length > 0 && trimmed !== "undefined") return trimmed;
  }
  if (repoRoot) return repoRoot;
  const processCwd = process.cwd();
  if (processCwd) return processCwd;
  return getControlRoot();
}

export function resolveFrom(base: string | undefined, path: string, repoRoot?: string): string {
  const resolutionBase = getResolutionBase(base, repoRoot);
  return isAbsolute(path) ? resolve(path) : resolve(resolutionBase, path);
}

export function isSameOrWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function truncate(text: string, maxChars = PROJECT_CONTEXT_LIMIT): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Truncated to ${maxChars} characters]`;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Parsing utilities ─────────────────────────────────────────────────────────

function parseRepoLinks(value: unknown): ProjectRepoLink[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry === "string") return { path: entry };

      if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
        const repo = entry as { path: string; name?: unknown; role?: unknown };
        return {
          path: repo.path,
          name: typeof repo.name === "string" ? repo.name : undefined,
          role: typeof repo.role === "string" ? repo.role : undefined,
        };
      }
      return undefined;
    })
    .filter((entry): entry is ProjectRepoLink => entry !== undefined);
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function formatStateBulletList(items: string[], fallback: string, indent = ""): string {
  if (items.length === 0) return `${indent}- ${fallback}`;
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

function replaceMarkdownSection(document: string, heading: string, body: string): string {
  const pattern = new RegExp(`${escapeRegExp(heading)}\\n[\\s\\S]*?(?=\\n## |\\n---\\n|$)`);
  return document.replace(pattern, `${heading}\n${body.trimEnd()}\n`);
}

function removeMarkdownSection(document: string, heading: string): string {
  const pattern = new RegExp(`\\n${escapeRegExp(heading)}\\n[\\s\\S]*?(?=\\n## |\\n---\\n|$)`, "m");
  return document.replace(pattern, "");
}

// ─── Project ID / name helpers (exported for use in command handlers) ──────────

export function slugifyProjectId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function titleizeProjectId(projectId: string): string {
  return projectId
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function parseMultilineList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function inferRepoName(repoPath: string): string | undefined {
  const parts = repoPath.split("/").filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

// ─── Project path helpers ──────────────────────────────────────────────────────

export function getProjectStatePath(project: ProjectRecord): string {
  return resolve(project.dir, project.stateFile);
}

export function getProjectArtifactsPath(project: ProjectRecord): string {
  return resolve(project.dir, project.artifactsDir);
}

/**
 * Returns true if `path` is the active project's state file and therefore
 * exempt from the approval gate in both normal and plan mode.
 */
export function isApprovalExemptPath(path: string, project: ProjectRecord | null): boolean {
  if (!project) return false;
  return path === getProjectStatePath(project);
}

/** Returns true if the project has a linked repo that includes or is included by `repoRoot`. */
export function matchesRepo(project: ProjectRecord, repoRoot: string | undefined): boolean {
  if (!repoRoot) return false;
  return project.repos.some((repo) => {
    const linked = resolve(repo.path);
    return isSameOrWithin(repoRoot, linked) || isSameOrWithin(linked, repoRoot);
  });
}

/**
 * Returns true if the given repo path is already accessible inside the current
 * sandbox session (i.e., it overlaps with the active repo root).
 */
export function isRepoPathVisibleInSession(repoPath: string, repoRoot: string | undefined): boolean {
  if (!repoRoot) return false;
  return isSameOrWithin(repoPath, repoRoot) || isSameOrWithin(repoRoot, repoPath);
}

// ─── Project loading ────────────────────────────────────────────────────────────

function parseOptionalTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampToMillis(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareProjectsByRecentActivity(a: ProjectRecord, b: ProjectRecord): number {
  const updatedDiff = timestampToMillis(b.updatedAt) - timestampToMillis(a.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  const createdDiff = timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt);
  if (createdDiff !== 0) return createdDiff;

  return a.id.localeCompare(b.id);
}

export async function loadProjects(): Promise<ProjectRecord[]> {
  const root = getProjectsRoot();
  let dirEntries: Awaited<ReturnType<typeof readdir>>;

  try {
    dirEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects: ProjectRecord[] = [];

  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;

    const dir = resolve(root, entry.name);
    const jsonPath = resolve(dir, "project.json");

    try {
      const raw = JSON.parse(await readFile(jsonPath, "utf8")) as {
        id?: unknown;
        name?: unknown;
        stateFile?: unknown;
        artifactsDir?: unknown;
        repos?: unknown;
        repoContexts?: unknown;
        contextFiles?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
      };

      const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : entry.name;
      const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
      const repoContexts = [...parseStringArray(raw.repoContexts), ...parseStringArray(raw.contextFiles)];

      projects.push({
        id,
        name,
        dir,
        stateFile: typeof raw.stateFile === "string" ? raw.stateFile : STATE_FILE_DEFAULT,
        artifactsDir: typeof raw.artifactsDir === "string" ? raw.artifactsDir : ARTIFACTS_DIR_DEFAULT,
        repos: parseRepoLinks(raw.repos),
        repoContexts,
        createdAt: parseOptionalTimestamp(raw.createdAt),
        updatedAt: parseOptionalTimestamp(raw.updatedAt),
      });
    } catch {
      // Ignore malformed project definitions; one bad project.json must not break startup.
    }
  }

  return projects.sort(compareProjectsByRecentActivity);
}

// ─── Project scaffolding ────────────────────────────────────────────────────────

export async function buildInitialStateMarkdown(project: NewProjectWizardResult): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const description = project.description?.trim() || "";
  const repoLinks = project.repos.map((repo) => {
    const extras = [repo.name, repo.role].filter(Boolean).join(" · ");
    return `\`${repo.path}\`${extras ? ` (${extras})` : ""}`;
  });
  const repoPaths = project.repos.map((repo) => repo.path);
  const primaryRepo = repoLinks[0] ?? "[none]";
  const linkedRepos = repoLinks.slice(1);

  const cleanIdea = (value: string): string => value.replace(/^[\s•*\-]+/, "").replace(/\s+/g, " ").trim();
  const ensureSentence = (value: string, fallback: string): string => {
    const trimmed = cleanIdea(value);
    if (trimmed.length === 0) return fallback;
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };
  const trimList = (items: string[], maxItems: number, fallback: string): string[] => {
    const unique = Array.from(new Set(items.map(cleanIdea).filter((item) => item.length > 0)));
    return unique.slice(0, maxItems).length > 0 ? unique.slice(0, maxItems) : [fallback];
  };

  const descriptionIdeas = description.length > 0
    ? Array.from(new Set(
      description
        .split(/\r?\n+/)
        .flatMap((line) => line.split(/(?<=[.;!?])\s+|\s+-\s+/))
        .map(cleanIdea)
        .filter((item) => item.length > 0),
    ))
    : [];

  const focusItems = trimList(
    descriptionIdeas.slice(0, 2).map((idea, index) => index === 0 ? ensureSentence(idea, "") : ensureSentence(idea, "")),
    2,
    "Review the project description and identify the first concrete workstream.",
  );

  const constraintItems = trimList(
    [
      ...descriptionIdeas.filter((idea) => /\b(must|should|need|needs|require|required|expect|expected|want)\b/i.test(idea)).map((idea) => ensureSentence(idea, "")),
      repoPaths.length > 1 ? "Implementation may span multiple linked repositories." : "Work should stay aligned with the linked primary repository.",
    ],
    2,
    "No explicit constraints recorded yet.",
  );

  const assumptionItems = trimList(
    [
      description.length > 0
        ? `Initial state was synthesized from the project description provided during setup on ${today}.`
        : `Initial scaffold was created on ${today}; refine this file after the first review.`,
      repoPaths.length > 1 ? "Supporting repositories provide additional execution context." : "The primary repository contains the main implementation surface.",
    ],
    2,
    `Initial scaffold was created on ${today}.`,
  );

  const goal = descriptionIdeas.length > 0
    ? ensureSentence(descriptionIdeas[0], `Define and execute the initial goal for ${project.name}.`)
    : `Define and execute the initial goal for ${project.name}.`;

  const keyFileLocations = [
    ...(repoPaths[0] ? [`- \`${repoPaths[0]}\`: primary linked repository for this project`] : []),
    ...repoPaths.slice(1, 3).map((repoPath) => `- \`${repoPath}\`: supporting linked repository`),
    "- `project.json`: project metadata",
    "- `state.md`: project working state",
    "- `artifacts/`: generated outputs",
    `- \`${getRepoContextsRoot()}\`: shared repo-specific private guidance under the control root`,
  ].join("\n");

  const todoItems = trimList(
    [
      description.length > 0 ? `Confirm the initial goal and success criteria implied by the description: ${ensureSentence(descriptionIdeas[0] ?? description, "")}` : "Confirm the initial goal and success criteria for this project.",
      repoPaths[0] ? `Inspect \`${repoPaths[0]}\` and identify the first implementation entry points.` : "Identify the first implementation entry points.",
      linkedRepos.length > 0 ? "Confirm which linked repositories need repo context files or additional notes." : "Add any missing repo context files or supporting notes if needed.",
    ],
    3,
    "Review the project description and define the first actionable task.",
  );

  const nextSteps = trimList(
    [
      todoItems[0],
      todoItems[1] ?? "Identify the first implementation entry points.",
    ],
    2,
    "Review the project description and define the first actionable task.",
  );
  const nextStepSummary = nextSteps[0];

  const SHUTDOWN_CHECKPOINT_START = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->";
  const SHUTDOWN_CHECKPOINT_END = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:END -->";

  let template = await readFile(SHARED_PROJECT_STATE_TEMPLATE_PATH, "utf8");
  template = template.replace("# <Project Name>", `# ${project.name}`);
  template = removeMarkdownSection(template, "## Description");
  template = removeMarkdownSection(template, "## Project Metadata");
  template = removeMarkdownSection(template, "## Background & Context");
  template = removeMarkdownSection(template, "## Implementation Plan");
  template = removeMarkdownSection(template, "## Open Questions & Blockers");
  template = removeMarkdownSection(template, "## Requested Backlog");
  template = removeMarkdownSection(template, "## Deferred Approval Items");
  template = replaceMarkdownSection(
    template,
    "## Executive Summary",
    `- Status: todo\n- Goal: ${goal}`,
  );
  template = replaceMarkdownSection(
    template,
    "## Current Context",
    `- Primary repo: ${primaryRepo}${linkedRepos.length > 0 ? `\n- Linked repos:\n${formatStateBulletList(linkedRepos, "None recorded.", "  ")}` : ""}\n- Current focus:\n${formatStateBulletList(focusItems, "Review the project description and identify the first concrete workstream.", "  ")}\n- Constraints:\n${formatStateBulletList(constraintItems, "No explicit constraints recorded yet.", "  ")}\n- Assumptions:\n${formatStateBulletList(assumptionItems, `Initial scaffold was created on ${today}.`, "  ")}`,
  );
  template = replaceMarkdownSection(
    template,
    "## Architecture Decisions",
    `- decision: Initial project state synthesized from setup inputs\n  rationale: Seed the project with a usable first-pass state derived from the description and linked repositories instead of leaving a mostly blank scaffold.\n  date: ${today}\n  owner: Cogitator\n  status: done`,
  );
  template = replaceMarkdownSection(
    template,
    "## Key File Locations",
    keyFileLocations,
  );
  template = replaceMarkdownSection(
    template,
    "## Progress Tracking",
    `- todo:\n${formatStateBulletList(todoItems, "Review the project description and define the first actionable task.", "  ")}\n- in_progress:\n  - Project initialization from setup inputs\n- blocked:\n  - None recorded.\n- done:\n  - Created initial project scaffold\n  - Synthesized an initial project state from the setup description and linked repositories\n- deferred:\n  - None recorded.`,
  );
  template = replaceMarkdownSection(
    template,
    "## Validation & Evidence",
    `- validated:\n  - Created project scaffold under the Cogitator control root\n  - Populated the initial state from the setup description and linked repository list\n- evidence:\n  - \`project.json\`\n  - \`state.md\`${description.length > 0 ? `\n  - Setup description: ${ensureSentence(description, "")}` : ""}`,
  );
  template = replaceMarkdownSection(
    template,
    "## Next Steps",
    formatStateBulletList(nextSteps, "Review the project description and define the first actionable task."),
  );
  template = replaceMarkdownSection(
    template,
    "## Session Shutdown Checkpoint",
    `This section is system-managed. Do not maintain it manually except when repairing a broken checkpoint block.\n\n${SHUTDOWN_CHECKPOINT_START}\n- saved_at: [none]\n- mode: [none]\n- session_file: [none]\n- repo_root: [none]\n- pending_proposals: 0\n- actionable_approval_steps: 0\n- proposal_status_counts: [none]\n- executive_status: todo\n- goal: [none]\n- current_focus: [none]\n- progress_counts: todo=0, in_progress=0, blocked=0, done=0, deferred=0\n- next_steps: ${nextStepSummary}\n- artifact: [none]\n${SHUTDOWN_CHECKPOINT_END}`,
  );

  return template;
}

export async function buildInitialStateMarkdownWithModel(
  project: NewProjectWizardResult,
  options: InitialStateGenerationOptions = {},
): Promise<string> {
  const fallback = await buildInitialStateMarkdown(project);
  if (!options.model || !options.apiKey) return fallback;

  const template = await readFile(SHARED_PROJECT_STATE_TEMPLATE_PATH, "utf8");
  const repoList = project.repos.length > 0
    ? project.repos.map((repo, index) => `- path: ${repo.path}${repo.name ? `\n  name: ${repo.name}` : ""}${repo.role ? `\n  role: ${repo.role}` : index === 0 ? "\n  role: primary" : ""}`).join("\n")
    : "- none";

  const SYSTEM_PROMPT = [
    "You generate initial Cogitator project state files.",
    "Use the provided markdown template structure and fill it out with the best available first-pass project state.",
    "Return only markdown for the state file.",
    "Preserve all template headings in order.",
    "Keep the Session Shutdown Checkpoint section system-managed with placeholder values until runtime updates it.",
    "Do not invent detailed validation results, file paths, or completed work beyond what the inputs justify.",
    "Prefer concise, concrete content over placeholders when the description supports it.",
  ].join(" ");

  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [{
      type: "text",
      text: [
        "Create an initial project state markdown document for the following Cogitator project.",
        "",
        `Project ID: ${project.id}`,
        `Project Name: ${project.name}`,
        `Description: ${project.description?.trim() || "[none provided]"}`,
        "Linked repositories:",
        repoList,
        "",
        "Use this template as the required structure:",
        "```markdown",
        template.trim(),
        "```",
        "",
        "Important requirements:",
        "- Replace placeholders with best-effort initial content grounded in the description and linked repositories.",
        "- Keep status vocabulary canonical.",
        "- Keep the shutdown checkpoint block present and still placeholder/system-managed.",
        "- Output only the completed markdown document.",
      ].join("\n"),
    }],
  };

  try {
    const response = await complete(
      options.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: options.apiKey, headers: options.headers, signal: options.signal },
    );

    if (response.stopReason === "aborted") return fallback;

    const generated = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();

    if (
      generated.length === 0
      || !generated.includes("## Executive Summary")
      || !generated.includes("## Session Shutdown Checkpoint")
      || !generated.includes("<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->")
      || !generated.includes("<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:END -->")
    ) {
      return fallback;
    }

    return generated.replace(/^#\s+.*$/m, `# ${project.name}`);
  } catch {
    return fallback;
  }
}

export async function createProjectScaffold(project: NewProjectWizardResult): Promise<ProjectRecord> {
  const projectDir = resolve(getProjectsRoot(), project.id);
  const projectJsonPath = resolve(projectDir, "project.json");
  const statePath = resolve(projectDir, STATE_FILE_DEFAULT);
  const artifactsPath = resolve(projectDir, ARTIFACTS_DIR_DEFAULT);
  const repoContextsPath = getRepoContextsRoot();
  const timestamp = new Date().toISOString();

  if (await fileExists(projectJsonPath)) {
    throw new Error(`Project already exists: ${projectJsonPath}`);
  }

  await mkdir(projectDir, { recursive: true });
  await mkdir(artifactsPath, { recursive: true });
  await mkdir(repoContextsPath, { recursive: true });

  const projectJson = {
    id: project.id,
    name: project.name,
    stateFile: STATE_FILE_DEFAULT,
    artifactsDir: ARTIFACTS_DIR_DEFAULT,
    repos: project.repos,
    repoContexts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await writeFile(projectJsonPath, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");
  await writeFile(statePath, await buildInitialStateMarkdown(project), "utf8");

  return {
    id: project.id,
    name: project.name,
    dir: projectDir,
    stateFile: STATE_FILE_DEFAULT,
    artifactsDir: ARTIFACTS_DIR_DEFAULT,
    repos: project.repos,
    repoContexts: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function updateProjectMetadata(
  project: ProjectRecord,
  updates: Partial<Pick<ProjectRecord, "repos" | "repoContexts">> = {},
): Promise<ProjectRecord> {
  const projectJsonPath = resolve(project.dir, "project.json");
  const timestamp = new Date().toISOString();
  const nextProject: ProjectRecord = {
    ...project,
    ...updates,
    createdAt: project.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  let projectJson: Record<string, unknown> = {
    id: nextProject.id,
    name: nextProject.name,
    stateFile: nextProject.stateFile,
    artifactsDir: nextProject.artifactsDir,
    repos: nextProject.repos,
    repoContexts: nextProject.repoContexts,
    createdAt: nextProject.createdAt,
    updatedAt: nextProject.updatedAt,
  };

  try {
    const parsed = JSON.parse(await readFile(projectJsonPath, "utf8")) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      projectJson = {
        ...parsed,
        repos: nextProject.repos,
        repoContexts: nextProject.repoContexts,
        createdAt: nextProject.createdAt,
        updatedAt: nextProject.updatedAt,
      };
    }
  } catch {
    // Rebuild minimal metadata when project.json is missing or malformed.
  }

  await writeFile(projectJsonPath, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");
  return nextProject;
}

export async function deleteProjectScaffold(project: ProjectRecord): Promise<void> {
  const projectsRoot = resolve(getProjectsRoot());
  const projectDir = resolve(project.dir);

  if (projectDir === projectsRoot || !isSameOrWithin(projectDir, projectsRoot)) {
    throw new Error(`Refusing to delete project outside projects root: ${projectDir}`);
  }

  await rm(projectDir, { recursive: true, force: true });
}

// ─── Project context ────────────────────────────────────────────────────────────

export async function buildProjectContext(
  project: ProjectRecord,
  cwd: string | undefined,
  repoRoot: string | undefined,
  mode?: string,
): Promise<string> {
  const sections: string[] = [];
  const statePath = getProjectStatePath(project);
  const artifactsPath = getProjectArtifactsPath(project);
  const resolvedCwd = getResolutionBase(cwd, repoRoot);

  sections.push("[COGITATOR PROJECT ACTIVE]");
  sections.push(`Project: (${project.id}) ${project.name}`);
  if (mode) sections.push(`Current Mode: ${mode}`);
  sections.push(`Project Directory: ${project.dir}`);
  sections.push(`State File: ${statePath}`);
  sections.push(`Artifacts Directory: ${artifactsPath}`);
  sections.push(`Control Root: ${getControlRoot()}`);
  sections.push(`Current Working Directory: ${resolvedCwd}`);
  if (repoRoot) sections.push(`Active Repo Root: ${repoRoot}`);

  if (project.repos.length > 0) {
    sections.push("Linked Repositories:");
    for (const repo of project.repos) {
      const extras = [repo.name, repo.role].filter(Boolean).join(" · ");
      sections.push(`- ${repo.path}${extras ? ` (${extras})` : ""}`);
    }
  }

  const shutdownArtifactPath = resolve(artifactsPath, "latest-shutdown.md");

  // Inline compact state summary — avoids embedding full file contents.
  // (project-state.ts imports from projects.ts so we cannot import back.)
  function extractSection(md: string, heading: string): string {
    const m = md.match(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n([\\s\\S]*?)(?=^##\\s|$)`, "m"));
    return m?.[1]?.trim() ?? "";
  }
  function bulletValue(section: string, label: string): string {
    return section.match(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "[none]";
  }
  function indentedBullets(section: string, label: string): string[] {
    const lines = section.split(/\r?\n/);
    const items: string[] = [];
    let collecting = false;
    for (const line of lines) {
      if (!collecting) { if (line.trim() === `- ${label}:`) collecting = true; continue; }
      const m = line.match(/^\s{2,}-\s+(.*)$/);
      if (m) { const v = m[1].trim(); if (v) items.push(v); continue; }
      if (/^-\s+/.test(line.trim()) || line.trim().length === 0) { if (!m) break; }
    }
    return items;
  }
  function truncateInline(text: string, max = 200): string {
    const s = text.replace(/\s+/g, " ").trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}\u2026`;
  }

  if (await fileExists(statePath)) {
    const stateText = await readFile(statePath, "utf8");
    const execSec = extractSection(stateText, "Executive Summary");
    const bgSec = extractSection(stateText, "Background & Context");
    const progressSec = extractSection(stateText, "Progress Tracking");
    const nextStepsSec = extractSection(stateText, "Next Steps");
    const countItems = (label: string) => indentedBullets(progressSec, label).length;
    const focus = indentedBullets(bgSec, "current focus");
    const nextSteps = nextStepsSec.split(/\r?\n/).map(l => l.match(/^\s*-\s+(.*)$/)?.[1]?.trim() ?? "").filter(Boolean);
    const progressCounts = ["todo", "in_progress", "blocked", "done", "deferred"].map(k => `${k}=${countItems(k)}`).join(", ");
    sections.push([
      "\nProject State Summary:",
      `- state_file: ${statePath}`,
      `- executive_status: ${bulletValue(execSec, "Status")}`,
      `- goal: ${truncateInline(bulletValue(execSec, "Goal"))}`,
      `- current_focus: ${focus.length ? truncateInline(focus.join(" | ")) : "[none]"}`,
      `- progress_counts: ${progressCounts}`,
      `- next_steps: ${nextSteps.length ? truncateInline(nextSteps.join(" | ")) : "[none]"}`,
    ].join("\n"));
  } else {
    sections.push(`\nProject State Summary:\n- state_file: ${statePath}\n- status: [missing state file]`);
  }

  sections.push(`\nLatest Shutdown Artifact: ${await fileExists(shutdownArtifactPath) ? shutdownArtifactPath : `[missing] ${shutdownArtifactPath}`}`);

  if (project.repoContexts.length > 0) {
    const existingContexts: string[] = [];
    const repoContextsRoot = getRepoContextsRoot();
    for (const storedPath of project.repoContexts) {
      const sharedPath = isAbsolute(storedPath) ? resolve(storedPath) : resolve(repoContextsRoot, storedPath);
      const legacyProjectPath = resolve(project.dir, storedPath);
      if (await fileExists(sharedPath)) existingContexts.push(sharedPath);
      else if (await fileExists(legacyProjectPath)) existingContexts.push(legacyProjectPath);
    }
    if (existingContexts.length > 0) {
      sections.push("\nProject Context Files (read these if needed for repo-specific guidance):");
      for (const p of Array.from(new Set(existingContexts))) sections.push(`- ${p}`);
    }
  }

  sections.push(
    `\nStartup/resume guidance: at session start or resume, review the active project state file (${statePath}) first, then check the rolling shutdown artifact (${shutdownArtifactPath}) for the latest persisted session checkpoint before planning or editing. After that, reuse what you already learned unless those files changed or the task specifically requires refreshed project-tracking context. Do not reread these files on every subsequent task — only reread them when the user explicitly asks for a refresh or when you have reason to believe they changed.`,
  );

  sections.push(
    `\nArtifact rule: write generated artifacts under ${artifactsPath}. In plan mode, repository files stay read-only while state/artifacts remain writable.`,
  );

  return sections.join("\n");
}
