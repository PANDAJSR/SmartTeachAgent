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

type TtsStreamEvent =
  | {
      type: "chunk";
      chunkBase64: string;
      mimeType: "audio/mpeg";
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
  testMcpServerConnection: async (payload: {
    name?: string;
    url?: string;
    headers?: Record<string, string>;
  }) => {
    return ipcRenderer.invoke("mcp-server:test-connection", payload) as Promise<{
      ok: boolean;
      reachable: boolean;
      status: number | null;
      message: string;
    }>;
  },
  synthesizeSpeech: async (payload: {
    text: string;
    voice?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
  }) => {
    return ipcRenderer.invoke("tts:synthesize", payload) as Promise<
      | {
          ok: true;
          mimeType: "audio/mpeg";
          audioBase64: string;
          voice: string;
        }
      | {
          ok: false;
          error: string;
        }
    >;
  },
  synthesizeSpeechStream: async (
    payload: {
      text: string;
      requestId: string;
      voice?: string;
      rate?: string;
      pitch?: string;
      volume?: string;
    },
    onEvent: (event: TtsStreamEvent) => void
  ) => {
    const channel = `tts:stream:${payload.requestId}`;
    const streamTimeoutMs = 45000;
    const listener = (_event: unknown, streamEvent: TtsStreamEvent) => {
      onEvent(streamEvent);
    };
    ipcRenderer.on(channel, listener);
    const invokePromise = ipcRenderer.invoke("tts:synthesize:stream", payload) as Promise<{
      ok?: boolean;
      stopped?: boolean;
      error?: string;
    }>;
    invokePromise.catch(() => {
      // handled by race/consumer
    });
    const timeoutPromise = new Promise<{ error: string }>((resolve) => {
      setTimeout(() => {
        resolve({ error: `语音流请求超时（${streamTimeoutMs}ms）` });
      }, streamTimeoutMs);
    });
    try {
      return await Promise.race([invokePromise, timeoutPromise]);
    } finally {
      ipcRenderer.removeListener(channel, listener);
    }
  },
  stopSpeech: async (requestId: string) => {
    return ipcRenderer.invoke("tts:stop", { requestId }) as Promise<{ ok: boolean; error?: string }>;
  },
});
