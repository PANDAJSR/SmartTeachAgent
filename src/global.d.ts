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

declare global {
  interface Window {
    smartTeach?: {
      chat: (message: string) => Promise<ChatResponse>;
      chatStream?: (
        message: string,
        requestId: string,
        onEvent: (event: ChatStreamEvent) => void
      ) => Promise<ChatResponse>;
      stopChat?: (requestId: string) => Promise<{ ok: boolean; error?: string }>;
      getEnvFilePath?: () => Promise<string>;
      readEnvFile?: () => Promise<{ path: string; content: string }>;
      writeEnvFile?: (content: string) => Promise<{ ok: boolean; path: string }>;
    };
  }
}

export {};
