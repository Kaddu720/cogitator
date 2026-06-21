/**
 * projects.ts — markdown-first project store, selection metadata, and context.
 *
 * Projects are plain markdown state files in a flat directory (default
 * ~/Projects/projectStates), one file per project. There is no project.json and
 * no central control root for project records. `INDEX.md` (when present) supplies
 * curated names/statuses/ordering; `ARCHIVE.md` and `INDEX.md` are not projects.
 * Artifacts (incl. shutdown checkpoints) live under `<store>/artifacts/<slug>/` so
 * cogitator never mutates the (Jira-synced) state files.
 *
 * Import direction: workflow-mode.ts → projects.ts (never the reverse).
 */

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve, basename } from "node:path";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectRecord {
  /** Filename slug without the .md extension, e.g. "sre-3382-ship-vm-to-k8s-migration". */
  id: string;
  /** Display name from INDEX.md, the file's first `# ` heading, or a titleized id. */
  name: string;
  /** Absolute path to the project's markdown state file. */
  statePath: string;
  /** Absolute path to this project's artifacts directory (<store>/artifacts/<id>). */
  artifactsDir: string;
  /** Lifecycle status from INDEX.md or the state file, when known. */
  status?: string;
}

export interface NewProjectWizardResult {
  id: string;
  name: string;
  description?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_PROJECT_STATES_DIR = "/home/kaddu/Projects/projectStates";
const ARTIFACTS_DIRNAME = "artifacts";
const INDEX_FILENAME = "INDEX.md";
const ARCHIVE_FILENAME = "ARCHIVE.md";
/** Files in the store that are not themselves projects. */
const NON_PROJECT_FILES = new Set([INDEX_FILENAME.toLowerCase(), ARCHIVE_FILENAME.toLowerCase()]);

/** Maximum characters included when embedding file content into project context. */
const PROJECT_CONTEXT_LIMIT = 32000;

const STATUS_TOKENS = ["in_progress", "todo", "blocked", "done", "deferred"];

// ─── Store path helpers ──────────────────────────────────────────────────────────

export function getProjectStatesDir(): string {
  return process.env.COGITATOR_PROJECT_STATES_DIR || DEFAULT_PROJECT_STATES_DIR;
}

export function getArtifactsRoot(): string {
  return resolve(getProjectStatesDir(), ARTIFACTS_DIRNAME);
}

export function getIndexPath(): string {
  return resolve(getProjectStatesDir(), INDEX_FILENAME);
}

// ─── Shared path utilities ─────────────────────────────────────────────────────

export function getResolutionBase(cwd: string | undefined, repoRoot?: string): string {
  if (typeof cwd === "string") {
    const trimmed = cwd.trim();
    if (trimmed.length > 0 && trimmed !== "undefined") return trimmed;
  }
  if (repoRoot) return repoRoot;
  const processCwd = process.cwd();
  if (processCwd) return processCwd;
  return getProjectStatesDir();
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

// ─── Project ID / name helpers ──────────────────────────────────────────────────

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

function projectIdFromFilename(filename: string): string {
  return basename(filename).replace(/\.md$/i, "");
}

function extractFirstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || undefined;
}

/** Best-effort status from a state file: `Status: **x**`, `- status: \`x\``, etc. */
function extractStatusFromState(markdown: string): string | undefined {
  const match = markdown.match(/^\s*-?\s*status:\s*[`*]*([a-z_]+)[`*]*/mi);
  const token = match?.[1]?.toLowerCase();
  return token && STATUS_TOKENS.includes(token) ? token : undefined;
}

// ─── Project path helpers ──────────────────────────────────────────────────────

export function getProjectStatePath(project: ProjectRecord): string {
  return project.statePath;
}

export function getProjectArtifactsPath(project: ProjectRecord): string {
  return project.artifactsDir;
}

/**
 * Returns true if `path` is the active project's state file and therefore
 * exempt from the approval gate in both normal and plan mode.
 */
export function isApprovalExemptPath(path: string, project: ProjectRecord | null): boolean {
  if (!project) return false;
  return path === getProjectStatePath(project);
}

// ─── INDEX.md parsing ────────────────────────────────────────────────────────────

interface IndexEntry {
  name: string;
  status?: string;
  /** Encounter order in INDEX.md, used for display ordering. */
  order: number;
}

/**
 * Parse INDEX.md for project display names, statuses, and ordering. Recognizes
 * any line containing a markdown link to a `*.md` file (table rows or bullets);
 * a status token elsewhere on the line is captured when present.
 */
function parseIndex(indexText: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  let order = 0;
  for (const line of indexText.split(/\r?\n/)) {
    const link = line.match(/\[([^\]]+)\]\(([^)]+\.md)\)/);
    if (!link) continue;
    const id = projectIdFromFilename(link[2]);
    if (NON_PROJECT_FILES.has(`${id}.md`.toLowerCase())) continue;
    if (entries.has(id)) continue;
    const statusToken = STATUS_TOKENS.find((t) => new RegExp(`\\b${t}\\b`, "i").test(line));
    entries.set(id, { name: link[1].trim(), status: statusToken, order: order++ });
  }
  return entries;
}

// ─── Project loading ────────────────────────────────────────────────────────────

export async function loadProjects(): Promise<ProjectRecord[]> {
  const dir = getProjectStatesDir();
  const artifactsRoot = getArtifactsRoot();

  let dirEntries: Awaited<ReturnType<typeof readdir>>;
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  let index = new Map<string, IndexEntry>();
  try {
    index = parseIndex(await readFile(getIndexPath(), "utf8"));
  } catch {
    // No INDEX.md — fall back to directory listing only.
  }

  const projects: ProjectRecord[] = [];
  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    if (NON_PROJECT_FILES.has(entry.name.toLowerCase())) continue;

    const id = projectIdFromFilename(entry.name);
    const statePath = resolve(dir, entry.name);
    const indexed = index.get(id);

    let name = indexed?.name;
    let status = indexed?.status;
    if (!name || !status) {
      try {
        const text = await readFile(statePath, "utf8");
        name = name ?? extractFirstHeading(text);
        status = status ?? extractStatusFromState(text);
      } catch {
        // Unreadable file; fall back to a titleized id below.
      }
    }

    projects.push({
      id,
      name: name ?? titleizeProjectId(id),
      statePath,
      artifactsDir: resolve(artifactsRoot, id),
      status,
    });
  }

  // INDEX.md order first (curated), then any remaining files alphabetically.
  return projects.sort((a, b) => {
    const ao = index.get(a.id)?.order ?? Number.MAX_SAFE_INTEGER;
    const bo = index.get(b.id)?.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.id.localeCompare(b.id);
  });
}

export async function loadProjectById(id: string): Promise<ProjectRecord | null> {
  return (await loadProjects()).find((p) => p.id === id) ?? null;
}

// ─── Project scaffolding ────────────────────────────────────────────────────────

/** Build a minimal markdown state file for a new project. */
export function buildInitialStateMarkdown(project: NewProjectWizardResult): string {
  const today = new Date().toISOString().slice(0, 10);
  const description = project.description?.trim();
  return [
    `# ${project.name}`,
    "",
    "## Executive Summary",
    `Status: **todo** (\`${today}\`)`,
    "",
    description && description.length > 0 ? description : "_Describe the goal and scope of this project._",
    "",
    "## Background & Context",
    "- status: `todo`",
    "",
    "## Progress Tracking",
    "- todo:",
    "  - Define the initial goal and first concrete workstream.",
    "- in_progress:",
    "- blocked:",
    "- done:",
    "- deferred:",
    "",
    "## Next Steps",
    "- Review this scaffold and replace placeholders with real context.",
    "",
  ].join("\n");
}

export async function createProjectScaffold(project: NewProjectWizardResult): Promise<ProjectRecord> {
  const dir = getProjectStatesDir();
  const statePath = resolve(dir, `${project.id}.md`);

  if (await fileExists(statePath)) {
    throw new Error(`Project state file already exists: ${statePath}`);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(statePath, buildInitialStateMarkdown(project), "utf8");

  return {
    id: project.id,
    name: project.name,
    statePath,
    artifactsDir: resolve(getArtifactsRoot(), project.id),
    status: "todo",
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
  sections.push(`Project: (${project.id}) ${project.name}`);
  if (project.status) sections.push(`Status: ${project.status}`);
  if (mode) sections.push(`Current Mode: ${mode}`);
  sections.push(`State File: ${statePath}`);
  sections.push(`Artifacts Directory: ${artifactsPath}`);
  sections.push(`Project States Directory: ${getProjectStatesDir()}`);
  sections.push(`Current Working Directory: ${resolvedCwd}`);
  if (repoRoot) sections.push(`Active Repo Root: ${repoRoot}`);

  const shutdownArtifactPath = resolve(artifactsPath, "latest-shutdown.md");

  // Inline compact state summary — avoids embedding full file contents.
  // (project-state.ts imports from projects.ts so we cannot import back.)
  function extractSection(md: string, heading: string): string {
    const m = md.match(new RegExp(`(?:^|\\n)## ${escapeRegExp(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m?.[1]?.trim() ?? "";
  }
  function bulletValue(section: string, label: string): string {
    return section.match(new RegExp(`^\\s*-?\\s*${escapeRegExp(label)}:\\s*[\`*]*([^\`*\n]+)`, "mi"))?.[1]?.trim() ?? "[none]";
  }
  function indentedBullets(section: string, label: string): string[] {
    const lines = section.split(/\r?\n/);
    const items: string[] = [];
    let collecting = false;
    for (const line of lines) {
      if (!collecting) { if (line.trim().toLowerCase() === `- ${label}:`.toLowerCase()) collecting = true; continue; }
      const m = line.match(/^\s{2,}-\s+(.*)$/);
      if (m) { const v = m[1].trim(); if (v) items.push(v); continue; }
      if (/^-\s+/.test(line.trim()) || line.trim().length === 0) { if (!m) break; }
    }
    return items;
  }
  function truncateInline(text: string, max = 200): string {
    const s = text.replace(/\s+/g, " ").trim();
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
  }

  if (await fileExists(statePath)) {
    const stateText = await readFile(statePath, "utf8");
    const execSec = extractSection(stateText, "Executive Summary");
    const progressSec = extractSection(stateText, "Progress Tracking");
    const nextStepsSec = extractSection(stateText, "Next Steps");
    const countItems = (label: string) => indentedBullets(progressSec, label).length;
    const nextSteps = nextStepsSec.split(/\r?\n/).map(l => l.match(/^\s*-\s+(.*)$/)?.[1]?.trim() ?? "").filter(Boolean);
    const progressCounts = ["todo", "in_progress", "blocked", "done", "deferred"].map(k => `${k}=${countItems(k)}`).join(", ");
    sections.push([
      "\nProject State Summary:",
      `- state_file: ${statePath}`,
      `- status: ${project.status ?? bulletValue(execSec, "Status")}`,
      `- progress_counts: ${progressCounts}`,
      `- next_steps: ${nextSteps.length ? truncateInline(nextSteps.join(" | ")) : "[none]"}`,
    ].join("\n"));
  } else {
    sections.push(`\nProject State Summary:\n- state_file: ${statePath}\n- status: [missing state file]`);
  }

  sections.push(`\nLatest Shutdown Artifact: ${await fileExists(shutdownArtifactPath) ? shutdownArtifactPath : `[missing] ${shutdownArtifactPath}`}`);

  sections.push(
    `\nStartup/resume guidance: at session start or resume, read the full active project state file (${statePath}) first, then check the rolling shutdown artifact (${shutdownArtifactPath}) for the latest persisted session checkpoint before planning or editing. After that, reuse what you already learned unless those files changed or the task specifically requires refreshed project-tracking context. Do not reread these files on every subsequent task.`,
  );

  sections.push(
    `\nArtifact rule: write generated artifacts under ${artifactsPath}. The project state file is your source of truth; cogitator does not maintain a separate copy. In plan mode, repository files stay read-only while the state file and artifacts remain writable.`,
  );

  return sections.join("\n");
}
