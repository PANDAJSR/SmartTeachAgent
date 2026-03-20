type ChatResponse = {
  reply?: string;
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
      trace: Array<{
        type: "tool" | "thinking";
        text: string;
      }>;
    }
  | {
      type: "done";
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
        onEvent: (event: ChatStreamEvent) => void
      ) => Promise<ChatResponse>;
    };
  }
}

export {};
