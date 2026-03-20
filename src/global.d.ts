type ChatResponse = {
  reply?: string;
  rendered?: string;
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
    };
  }
}

export {};
