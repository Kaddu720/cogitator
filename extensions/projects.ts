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

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  description?: string;
  dir: string;
  stateFile: string;
  artifactsDir: string;
  repos: ProjectRepoLink[];
  repoContexts: string[];
  tags: string[];
}

export interface NewProjectWizardResult {
  id: string;
  name: string;
  description?: string;
  goal?: string;
  owner?: string;
  repos: ProjectRepoLink[];
  currentFocus: string[];
  constraints: string[];
  assumptions: string[];
  nextSteps: string[];
  tags: string[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CONTROL_ROOT = "/home/kaddu/.local/share/cogitator";
const PROJECTS_DIRNAME = "projects";

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
        description?: unknown;
        stateFile?: unknown;
        artifactsDir?: unknown;
        repos?: unknown;
        repoContexts?: unknown;
        contextFiles?: unknown;
        tags?: unknown;
      };

      const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : entry.name;
      const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : id;
      const repoContexts = [...parseStringArray(raw.repoContexts), ...parseStringArray(raw.contextFiles)];

      projects.push({
        id,
        name,
        description: typeof raw.description === "string" ? raw.description : undefined,
        dir,
        stateFile: typeof raw.stateFile === "string" ? raw.stateFile : STATE_FILE_DEFAULT,
        artifactsDir: typeof raw.artifactsDir === "string" ? raw.artifactsDir : ARTIFACTS_DIR_DEFAULT,
        repos: parseRepoLinks(raw.repos),
        repoContexts,
        tags: parseStringArray(raw.tags),
      });
    } catch {
      // Ignore malformed project definitions; one bad project.json must not break startup.
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Project scaffolding ────────────────────────────────────────────────────────

export async function buildInitialStateMarkdown(project: NewProjectWizardResult): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const goal = project.goal?.trim() || "TBD";
  const owner = project.owner?.trim() || "TBD";
  const nextStepSummary = project.nextSteps[0] ?? "Select this project and refine the initial state.";
  const repoPaths = project.repos.map((repo) => repo.path);

  const SHUTDOWN_CHECKPOINT_START = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:START -->";
  const SHUTDOWN_CHECKPOINT_END = "<!-- COGITATOR:SESSION_SHUTDOWN_CHECKPOINT:END -->";

  let template = await readFile(SHARED_PROJECT_STATE_TEMPLATE_PATH, "utf8");
  template = template.replace("# <Project Name>", `# ${project.name}`);
  template = removeMarkdownSection(template, "## Project Metadata");
  template = replaceMarkdownSection(
    template,
    "## Executive Summary",
    `- Status: todo\n- Goal: ${goal}\n- Updated: ${today}\n- Owner: ${owner}`,
  );
  template = replaceMarkdownSection(
    template,
    "## Background & Context",
    `- status: todo\n- repo(s):\n${formatStateBulletList(repoPaths, "Add repo path", "  ")}\n- current focus:\n${formatStateBulletList(project.currentFocus, "Capture initial workstreams", "  ")}\n- constraints:\n${formatStateBulletList(project.constraints, "None recorded yet", "  ")}\n- assumptions:\n${formatStateBulletList(project.assumptions, "None recorded yet", "  ")}`,
  );
  template = replaceMarkdownSection(
    template,
    "## Architecture Decisions",
    `- decision: Project scaffold created\n  rationale: Establish a durable project record before substantive work begins.\n  date: ${today}\n  owner: ${owner}\n  status: done`,
  );
  template = replaceMarkdownSection(
    template,
    "## Implementation Plan",
    `- [ ] Confirm project scope and success criteria\n- [ ] Review linked repositories and add missing repo context\n- [ ] Start the first concrete implementation or investigation step`,
  );
  template = replaceMarkdownSection(
    template,
    "## Open Questions & Blockers",
    `- status: in_progress\n- Confirm whether additional linked repositories, repo context files, or external metadata are required.`,
  );
  template = replaceMarkdownSection(
    template,
    "## Key File Locations",
    `- \`project.json\`: project metadata\n- \`state.md\`: project working state\n- \`artifacts/\`: generated outputs\n- \`repoContexts/\`: repo-specific private guidance`,
  );
  template = replaceMarkdownSection(
    template,
    "## Requested Backlog",
    `- State files\n  - Refine this project's state structure as real work clarifies the best tracking granularity\n- Projects\n  - Add any missing linked repositories or repo context files needed for execution`,
  );
  template = replaceMarkdownSection(
    template,
    "## Progress Tracking",
    `- todo:\n${formatStateBulletList(project.nextSteps, "Pick the first concrete task", "  ")}\n- in_progress:\n  - Project initialization\n- blocked:\n  - None recorded\n- done:\n  - Created initial project scaffold\n- deferred:\n  - None recorded`,
  );
  template = replaceMarkdownSection(template, "## Deferred Approval Items", "- None recorded");
  template = replaceMarkdownSection(
    template,
    "## Validation & Evidence",
    `- validated:\n  - Created project scaffold under the Cogitator control root\n- evidence:\n  - \`project.json\`\n  - \`state.md\``,
  );
  template = replaceMarkdownSection(
    template,
    "## Next Steps",
    formatStateBulletList(project.nextSteps, "Select this project and refine the initial state", ""),
  );
  template = replaceMarkdownSection(
    template,
    "## Session Shutdown Checkpoint",
    `This section is system-managed. Do not maintain it manually except when repairing a broken checkpoint block.\n\n${SHUTDOWN_CHECKPOINT_START}\n- saved_at: [none]\n- mode: [none]\n- session_file: [none]\n- repo_root: [none]\n- pending_proposals: 0\n- actionable_approval_steps: 0\n- proposal_status_counts: [none]\n- executive_status: todo\n- goal: ${goal}\n- current_focus: ${project.currentFocus[0] ?? "[none]"}\n- progress_counts: todo=0, in_progress=0, blocked=0, done=0, deferred=0\n- next_steps: ${nextStepSummary}\n- artifact: [none]\n${SHUTDOWN_CHECKPOINT_END}`,
  );

  return template;
}

export async function createProjectScaffold(project: NewProjectWizardResult): Promise<ProjectRecord> {
  const projectDir = resolve(getProjectsRoot(), project.id);
  const projectJsonPath = resolve(projectDir, "project.json");
  const statePath = resolve(projectDir, STATE_FILE_DEFAULT);
  const artifactsPath = resolve(projectDir, ARTIFACTS_DIR_DEFAULT);
  const repoContextsPath = resolve(projectDir, "repoContexts");

  if (await fileExists(projectJsonPath)) {
    throw new Error(`Project already exists: ${projectJsonPath}`);
  }

  await mkdir(projectDir, { recursive: true });
  await mkdir(artifactsPath, { recursive: true });
  await mkdir(repoContextsPath, { recursive: true });

  const projectJson = {
    id: project.id,
    name: project.name,
    description: project.description,
    stateFile: STATE_FILE_DEFAULT,
    artifactsDir: ARTIFACTS_DIR_DEFAULT,
    repos: project.repos,
    repoContexts: [],
    tags: project.tags,
  };

  await writeFile(projectJsonPath, `${JSON.stringify(projectJson, null, 2)}\n`, "utf8");
  await writeFile(statePath, await buildInitialStateMarkdown(project), "utf8");

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    dir: projectDir,
    stateFile: STATE_FILE_DEFAULT,
    artifactsDir: ARTIFACTS_DIR_DEFAULT,
    repos: project.repos,
    repoContexts: [],
    tags: project.tags,
  };
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
  sections.push(`Project: ${project.name}`);
  if (mode) sections.push(`Current Mode: ${mode}`);
  sections.push(`Project ID: ${project.id}`);
  sections.push(`Project Directory: ${project.dir}`);
  sections.push(`State File: ${statePath}`);
  sections.push(`Artifacts Directory: ${artifactsPath}`);
  sections.push(`Control Root: ${getControlRoot()}`);
  sections.push(`Current Working Directory: ${resolvedCwd}`);
  if (repoRoot) sections.push(`Active Repo Root: ${repoRoot}`);

  if (project.description) sections.push(`Description: ${project.description}`);

  if (project.repos.length > 0) {
    sections.push("Linked Repositories:");
    for (const repo of project.repos) {
      const extras = [repo.name, repo.role].filter(Boolean).join(" · ");
      sections.push(`- ${repo.path}${extras ? ` (${extras})` : ""}`);
    }
  }

  if (project.tags.length > 0) sections.push(`Tags: ${project.tags.join(", ")}`);

  if (await fileExists(statePath)) {
    const stateContent = truncate(await readFile(statePath, "utf8"));
    sections.push("\nProject State:\n```md");
    sections.push(stateContent);
    sections.push("```");
  } else {
    sections.push("\nProject State: [missing state file]");
  }

  const shutdownArtifactPath = resolve(artifactsPath, "latest-shutdown.md");
  if (await fileExists(shutdownArtifactPath)) {
    const shutdownArtifact = truncate(await readFile(shutdownArtifactPath, "utf8"), 12000);
    sections.push(`\nLatest Shutdown Artifact: ${shutdownArtifactPath}\n\`\`\`md`);
    sections.push(shutdownArtifact);
    sections.push("```\n");
  } else {
    sections.push(`\nLatest Shutdown Artifact: [missing] ${shutdownArtifactPath}`);
  }

  for (const relativePath of project.repoContexts) {
    const absolutePath = resolve(project.dir, relativePath);
    if (!(await fileExists(absolutePath))) continue;
    const content = truncate(await readFile(absolutePath, "utf8"), 12000);
    sections.push(`\nProject Context File: ${absolutePath}\n\`\`\`md`);
    sections.push(content);
    sections.push("```\n");
  }

  sections.push(
    `\nStartup/resume guidance: always review the active project state file (${statePath}) first, then check the rolling shutdown artifact (${shutdownArtifactPath}) for the latest persisted session checkpoint before planning or editing.`,
  );

  sections.push(
    `\nArtifact rule: write generated artifacts under ${artifactsPath}. In plan mode, repository files stay read-only while state/artifacts remain writable.`,
  );

  return sections.join("\n");
}
