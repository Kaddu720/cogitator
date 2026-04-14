/**
 * commands.ts — command and shortcut registration for the Cogitator workflow extension.
 *
 * This module owns:
 *   - All pi.registerCommand(...) calls and their descriptions
 *   - All pi.registerShortcut(...) calls and their descriptions
 *
 * Handler implementations live in workflow-mode.ts as closures over WorkflowRuntimeState.
 * This file receives them as typed objects and binds them to their names.
 *
 * Import direction: workflow-mode.ts → commands.ts (never the reverse).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type CommandHandler = (args: unknown, ctx: ExtensionContext) => Promise<void> | void;
export type ShortcutHandler = (ctx: ExtensionContext) => Promise<void> | void;

export interface CommandHandlers {
  project: CommandHandler;
  "new-project": CommandHandler;
  "project-status": CommandHandler;
  "add-repo": CommandHandler;
  "weekly-summary": CommandHandler;
  "approval-status": CommandHandler;
  reject: CommandHandler;
  defer: CommandHandler;
  normal: CommandHandler;
  readonly: CommandHandler;
  plan: CommandHandler;
  creative: CommandHandler;
  "alt-model": CommandHandler;
}

export interface ShortcutHandlers {
  "ctrl+alt+p": ShortcutHandler;
  "ctrl+alt+r": ShortcutHandler;
}

/**
 * Register all Cogitator commands and keyboard shortcuts with the pi extension API.
 *
 * Call this once from workflowModeExtension after all handler closures are ready.
 */
export function registerCommands(
  pi: ExtensionAPI,
  commands: CommandHandlers,
  shortcuts: ShortcutHandlers,
): void {
  pi.registerCommand("project", {
    description: "Select or switch the active cogitator project",
    handler: commands.project,
  });

  pi.registerCommand("new-project", {
    description: "Create a new cogitator project with an interactive wizard",
    handler: commands["new-project"],
  });

  pi.registerCommand("project-status", {
    description: "Show the active project and workflow mode",
    handler: commands["project-status"],
  });

  pi.registerCommand("add-repo", {
    description: "Add a linked repository to the active project",
    handler: commands["add-repo"],
  });

  pi.registerCommand("weekly-summary", {
    description: "Summarize the last 7 days of project state activity",
    handler: commands["weekly-summary"],
  });

  pi.registerCommand("approval-status", {
    description: "Show pending change approvals",
    handler: commands["approval-status"],
  });

  pi.registerCommand("reject", {
    description: "Reject pending or approved change proposals",
    handler: commands.reject,
  });

  pi.registerCommand("defer", {
    description: "Defer pending, approved, or needs-revision change proposals",
    handler: commands.defer,
  });

  pi.registerCommand("normal", {
    description: "Enable normal mode with full tool access and GPT-5.4-mini by default",
    handler: commands.normal,
  });

  pi.registerCommand("readonly", {
    description: "Toggle read-only mode",
    handler: commands.readonly,
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode with project state/artifact writes allowed and Claude Opus 4.6 by default",
    handler: commands.plan,
  });

  pi.registerCommand("creative", {
    description: "Enable creative mode with normal-mode permissions and free model selection",
    handler: commands.creative,
  });

  pi.registerCommand("alt-model", {
    description: "Toggle the current mode's alternate model when available",
    handler: commands["alt-model"],
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: shortcuts["ctrl+alt+p"],
  });

  pi.registerShortcut("ctrl+alt+r", {
    description: "Toggle read-only mode",
    handler: shortcuts["ctrl+alt+r"],
  });
}
