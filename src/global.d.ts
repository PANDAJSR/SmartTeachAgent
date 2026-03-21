type ContentSegment = {
  type: "text" | "tool";
  text: string;
  toolName?: string;
  toolUseId?: string;
  status?: "pending" | "running" | "completed" | "failed" | "stopped";
  output?: string;
};

type ChatResponse = {
  reply?: string;
  rendered?: string;
  segments?: ContentSegment[];
  error?: string;
  meta?: unknown;
  trace?: Array<{
    type: "tool" | "thinking";
    text: string;
  }>;
};

type ChatStreamEvent =
  | {
      type: "snapshot";
      reply: string;
      rendered: string;
      segments: ContentSegment[];
      trace: Array<{
        type: "tool" | "thinking";
        text: string;
      }>;
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

type ChatHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

type AppConfig = {
  mcp?: {
    httpServers?: Array<{
      enabled?: boolean;
      name?: string;
      url?: string;
      headers?: Record<string, string>;
    }>;
  };
};

declare global {
  interface Window {
    smartTeach?: {
      chat: (message: string, history?: ChatHistoryTurn[]) => Promise<ChatResponse>;
      chatStream?: (
        message: string,
        requestId: string,
        history: ChatHistoryTurn[] | undefined,
        onEvent: (event: ChatStreamEvent) => void
      ) => Promise<ChatResponse>;
      stopChat?: (requestId: string) => Promise<{ ok: boolean; error?: string }>;
      getEnvFilePath?: () => Promise<string>;
      readEnvFile?: () => Promise<{ path: string; content: string }>;
      writeEnvFile?: (content: string) => Promise<{ ok: boolean; path: string }>;
      getConfigFilePath?: () => Promise<string>;
      readConfigFile?: () => Promise<{ path: string; config: AppConfig }>;
      writeConfigFile?: (config: AppConfig) => Promise<{ ok: boolean; path: string }>;
    };
  }
}

export {};
