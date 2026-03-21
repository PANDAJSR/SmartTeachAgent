import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_CLAUDE_WORKSPACE = join(homedir(), ".SmartTeachAgent", "workspace");

function parseCsvEnv(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function resolvePermissionMode(): Options["permissionMode"] {
  const mode = (process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions").trim();

  if (
    mode === "default" ||
    mode === "acceptEdits" ||
    mode === "bypassPermissions" ||
    mode === "plan" ||
    mode === "dontAsk"
  ) {
    return mode;
  }

  return "bypassPermissions";
}

export function buildClaudeOptions(): Options {
  const permissionMode = resolvePermissionMode();
  // Ensure the custom Claude workspace exists; otherwise process spawn may fail with ENOENT.
  mkdirSync(DEFAULT_CLAUDE_WORKSPACE, { recursive: true });

  const options: Options = {
    maxTurns: Number(process.env.CLAUDE_MAX_TURNS || DEFAULT_MAX_TURNS),
    tools: { type: "preset", preset: "claude_code" },
    permissionMode,
    cwd: DEFAULT_CLAUDE_WORKSPACE,
    env: {
      ...process.env,
    },
  };

  if (permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  const allowedTools = parseCsvEnv(process.env.CLAUDE_ALLOWED_TOOLS);
  if (allowedTools) {
    options.allowedTools = allowedTools;
  }

  const disallowedTools = parseCsvEnv(process.env.CLAUDE_DISALLOWED_TOOLS);
  if (disallowedTools) {
    options.disallowedTools = disallowedTools;
  }

  const model = (process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "").trim();
  if (model) {
    options.model = model;
  }

  return options;
}
