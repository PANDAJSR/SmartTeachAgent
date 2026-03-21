import { useState } from "react";
import type { AppConfig, McpServerDraft, McpTestResult } from "../types";
import { UI_LOG_PREFIX, createMcpServerDraft } from "../types";

type UseSettingsResult = {
  settingsOpen: boolean;
  settingsLoading: boolean;
  envEditorLoading: boolean;
  envEditorSaving: boolean;
  envEditorError: string;
  envEditorNotice: string;
  envFilePath: string;
  envFileContent: string;
  configPath: string;
  configSaving: boolean;
  configError: string;
  configNotice: string;
  mcpServers: McpServerDraft[];
  mcpTestingMap: Record<string, boolean>;
  mcpTestResultMap: Record<string, McpTestResult>;
  setSettingsOpen: (value: boolean) => void;
  setEnvFileContent: (value: string) => void;
  openSettings: () => Promise<void>;
  addMcpServer: () => void;
  removeMcpServer: (id: string) => void;
  updateMcpServer: (id: string, patch: Partial<Omit<McpServerDraft, "id">>) => void;
  testMcpServerConnection: (id: string) => Promise<void>;
  saveEnvFile: () => Promise<void>;
  saveConfigFile: () => Promise<void>;
};

export function useSettings(): UseSettingsResult {
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsLoading, setSettingsLoading] = useState<boolean>(false);
  const [envEditorLoading, setEnvEditorLoading] = useState<boolean>(false);
  const [envEditorSaving, setEnvEditorSaving] = useState<boolean>(false);
  const [envEditorError, setEnvEditorError] = useState<string>("");
  const [envEditorNotice, setEnvEditorNotice] = useState<string>("");
  const [envFilePath, setEnvFilePath] = useState<string>("~/SmartTeachAgent/.env");
  const [envFileContent, setEnvFileContent] = useState<string>("");
  const [configPath, setConfigPath] = useState<string>("~/SmartTeachAgent/config.json");
  const [configSaving, setConfigSaving] = useState<boolean>(false);
  const [configError, setConfigError] = useState<string>("");
  const [configNotice, setConfigNotice] = useState<string>("");
  const [mcpServers, setMcpServers] = useState<McpServerDraft[]>([createMcpServerDraft(0)]);
  const [mcpTestingMap, setMcpTestingMap] = useState<Record<string, boolean>>({});
  const [mcpTestResultMap, setMcpTestResultMap] = useState<Record<string, McpTestResult>>({});

  const loadEnvFile = async (): Promise<void> => {
    setEnvEditorLoading(true);
    setEnvEditorError("");
    try {
      const readEnvFile = window.smartTeach?.readEnvFile;
      const getEnvFilePath = window.smartTeach?.getEnvFilePath;
      if (!readEnvFile) {
        const path = (await getEnvFilePath?.()) || "~/SmartTeachAgent/.env";
        setEnvFilePath(path);
        setEnvFileContent("");
        setEnvEditorError("当前模式不支持直接编辑，请在 Electron 客户端中使用此功能。");
        return;
      }
      const data = await readEnvFile();
      setEnvFilePath(data.path);
      setEnvFileContent(data.content);
      console.info(`${UI_LOG_PREFIX} loadEnvFile success path=${data.path} length=${data.content.length}`);
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} loadEnvFile failed`, error);
      setEnvEditorError(error instanceof Error ? error.message : "读取 .env 文件失败");
      setEnvFileContent("");
    } finally {
      setEnvEditorLoading(false);
    }
  };

  const loadConfigFile = async (): Promise<void> => {
    setConfigError("");
    try {
      const readConfigFile = window.smartTeach?.readConfigFile;
      if (!readConfigFile) {
        setConfigPath("~/SmartTeachAgent/config.json");
        setConfigError("当前模式不支持读取配置，请在 Electron 客户端中使用此功能。");
        return;
      }
      const data = await readConfigFile();
      setConfigPath(data.path);
      const config = data.config || {};
      const httpServers = config.mcp?.httpServers;
      if (Array.isArray(httpServers) && httpServers.length > 0) {
        const nextServers = httpServers.map((server, index) => ({
          id: createMcpServerDraft(index).id,
          enabled: Boolean(server.enabled),
          name: (server.name || `http-server-${index + 1}`).trim() || `http-server-${index + 1}`,
          url: (server.url || "").trim(),
          headersText:
            server.headers && Object.keys(server.headers).length > 0
              ? JSON.stringify(server.headers, null, 2)
              : "",
        }));
        setMcpServers(nextServers);
      } else {
        const legacyServer = (
          config.mcp as
            | {
                macHttpServer?: {
                  enabled?: boolean;
                  name?: string;
                  url?: string;
                  headers?: Record<string, string>;
                };
              }
            | undefined
        )?.macHttpServer;

        if (legacyServer) {
          setMcpServers([
            {
              id: createMcpServerDraft(0).id,
              enabled: Boolean(legacyServer.enabled),
              name: (legacyServer.name || "http-server-1").trim() || "http-server-1",
              url: (legacyServer.url || "").trim(),
              headersText:
                legacyServer.headers && Object.keys(legacyServer.headers).length > 0
                  ? JSON.stringify(legacyServer.headers, null, 2)
                  : "",
            },
          ]);
        } else {
          setMcpServers([createMcpServerDraft(0)]);
        }
      }
      setMcpTestingMap({});
      setMcpTestResultMap({});
      console.info(`${UI_LOG_PREFIX} loadConfigFile success path=${data.path}`);
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} loadConfigFile failed`, error);
      setConfigError(error instanceof Error ? error.message : "读取 config.json 失败");
    }
  };

  const openSettings = async (): Promise<void> => {
    setSettingsOpen(true);
    setSettingsLoading(true);
    setEnvEditorNotice("");
    setConfigNotice("");
    await Promise.all([loadEnvFile(), loadConfigFile()]);
    setSettingsLoading(false);
  };

  const addMcpServer = (): void => {
    setMcpServers((prev) => [...prev, createMcpServerDraft(prev.length)]);
  };

  const removeMcpServer = (id: string): void => {
    setMcpServers((prev) => {
      const next = prev.filter((item) => item.id !== id);
      return next.length > 0 ? next : [createMcpServerDraft(0)];
    });
    setMcpTestingMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setMcpTestResultMap((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const updateMcpServer = (id: string, patch: Partial<Omit<McpServerDraft, "id">>): void => {
    setMcpServers((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const testMcpServerConnection = async (id: string): Promise<void> => {
    const target = mcpServers.find((item) => item.id === id);
    if (!target) {
      return;
    }

    let headers: Record<string, string> | undefined;
    const cleanHeadersText = target.headersText.trim();
    if (cleanHeadersText) {
      try {
        const parsed = JSON.parse(cleanHeadersText) as Record<string, unknown>;
        headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
      } catch {
        setMcpTestResultMap((prev) => ({
          ...prev,
          [id]: { ok: false, message: "请求头 JSON 格式错误，请先修正后再测试。" },
        }));
        return;
      }
    }

    const testApi = window.smartTeach?.testMcpServerConnection;
    if (!testApi) {
      setMcpTestResultMap((prev) => ({
        ...prev,
        [id]: { ok: false, message: "当前模式不支持连接测试，请在 Electron 客户端中使用此功能。" },
      }));
      return;
    }

    setMcpTestingMap((prev) => ({ ...prev, [id]: true }));
    setMcpTestResultMap((prev) => ({ ...prev, [id]: { ok: false, message: "正在测试连接..." } }));
    try {
      const result = await testApi({ name: target.name.trim(), url: target.url.trim(), headers });
      setMcpTestResultMap((prev) => ({ ...prev, [id]: { ok: result.ok, message: result.message } }));
    } catch (error) {
      setMcpTestResultMap((prev) => ({
        ...prev,
        [id]: { ok: false, message: error instanceof Error ? error.message : "测试连接失败" },
      }));
    } finally {
      setMcpTestingMap((prev) => ({ ...prev, [id]: false }));
    }
  };

  const saveEnvFile = async (): Promise<void> => {
    const writeEnvFile = window.smartTeach?.writeEnvFile;
    if (!writeEnvFile) {
      setEnvEditorError("当前模式不支持直接保存，请在 Electron 客户端中使用此功能。");
      return;
    }

    setEnvEditorSaving(true);
    setEnvEditorError("");
    setEnvEditorNotice("");
    try {
      const result = await writeEnvFile(envFileContent);
      setEnvFilePath(result.path);
      setEnvEditorNotice(`保存成功：${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
    } catch (error) {
      setEnvEditorError(error instanceof Error ? error.message : "保存 .env 文件失败");
    } finally {
      setEnvEditorSaving(false);
    }
  };

  const saveConfigFile = async (): Promise<void> => {
    const writeConfigFile = window.smartTeach?.writeConfigFile;
    if (!writeConfigFile) {
      setConfigError("当前模式不支持直接保存，请在 Electron 客户端中使用此功能。");
      return;
    }

    const httpServers: NonNullable<NonNullable<AppConfig["mcp"]>["httpServers"]> = [];
    for (const [index, server] of mcpServers.entries()) {
      let headers: Record<string, string> | undefined;
      const cleanHeadersText = server.headersText.trim();
      if (cleanHeadersText) {
        try {
          const parsed = JSON.parse(cleanHeadersText) as Record<string, unknown>;
          headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
        } catch {
          setConfigError(`服务器 ${index + 1} 的请求头 JSON 格式错误，请检查后重试。`);
          return;
        }
      }
      const cleanName = server.name.trim() || `http-server-${index + 1}`;
      const cleanUrl = server.url.trim();
      if (!cleanUrl && !server.enabled && !cleanHeadersText && !server.name.trim()) {
        continue;
      }
      httpServers.push({ enabled: server.enabled, name: cleanName, url: cleanUrl, headers });
    }

    setConfigSaving(true);
    setConfigError("");
    setConfigNotice("");
    try {
      const result = await writeConfigFile({ mcp: { httpServers } });
      setConfigPath(result.path);
      setConfigNotice(`保存成功：${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : "保存 config.json 失败");
    } finally {
      setConfigSaving(false);
    }
  };

  return {
    settingsOpen,
    settingsLoading,
    envEditorLoading,
    envEditorSaving,
    envEditorError,
    envEditorNotice,
    envFilePath,
    envFileContent,
    configPath,
    configSaving,
    configError,
    configNotice,
    mcpServers,
    mcpTestingMap,
    mcpTestResultMap,
    setSettingsOpen,
    setEnvFileContent,
    openSettings,
    addMcpServer,
    removeMcpServer,
    updateMcpServer,
    testMcpServerConnection,
    saveEnvFile,
    saveConfigFile,
  };
}
