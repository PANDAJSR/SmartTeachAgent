type ChatResponse = {
  reply?: string;
  error?: string;
  meta?: unknown;
  trace?: Array<{
    type: "tool" | "thinking";
    text: string;
  }>;
};

declare global {
  interface Window {
    smartTeach?: {
      chat: (message: string) => Promise<ChatResponse>;
    };
  }
}

export {};
