export type Role = "user" | "ai";

export type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

export type ContentSegment = {
  type: "text" | "tool";
  text: string;
  toolName?: string;
  toolUseId?: string;
  status?: "pending" | "running" | "completed" | "failed" | "stopped";
  output?: string;
};

export type ChatItem = {
  key: string;
  role: Role;
  content: string;
  streaming?: boolean;
  status?: "loading" | "success" | "error" | "abort";
  extraInfo?: {
    streaming?: boolean;
    trace?: TraceEntry[];
    segments?: ContentSegment[];
  };
};

export type ChatResponse = {
  reply?: string;
  rendered?: string;
  segments?: ContentSegment[];
  error?: string;
  trace?: TraceEntry[];
};

export type StreamEvent =
  | {
      type: "snapshot";
      reply: string;
      rendered: string;
      segments: ContentSegment[];
      trace: TraceEntry[];
    }
  | {
      type: "done";
    }
  | {
      type: "stopped";
    }
  | {
      type: "error";
      error: string;
    };

export type Conversation = {
  id: string;
  title: string;
  items: ChatItem[];
  createdAt: number;
};

export type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type AppConfig = {
  mcp?: {
    httpServers?: Array<{
      enabled?: boolean;
      name?: string;
      url?: string;
      headers?: Record<string, string>;
    }>;
    macHttpServer?: {
      enabled?: boolean;
      name?: string;
      url?: string;
      headers?: Record<string, string>;
    };
  };
};

export type McpServerDraft = {
  id: string;
  enabled: boolean;
  name: string;
  url: string;
  headersText: string;
};

export type McpTestResult = {
  ok: boolean;
  message: string;
};

export type AsrResult = {
  text?: string;
};

export type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<AsrResult>;
export type ChineseConverter = (input: string) => string;

export const MAX_HISTORY_TURNS = 24;
export const UI_LOG_PREFIX = "[SmartTeachAgent][renderer]";
export const DEFAULT_ASR_MODEL_ID = import.meta.env.VITE_ASR_MODEL_ID || "Xenova/whisper-base";
export const DEFAULT_EDGE_TTS_VOICE = import.meta.env.VITE_EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural";

export const ASR_MODEL_OPTIONS = [
  {
    label: "极速（中文）",
    value: "Xenova/whisper-tiny",
  },
  {
    label: "均衡（中文，推荐）",
    value: "Xenova/whisper-base",
  },
  {
    label: "高准确（中文）",
    value: "Xenova/whisper-small",
  },
] as const;

export const ASR_MODEL_SELECT_OPTIONS: { label: string; value: string }[] = [...ASR_MODEL_OPTIONS];

export const createConversation = (index: number): Conversation => {
  const now = Date.now();
  return {
    id: `conversation-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: `新对话 ${index}`,
    items: [],
    createdAt: now,
  };
};

export const createMcpServerDraft = (index = 0): McpServerDraft => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`,
  enabled: false,
  name: `http-server-${index + 1}`,
  url: "",
  headersText: "",
});

export const buildTitleFromInput = (text: string): string => {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) {
    return "";
  }
  return clean.length > 18 ? `${clean.slice(0, 18)}...` : clean;
};

export const formatConversationTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export const buildAiContent = (reply: string, streaming = false): string => {
  const text = reply.trim();
  if (text) {
    return text;
  }
  return streaming ? "思考中..." : "（无文本回复）";
};

export const buildHistoryTurns = (items: ChatItem[]): ChatHistoryTurn[] =>
  items
    .filter((item) => {
      if (item.role === "user") {
        return Boolean(item.content.trim());
      }
      if (item.role === "ai") {
        return item.status === "success" && Boolean(item.content.trim());
      }
      return false;
    })
    .map((item) => ({
      role: (item.role === "user" ? "user" : "assistant") as ChatHistoryTurn["role"],
      content: item.content.trim(),
    }))
    .slice(-MAX_HISTORY_TURNS);

export const getToolTitle = (segment: ContentSegment): string => {
  const toolName = segment.toolName || "工具调用";
  const statusMap: Record<NonNullable<ContentSegment["status"]>, string> = {
    pending: "待执行",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
  };
  if (!segment.status) {
    return toolName;
  }
  return `${toolName} · ${statusMap[segment.status]}`;
};

export const getToolSegmentKey = (segment: ContentSegment, index: number): string =>
  segment.toolUseId || `${segment.toolName || "tool"}-${index}-${segment.text.slice(0, 20)}`;
