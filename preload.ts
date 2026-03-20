import { contextBridge, ipcRenderer } from "electron";

type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

type StreamEvent = {
  type: "snapshot";
  reply: string;
  trace: TraceEntry[];
} | {
  type: "done";
} | {
  type: "error";
  error: string;
};

contextBridge.exposeInMainWorld("smartTeach", {
  chat: async (message: string) => {
    return ipcRenderer.invoke("chat:send", { message });
  },
  chatStream: async (message: string, onEvent: (event: StreamEvent) => void) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = `chat:stream:${requestId}`;
    const listener = (_event: unknown, payload: StreamEvent) => {
      onEvent(payload);
    };

    ipcRenderer.on(channel, listener);
    try {
      return await ipcRenderer.invoke("chat:send:stream", { message, requestId });
    } finally {
      ipcRenderer.removeListener(channel, listener);
    }
  },
});
