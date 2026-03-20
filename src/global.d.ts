type ChatResponse = {
  reply?: string;
  error?: string;
  meta?: unknown;
};

declare global {
  interface Window {
    smartTeach?: {
      chat: (message: string) => Promise<ChatResponse>;
    };
  }
}

export {};
