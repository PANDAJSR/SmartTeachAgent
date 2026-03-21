export type ChatMeta = {
  costUsd?: number;
  durationMs?: number;
  turns?: number;
  stopReason?: string | null;
};

export type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

export type ToolStatus = "pending" | "running" | "completed" | "failed" | "stopped";

export type TextSegment = {
  type: "text";
  text: string;
};

export type ToolSegment = {
  type: "tool";
  text: string;
  toolName?: string;
  toolUseId?: string;
  status?: ToolStatus;
  output?: string;
};

export type ContentSegment = TextSegment | ToolSegment;

export type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ChatProgressSnapshot = {
  reply: string;
  trace: TraceEntry[];
  rendered: string;
  segments: ContentSegment[];
};

export type ChatResult = {
  reply: string;
  meta: ChatMeta | null;
  trace: TraceEntry[];
  rendered: string;
  segments: ContentSegment[];
  stopped?: boolean;
};
