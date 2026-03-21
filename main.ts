import { app, BrowserWindow } from "electron";
import dotenv from "dotenv";
import path from "path";
import { registerIpcHandlers } from "./backend/ipcHandlers";
import { createLogger } from "./backend/shared/logger";
import { envFilePath } from "./backend/shared/paths";

const { logInfo, logError } = createLogger("[SmartTeachAgent][main]");

const envLoadResult = dotenv.config({ path: envFilePath, override: true });
if (envLoadResult.error) {
  logError(`加载 env 失败，路径=${envFilePath}`, envLoadResult.error);
} else {
  logInfo(`已加载 env，路径=${envFilePath}，包含键数量=${Object.keys(envLoadResult.parsed || {}).length}`);
}
logInfo(`ANTHROPIC_API_KEY 已配置=${Boolean(process.env.ANTHROPIC_API_KEY)}`);

registerIpcHandlers({ logInfo, logError });

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    logInfo(`加载开发地址 ${devServerUrl}`);
    void win.loadURL(devServerUrl);
  } else {
    logInfo("加载本地构建页面 dist/index.html");
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

void app.whenReady().then(() => {
  logInfo("Electron app ready");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  logInfo("window-all-closed");
  if (process.platform !== "darwin") {
    logInfo("非 macOS，退出应用");
    app.quit();
  }
});
