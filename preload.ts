import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("smartTeach", {
  chat: async (message: string) => {
    return ipcRenderer.invoke("chat:send", { message });
  },
});
