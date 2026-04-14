# Mode System

## Available modes

| Mode | Emoji | Permissions | Default model | Persists across restart |
|------|-------|-------------|---------------|------------------------|
| `plan` | 📋 | Project-scope writes only, safe bash only | Claude Opus 4.6 | No |
| `normal` | ✍ | Full tools, unrestricted writes | GPT-5.4-mini | No |
| `readonly` | 🔒 | Read-only tools only | (unchanged) | Yes |
| `creative` | 🎨 | Same as normal | (all models via `/model`) | No |

> **Legacy note:** `architect` and `executor` were removed as real modes. `restoreMode()` in `runtime.ts` maps restored `architect` sessions to `plan` and `executor` sessions to `normal`.

## Mode descriptor

Each mode is defined by a `ModeDescriptor` record in `extensions/resources.ts`:

```ts
interface ModeDescriptor {
  key: Mode;
  label: string;
  emoji: string;
  themeColor: ThemeColor;
  toolAllowlist: Set<string> | null;  // null = all tools
  promptPath: string;
  notification: (project: { name: string } | null) => string;
  writePolicy: ModeWritePolicy;
  requiresSafeBash: boolean;
  persistAcrossRestart: boolean;
}
```

All four modes are defined in the `MODE_DESCRIPTORS` map. Adding a new mode requires:
1. Add the mode name to the `Mode` union in `runtime.ts`
2. Add the mode to the `restoreMode()` check in `runtime.ts`
3. Add a `ModeDescriptor` entry in `resources.ts`
4. Add a prompt fragment in `resources/prompts/mode-<name>.md`
5. Add a command handler in `workflow-mode.ts`
6. Register the command in `commands.ts`

## Write policies

```ts
interface ModeWritePolicy {
  unrestricted: boolean;     // allow any write that passes approval
  projectScopeOnly: boolean; // only state + artifacts + jira prefix
  blocked: boolean;          // all writes blocked
}
```

- `plan`: `{ unrestricted: false, projectScopeOnly: true, blocked: false }`
- `normal` / `creative`: `{ unrestricted: true, projectScopeOnly: false, blocked: false }`
- `readonly`: `{ unrestricted: false, projectScopeOnly: false, blocked: true }`

## Tool allowlists

- **Plan:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (bash restricted to safe commands)
- **Normal/Creative:** All tools (no allowlist filter)
- **Readonly:** `read`, `grep`, `find`, `ls`

## Prompt fragments

Each mode has a prompt fragment at `resources/prompts/mode-<name>.md` that is injected into the system prompt via `readPromptFragment()`. Active prompt files:
- `mode-plan.md`
- `mode-normal.md`
- `mode-readonly.md`
- `mode-creative.md`

## Persistence

Only `readonly` persists across restart (`persistAcrossRestart: true`). All other modes reset to `plan` on startup.
