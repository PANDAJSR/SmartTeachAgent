import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "path";
import dotenv from "dotenv";
import { readAppConfig, writeAppConfig } from "./shared/appConfig";
import { runClaudeChat } from "./shared/chatRuntime";
import type { ChatHistoryTurn, ChatProgressSnapshot } from "./shared/chatRuntime";
import { streamSynthesizeWithEdgeTts, synthesizeWithEdgeTts } from "./shared/edgeTts";
import type { EdgeTtsPayload, EdgeTtsStreamEvent } from "./shared/edgeTts";
import { testMcpHttpConnection } from "./shared/mcpConnection";
import { configFilePath, envFilePath } from "./shared/paths";

type Logger = {
  logInfo: (message: string, extra?: unknown) => void;
  logError: (message: string, error?: unknown) => void;
};

export function registerIpcHandlers(logger: Logger): void {
  const activeAbortControllers = new Map<string, AbortController>();
  const activeTtsSockets = new Map<string, { close: () => void }>();

  ipcMain.handle(
    "chat:send",
    async (_event, payload?: { message?: string; history?: ChatHistoryTurn[] }) => {
      logger.logInfo("[chat:send] 收到请求");
      try {
        const result = await runClaudeChat(logger, {
          message: payload?.message,
          history: payload?.history,
          debugTag: "chat:send",
          appendThinkingDelta: true,
        });
        logger.logInfo("[chat:send] 请求完成");
        return result;
      } catch (error) {
        logger.logError("[chat:send] 请求失败", error);
        return { error: error instanceof Error ? error.message : "服务异常" };
      }
    }
  );

  ipcMain.handle(
    "chat:send:stream",
    async (
      event,
      payload?: { message?: string; requestId?: string; history?: ChatHistoryTurn[] }
    ) => {
      const requestId = String(payload?.requestId || "").trim();
      if (!requestId) {
        return { error: "缺少 requestId" };
      }

      const channel = `chat:stream:${requestId}`;
      const sendSnapshot = (snapshot: ChatProgressSnapshot): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(channel, { type: "snapshot", ...snapshot });
        }
      };

      const abortController = new AbortController();
      activeAbortControllers.set(requestId, abortController);

      try {
        const result = await runClaudeChat(logger, {
          message: payload?.message,
          history: payload?.history,
          onProgress: sendSnapshot,
          abortController,
          debugTag: `chat:send:stream:${requestId}`,
          appendThinkingDelta: true,
        });
        if (!event.sender.isDestroyed()) {
          event.sender.send(channel, { type: result.stopped ? "stopped" : "done" });
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "服务异常";
        if (!event.sender.isDestroyed()) {
          event.sender.send(channel, { type: "error", error: message });
        }
        return { error: message };
      } finally {
        activeAbortControllers.delete(requestId);
      }
    }
  );

  ipcMain.handle("chat:stop", async (_event, payload?: { requestId?: string }) => {
    const requestId = String(payload?.requestId || "").trim();
    if (!requestId) {
      return { ok: false, error: "缺少 requestId" };
    }
    const controller = activeAbortControllers.get(requestId);
    if (!controller) {
      return { ok: false, error: "未找到可中断的请求" };
    }
    controller.abort();
    return { ok: true };
  });

  ipcMain.handle("env-file:get-path", async () => envFilePath);

  ipcMain.handle("env-file:read", async () => {
    try {
      const content = await fs.readFile(envFilePath, "utf-8");
      return { path: envFilePath, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { path: envFilePath, content: "" };
      }
      throw error;
    }
  });

  ipcMain.handle("env-file:write", async (_event, payload?: { content?: string }) => {
    const content = typeof payload?.content === "string" ? payload.content : "";
    await fs.mkdir(path.dirname(envFilePath), { recursive: true });
    await fs.writeFile(envFilePath, content, "utf-8");
    const reloadResult = dotenv.config({ path: envFilePath, override: true });
    if (reloadResult.error) {
      logger.logError("[env-file:write] 写入后重载 env 失败", reloadResult.error);
    }
    return { ok: true, path: envFilePath };
  });

  ipcMain.handle("config-file:get-path", async () => configFilePath);

  ipcMain.handle("config-file:read", async () => {
    const config = await readAppConfig();
    return { path: configFilePath, config };
  });

  ipcMain.handle("config-file:write", async (_event, payload?: { config?: unknown }) => {
    const config = await writeAppConfig(payload?.config);
    return { ok: true, path: configFilePath, config };
  });

  ipcMain.handle(
    "mcp-server:test-connection",
    async (_event, payload?: { name?: string; url?: string; headers?: Record<string, string> }) => {
      return testMcpHttpConnection(payload);
    }
  );

  ipcMain.handle("tts:synthesize", async (_event, payload?: EdgeTtsPayload) => {
    try {
      return await synthesizeWithEdgeTts(payload);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "语音合成失败",
      };
    }
  });

  ipcMain.handle("tts:synthesize:stream", async (event, payload?: EdgeTtsPayload) => {
    const requestId = String(payload?.requestId || "").trim();
    if (!requestId) {
      return { error: "缺少 requestId" };
    }
    const channel = `tts:stream:${requestId}`;
    const pushEvent = (streamEvent: EdgeTtsStreamEvent): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, streamEvent);
      }
    };

    try {
      await streamSynthesizeWithEdgeTts(payload, activeTtsSockets, pushEvent);
      pushEvent({ type: "done" });
      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "语音合成失败";
      if (errorMessage.includes("closed") || errorMessage.includes("中止") || errorMessage.includes("关闭")) {
        pushEvent({ type: "stopped" });
        return { ok: true, stopped: true };
      }
      pushEvent({ type: "error", error: errorMessage });
      return { error: errorMessage };
    } finally {
      activeTtsSockets.delete(requestId);
    }
  });

  ipcMain.handle("tts:stop", async (_event, payload?: { requestId?: string }) => {
    const requestId = String(payload?.requestId || "").trim();
    if (!requestId) {
      return { ok: false, error: "缺少 requestId" };
    }
    const active = activeTtsSockets.get(requestId);
    if (!active) {
      return { ok: false, error: "未找到可停止的语音请求" };
    }
    try {
      active.close();
    } catch {
      // ignore close errors
    }
    activeTtsSockets.delete(requestId);
    return { ok: true };
  });
}
