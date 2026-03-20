const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smartTeach", {
  chat: async (message) => {
    return ipcRenderer.invoke("chat:send", { message });
  },
});
