/**
 * resources.ts — static resource loading and tool/mode configuration.
 *
 * This module owns:
 *   - Prompt fragment path constants and the async fragment cache/loader
 *   - Targeted file access policy/types/helpers for disciplined reads and searches
 *   - Bash command safety classification (DESTRUCTIVE/SAFE patterns, isSafeCommand)
 *   - Mode tool allowlists and getModeTools
 *   - JIRA_TMP_PREFIX
 *   - Mode descriptor types, MODE_DESCRIPTORS map, and getModeDescriptor
 *   - Mode display formatters (formatMode, projectStatusLine)
 *
 * All exports are pure or cheap-to-compute. Nothing here holds mutable state
 * except the prompt-fragment cache, which is a private lazy-load optimization.
 *
 * Import direction: workflow-mode.ts → resources.ts → runtime.ts
 *                                                    → projects.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Mode } from "./runtime.js";
import { type ProjectRecord } from "./projects.js";

// ─── Misc constants ─────────────────────────────────────────────────────────────

/** Prefix for ephemeral Jira closeout drafts written in plan mode. */
export const JIRA_TMP_PREFIX = "/tmp/jira-closeout-";

// ─── Targeted file access policy ────────────────────────────────────────────────

export interface ReadAccessPolicy {
  maxDirectReadLines: number;
  maxDirectReadBytes: number;
  requireWindowedReadAboveLines: number;
  blockRepeatedFullReads: boolean;
}

export interface SearchAccessPolicy {
  defaultSearchLimit: number;
  maxSearchLimit: number;
  requireGlobForWideSearch: boolean;
}

export interface TargetedAccessPolicy {
  read: ReadAccessPolicy;
  search: SearchAccessPolicy;
}

const DEFAULT_READ_ACCESS_POLICY: ReadAccessPolicy = {
  maxDirectReadLines: 200,
  maxDirectReadBytes: 16 * 1024,
  requireWindowedReadAboveLines: 200,
  blockRepeatedFullReads: true,
};

const DEFAULT_SEARCH_ACCESS_POLICY: SearchAccessPolicy = {
  defaultSearchLimit: 20,
  maxSearchLimit: 100,
  requireGlobForWideSearch: true,
};

const TARGETED_ACCESS_POLICIES: Record<Mode, TargetedAccessPolicy> = {
  normal: { read: DEFAULT_READ_ACCESS_POLICY, search: DEFAULT_SEARCH_ACCESS_POLICY },
  creative: { read: DEFAULT_READ_ACCESS_POLICY, search: DEFAULT_SEARCH_ACCESS_POLICY },
  plan: { read: DEFAULT_READ_ACCESS_POLICY, search: DEFAULT_SEARCH_ACCESS_POLICY },
  readonly: { read: DEFAULT_READ_ACCESS_POLICY, search: DEFAULT_SEARCH_ACCESS_POLICY },
};

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}

function normalizeSearchPath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isMeaningfullyNarrowingGlob(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const glob = value.trim();
  if (glob.length === 0) return false;
  return !["*", "**", "**/*", "./**/*", "./**", "./*"].includes(glob);
}

function hasMeaningfulFindNarrowing(input: Record<string, unknown>): boolean {
  return isMeaningfullyNarrowingGlob(input.pattern) || isMeaningfullyNarrowingGlob(input.glob);
}

export function getTargetedAccessPolicy(mode: Mode): TargetedAccessPolicy {
  return TARGETED_ACCESS_POLICIES[mode];
}

export function getReadAccessPolicy(mode: Mode): ReadAccessPolicy {
  return getTargetedAccessPolicy(mode).read;
}

export function getSearchAccessPolicy(mode: Mode): SearchAccessPolicy {
  return getTargetedAccessPolicy(mode).search;
}

export function isWindowedReadRequest(input: Record<string, unknown>): boolean {
  return parsePositiveInteger(input.offset) !== undefined || parsePositiveInteger(input.limit) !== undefined;
}

export function getRequestedReadLimit(input: Record<string, unknown>): number | undefined {
  return parsePositiveInteger(input.limit);
}

export function getRequestedSearchLimit(input: Record<string, unknown>): number | undefined {
  return parsePositiveInteger(input.limit);
}

export function hasReasonableSearchLimit(input: Record<string, unknown>, mode: Mode): boolean {
  const requested = getRequestedSearchLimit(input);
  return requested === undefined || requested <= getSearchAccessPolicy(mode).maxSearchLimit;
}

export function getEffectiveSearchLimit(input: Record<string, unknown>, mode: Mode): number {
  const requested = getRequestedSearchLimit(input);
  if (requested !== undefined && requested <= getSearchAccessPolicy(mode).maxSearchLimit) return requested;
  return getSearchAccessPolicy(mode).defaultSearchLimit;
}

export function isBroadSearchPath(searchPath: unknown, cwd?: string, repoRoot?: string): boolean {
  const normalized = normalizeSearchPath(searchPath);
  if (!normalized) return true;
  if ([".", "./", "/"].includes(normalized)) return true;
  const base = repoRoot ?? cwd;
  if (!base) return false;
  return resolve(base, normalized) === base;
}

export function requiresSearchGlob(
  input: Record<string, unknown>,
  cwd: string | undefined,
  repoRoot: string | undefined,
  mode: Mode,
  toolName: "grep" | "find" = "grep",
): boolean {
  if (!getSearchAccessPolicy(mode).requireGlobForWideSearch) return false;
  if (!isBroadSearchPath(input.path, cwd, repoRoot)) return false;
  if (toolName === "find") return !hasMeaningfulFindNarrowing(input);
  return !isMeaningfullyNarrowingGlob(input.glob);
}

export function isBroadInspectionBash(command: string): boolean {
  const segments = command
    .split(/&&|\|\||;|\|(?!\|)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.some((segment) => [
    /^find\s+(\.\s*|\/|\$PWD\b)/i,
    /^rg\b/i,
    /^grep\s+-R\b.*\s(\.\s*|\/|\$PWD\b)/i,
    /^ls\s+-R\b/i,
    /^tree\b(?:\s+\.?)?$/i,
    /^nl\s+-ba\b/i,
    /^sed\s+-n\b.*\s+\S+\s*$/i,
  ].some((pattern) => pattern.test(segment)));
}

// ─── Mode tool allowlists ───────────────────────────────────────────────────────

const READONLY_TOOL_ALLOWLIST = new Set(["read", "grep", "find", "ls"]);
const PLAN_TOOL_ALLOWLIST = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

// ─── Bash command safety ────────────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i, /\btruncate\b/i,
  /\bdd\b/i, /\bshred\b/i, /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i, /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i, /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i, /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
  /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
  /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/,
  /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/, /^\s*printenv\b/,
  /^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/, /^\s*uptime\b/,
  /^\s*ps\b/, /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i, /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i, /^\s*node\s+--version/i, /^\s*python\s+--version/i,
  /^\s*curl\s/i, /^\s*wget\s+-O\s*-/i, /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
  /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*exa\b/,
];

/**
 * Return true if `command` is safe to run in plan mode.
 *
 * A command is safe only if it matches no destructive pattern AND matches at
 * least one safe pattern. Unknown commands (matching neither list) are blocked.
 */
export function isSafeCommand(command: string): boolean {
  const destructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const safe = SAFE_PATTERNS.some((p) => p.test(command));
  return !destructive && safe;
}

// ─── Prompt fragment path constants ────────────────────────────────────────────
// Defined before MODE_DESCRIPTORS so descriptor promptPath fields can reference them.

export const CHANGE_PROPOSAL_WORKFLOW_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/change-proposal-workflow.md", import.meta.url));
export const TARGETED_FILE_ACCESS_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/targeted-file-access.md", import.meta.url));
export const COMPUTE_IN_VM_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/compute-in-vm.md", import.meta.url));
export const SECRET_SAFETY_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/secret-safety.md", import.meta.url));
export const MODE_NORMAL_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-normal.md", import.meta.url));
export const MODE_READONLY_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-readonly.md", import.meta.url));
export const MODE_PLAN_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-plan.md", import.meta.url));
export const MODE_CREATIVE_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-creative.md", import.meta.url));
export const PROJECT_CONTEXT_GUIDANCE_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/project-context-guidance.md", import.meta.url));

// ─── Mode descriptor types ──────────────────────────────────────────────────────

export type ThemeColor = "accent" | "warning" | "muted" | "error" | "info";

export interface ModeWritePolicy {
  /** true = allow any write that passes the approval gate */
  unrestricted: boolean;
  /** true = only project state file + artifacts dir + jira prefix are writable */
  projectScopeOnly: boolean;
  /** true = all writes and bash mutations are blocked */
  blocked: boolean;
}

export interface ModeDescriptor {
  key: Mode;
  // display
  label: string;
  emoji: string;
  themeColor: ThemeColor;
  // tools
  toolAllowlist: Set<string> | null; // null = all tools
  // prompts
  promptPath: string;
  // notifications (called after mode switch)
  notification: (project: { name: string } | null) => string;
  // behavior
  writePolicy: ModeWritePolicy;
  requiresSafeBash: boolean;
  // persistence
  persistAcrossRestart: boolean;
}

// ─── Mode descriptor map ────────────────────────────────────────────────────────

export const MODE_DESCRIPTORS: Record<Mode, ModeDescriptor> = {
  plan: {
    key: "plan",
    label: "plan",
    emoji: "📋",
    themeColor: "accent",
    toolAllowlist: PLAN_TOOL_ALLOWLIST,
    promptPath: MODE_PLAN_PROMPT_PATH,
    notification: (project) =>
      project
        ? `Plan mode enabled. Claude Opus 4.6 is the default model with GPT-5.4 as the alternate; project state and artifacts stay writable for (${project.id}) ${project.name}.`
        : "Plan mode enabled. Claude Opus 4.6 is the default model with GPT-5.4 as the alternate. Load a project to allow state/artifact writes.",
    writePolicy: { unrestricted: false, projectScopeOnly: true, blocked: false },
    requiresSafeBash: true,
    persistAcrossRestart: false,
  },
  normal: {
    key: "normal",
    label: "normal",
    emoji: "✍",
    themeColor: "muted",
    toolAllowlist: null,
    promptPath: MODE_NORMAL_PROMPT_PATH,
    notification: () => "Normal mode enabled. Full tool access restored with GPT-5.4 as the default model and Sonnet 4.5 as the alternate.",
    writePolicy: { unrestricted: true, projectScopeOnly: false, blocked: false },
    requiresSafeBash: false,
    persistAcrossRestart: false,
  },
  readonly: {
    key: "readonly",
    label: "readonly",
    emoji: "🔒",
    themeColor: "warning",
    toolAllowlist: READONLY_TOOL_ALLOWLIST,
    promptPath: MODE_READONLY_PROMPT_PATH,
    notification: () => "Read-only mode enabled. Only inspection tools remain active.",
    writePolicy: { unrestricted: false, projectScopeOnly: false, blocked: true },
    requiresSafeBash: false,
    persistAcrossRestart: true,
  },
  creative: {
    key: "creative",
    label: "creative",
    emoji: "🎨",
    themeColor: "accent",
    toolAllowlist: null,
    promptPath: MODE_CREATIVE_PROMPT_PATH,
    notification: () => "Creative mode enabled. Normal-mode permissions with all configured models available via /model.",
    writePolicy: { unrestricted: true, projectScopeOnly: false, blocked: false },
    requiresSafeBash: false,
    persistAcrossRestart: false,
  },
};

// ─── Mode descriptor helpers ────────────────────────────────────────────────────

/** Return the descriptor for the given mode. */
export function getModeDescriptor(mode: Mode): ModeDescriptor {
  return MODE_DESCRIPTORS[mode];
}

/**
 * Filter `baseTools` to the subset allowed for `mode`.
 * Normal mode (toolAllowlist === null) returns all tools unchanged.
 */
export function getModeTools(baseTools: string[], mode: Mode): string[] {
  const { toolAllowlist } = getModeDescriptor(mode);
  if (toolAllowlist === null) return baseTools;
  return baseTools.filter((t) => toolAllowlist.has(t));
}

// ─── Mode display ───────────────────────────────────────────────────────────────

export function formatMode(mode: Mode): string {
  const { emoji, label } = getModeDescriptor(mode);
  return `${emoji} ${label}`;
}

export function projectStatusLine(project: ProjectRecord | null, mode: Mode): string {
  if (!project) return formatMode(mode);
  return `(${project.id}) ${project.name} · ${formatMode(mode)}`;
}

// ─── Prompt fragment loading ────────────────────────────────────────────────────

/** Module-level prompt fragment cache. Content is stable across a session. */
const promptFragmentCache = new Map<string, string>();

/**
 * Read and cache a prompt fragment file.
 * The cache is never invalidated; restart `cogi` to pick up changes to fragments.
 */
export async function readPromptFragment(path: string): Promise<string> {
  const cached = promptFragmentCache.get(path);
  if (cached !== undefined) return cached;
  const content = (await readFile(path, "utf8")).trim();
  promptFragmentCache.set(path, content);
  return content;
}
