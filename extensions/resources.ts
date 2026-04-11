/**
 * resources.ts — static resource loading and tool/mode configuration.
 *
 * This module owns:
 *   - Prompt fragment path constants and the async fragment cache/loader
 *   - Bash command safety classification (DESTRUCTIVE/SAFE patterns, isSafeCommand)
 *   - Mode tool allowlists and getModeTools
 *   - Protected path constant and loadProtectedPaths
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
import { fileURLToPath } from "node:url";
import { type Mode } from "./runtime.js";
import { type ProjectRecord } from "./projects.js";

// ─── Misc constants ─────────────────────────────────────────────────────────────

/** Prefix for ephemeral Jira closeout drafts written in plan mode. */
export const JIRA_TMP_PREFIX = "/tmp/jira-closeout-";

// ─── Protected paths ────────────────────────────────────────────────────────────

const PROTECTED_SECRET_ROOT = "/run/cogitator-secrets";

/** Return the list of filesystem paths that are always blocked from agent access. */
export function loadProtectedPaths(): string[] {
  return [PROTECTED_SECRET_ROOT];
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
export const SECRET_SAFETY_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/secret-safety.md", import.meta.url));
export const MODE_NORMAL_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-normal.md", import.meta.url));
export const MODE_READONLY_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-readonly.md", import.meta.url));
export const MODE_PLAN_PROMPT_PATH = fileURLToPath(new URL("../resources/prompts/mode-plan.md", import.meta.url));
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
        ? `Plan mode enabled. Project state and artifacts stay writable for ${project.name}.`
        : "Plan mode enabled. Load a project to allow state/artifact writes.",
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
    notification: () => "Normal mode enabled. Full tool access restored.",
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
  return `${project.name} · ${formatMode(mode)}`;
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
