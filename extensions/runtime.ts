import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ─── Mode ─────────────────────────────────────────────────────────────────────

export type Mode = "normal" | "readonly" | "plan" | "creative";

// ─── Session-entry storage shapes ─────────────────────────────────────────────

interface StoredModeState {
  mode: Mode;
}

interface StoredProjectSelection {
  projectId: string | null;
}

// ─── Mode persistence ──────────────────────────────────────────────────────────

export function persistMode(pi: ExtensionAPI, mode: Mode): void {
  pi.appendEntry<StoredModeState>("workflow-mode", { mode });
}

export function restoreMode(ctx: ExtensionContext): Mode | undefined {
  let restored: Mode | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "workflow-mode") {
      const data = entry.data as StoredModeState | undefined;
      if (
        data?.mode === "normal" ||
        data?.mode === "readonly" ||
        data?.mode === "plan" ||
        data?.mode === "creative"
      ) {
        restored = data.mode;
      } else if (data?.mode === "architect") {
        restored = "plan";
      } else if (data?.mode === "executor") {
        restored = "normal";
      }
    }
  }
  return restored;
}

// ─── Project selection persistence ────────────────────────────────────────────

export function persistProjectSelection(pi: ExtensionAPI, projectId: string | null): void {
  pi.appendEntry<StoredProjectSelection>("cogitator-project", { projectId });
}

export function restoreStoredProjectId(ctx: ExtensionContext): string | null | undefined {
  let restored: string | null | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "cogitator-project") {
      const data = entry.data as StoredProjectSelection | undefined;
      if (data && (typeof data.projectId === "string" || data.projectId === null)) {
        restored = data.projectId;
      }
    }
  }
  return restored;
}
