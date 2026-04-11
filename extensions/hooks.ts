/**
 * hooks.ts — lifecycle hook registration for the Cogitator workflow extension.
 *
 * This module owns:
 *   - All pi.on(...) calls and the event names they bind to
 *
 * Handler implementations live in workflow-mode.ts as closures over WorkflowRuntimeState.
 * This file receives them as a typed HookHandlers object and binds them to their events.
 *
 * Return-type aliases are defined here so the expected shapes are explicit and consistent
 * across the handler implementations in workflow-mode.ts.
 *
 * Import direction: workflow-mode.ts → hooks.ts (never the reverse).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Per-event return types ────────────────────────────────────────────────────

export type InputResult =
  | { action: "transform"; text: string }
  | { action: "handled" }
  | { action: "continue" };

export type ToolCallResult = { block: boolean; reason?: string } | undefined;

export type BeforeAgentStartResult =
  | {
      systemPrompt?: string;
      message?: { customType: string; content: string; display: boolean };
    }
  | undefined;

// ─── Hook handler signatures ───────────────────────────────────────────────────

export type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
export type SessionTreeHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
export type SessionShutdownHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

export type InputHandler = (
  event: { text: string },
  ctx: ExtensionContext,
) => Promise<InputResult> | InputResult;

export type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
  cwd?: string;
}) => Promise<BeforeAgentStartResult> | BeforeAgentStartResult;

export type AgentEndHandler = (
  event: { messages: unknown[] },
  ctx: ExtensionContext,
) => Promise<void> | void;

export type ToolCallHandler = (
  event: { toolName: string; input: Record<string, unknown> },
  ctx: ExtensionContext,
) => Promise<ToolCallResult> | ToolCallResult;

// ─── Handler bundle ────────────────────────────────────────────────────────────

export interface HookHandlers {
  session_start: SessionStartHandler;
  session_tree: SessionTreeHandler;
  session_shutdown: SessionShutdownHandler;
  input: InputHandler;
  before_agent_start: BeforeAgentStartHandler;
  agent_end: AgentEndHandler;
  tool_call: ToolCallHandler;
}

// ─── Registration ──────────────────────────────────────────────────────────────

/**
 * Register all Cogitator lifecycle hooks with the pi extension API.
 *
 * Call this once from workflowModeExtension after all handler closures are ready.
 */
export function registerHooks(pi: ExtensionAPI, hooks: HookHandlers): void {
  pi.on("session_start", hooks.session_start);
  pi.on("session_tree", hooks.session_tree);
  pi.on("session_shutdown", hooks.session_shutdown);
  pi.on("input", hooks.input);
  pi.on("before_agent_start", hooks.before_agent_start);
  pi.on("agent_end", hooks.agent_end);
  pi.on("tool_call", hooks.tool_call);
}
