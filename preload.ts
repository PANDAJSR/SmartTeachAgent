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
  type: "stopped";
} | {
  type: "error";
  error: string;
};

contextBridge.exposeInMainWorld("smartTeach", {
  chat: async (message: string) => {
    return ipcRenderer.invoke("chat:send", { message });
  },
  chatStream: async (
    message: string,
    requestId: string,
    onEvent: (event: StreamEvent) => void
  ) => {
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
  stopChat: async (requestId: string) => {
    return ipcRenderer.invoke("chat:stop", { requestId });
  },
});
