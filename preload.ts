import { contextBridge, ipcRenderer } from "electron";

type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

type ContentSegment = {
  type: "text" | "tool";
  text: string;
  toolName?: string;
  toolUseId?: string;
  status?: "pending" | "running" | "completed" | "failed" | "stopped";
  output?: string;
};

type StreamEvent = {
  type: "snapshot";
  reply: string;
  rendered: string;
  segments: ContentSegment[];
  trace: TraceEntry[];
} | {
  type: "done";
} | {
  type: "stopped";
} | {
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

contextBridge.exposeInMainWorld("smartTeach", {
  chat: async (message: string, history?: ChatHistoryTurn[]) => {
    return ipcRenderer.invoke("chat:send", { message, history });
  },
  chatStream: async (
    message: string,
    requestId: string,
    history: ChatHistoryTurn[] | undefined,
    onEvent: (event: StreamEvent) => void
  ) => {
    const channel = `chat:stream:${requestId}`;
    const listener = (_event: unknown, payload: StreamEvent) => {
      onEvent(payload);
    };

    ipcRenderer.on(channel, listener);
    try {
      return await ipcRenderer.invoke("chat:send:stream", { message, requestId, history });
    } finally {
      ipcRenderer.removeListener(channel, listener);
    }
  },
  stopChat: async (requestId: string) => {
    return ipcRenderer.invoke("chat:stop", { requestId });
  },
  getEnvFilePath: async () => {
    return ipcRenderer.invoke("env-file:get-path") as Promise<string>;
  },
  readEnvFile: async () => {
    return ipcRenderer.invoke("env-file:read") as Promise<{ path: string; content: string }>;
  },
  writeEnvFile: async (content: string) => {
    return ipcRenderer.invoke("env-file:write", { content }) as Promise<{ ok: boolean; path: string }>;
  },
  getConfigFilePath: async () => {
    return ipcRenderer.invoke("config-file:get-path") as Promise<string>;
  },
  readConfigFile: async () => {
    return ipcRenderer.invoke("config-file:read") as Promise<{ path: string; config: AppConfig }>;
  },
  writeConfigFile: async (config: AppConfig) => {
    return ipcRenderer.invoke("config-file:write", { config }) as Promise<{ ok: boolean; path: string }>;
  },
});
