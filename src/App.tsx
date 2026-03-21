import { useEffect, useMemo, useRef, useState } from "react";
import { Actions, Bubble, Conversations, Sender, Think } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { Button, Card, Select, Space, Tooltip, Typography } from "antd";
import SettingsModal from "./components/SettingsModal";

type Role = "user" | "ai";

type ChatItem = {
  key: string;
  role: Role;
  content: string;
  streaming?: boolean;
  status?: "loading" | "success" | "error" | "abort";
  extraInfo?: {
    streaming?: boolean;
    trace?: TraceEntry[];
    segments?: ContentSegment[];
  };
};

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

type ChatResponse = {
  reply?: string;
  rendered?: string;
  segments?: ContentSegment[];
  error?: string;
  trace?: TraceEntry[];
};

type StreamEvent =
  | {
      type: "snapshot";
      reply: string;
      rendered: string;
      segments: ContentSegment[];
      trace: TraceEntry[];
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

type Conversation = {
  id: string;
  title: string;
  items: ChatItem[];
  createdAt: number;
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
    macHttpServer?: {
      enabled?: boolean;
      name?: string;
      url?: string;
      headers?: Record<string, string>;
    };
  };
};

type McpServerDraft = {
  id: string;
  enabled: boolean;
  name: string;
  url: string;
  headersText: string;
};

type McpTestResult = {
  ok: boolean;
  message: string;
};

const MAX_HISTORY_TURNS = 24;
const DEFAULT_ASR_MODEL_ID = import.meta.env.VITE_ASR_MODEL_ID || "Xenova/whisper-base";
const ASR_MODEL_OPTIONS = [
  {
    label: "极速（中文）",
    value: "Xenova/whisper-tiny",
  },
  {
    label: "均衡（中文，推荐）",
    value: "Xenova/whisper-base",
  },
  {
    label: "高准确（中文）",
    value: "Xenova/whisper-small",
  },
] as const;
const ASR_MODEL_SELECT_OPTIONS: { label: string; value: string }[] = [...ASR_MODEL_OPTIONS];

type AsrResult = {
  text?: string;
};

type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<AsrResult>;
type ChineseConverter = (input: string) => string;

const createConversation = (index: number): Conversation => {
  const now = Date.now();
  return {
    id: `conversation-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: `新对话 ${index}`,
    items: [],
    createdAt: now,
  };
};

const buildTitleFromInput = (text: string): string => {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) {
    return "";
  }
  return clean.length > 18 ? `${clean.slice(0, 18)}...` : clean;
};

const formatConversationTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const buildAiContent = (reply: string, streaming = false): string => {
  const text = reply.trim();
  if (text) {
    return text;
  }
  return streaming ? "思考中..." : "（无文本回复）";
};

const renderToolText = (segment: ContentSegment) => {
  const text = segment.text;
  const marker = "，参数：";
  const index = text.indexOf(marker);
  const outputBlock = segment.output ? `\n\n**工具输出**\n\n\`\`\`text\n${segment.output}\n\`\`\`` : "";
  if (index === -1) {
    return <XMarkdown content={`${text}${outputBlock}`} />;
  }
  const title = text.slice(0, index).trim();
  const payload = text.slice(index + marker.length).trim();
  const formatted = `${title}\n\n\`\`\`json\n${payload}\n\`\`\`${outputBlock}`;
  return <XMarkdown content={formatted} />;
};

const getToolTitle = (segment: ContentSegment): string => {
  const toolName = segment.toolName || "工具调用";
  const statusMap: Record<NonNullable<ContentSegment["status"]>, string> = {
    pending: "待执行",
    running: "进行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已停止",
  };
  if (!segment.status) {
    return toolName;
  }
  return `${toolName} · ${statusMap[segment.status]}`;
};

const getToolSegmentKey = (segment: ContentSegment, index: number): string =>
  segment.toolUseId || `${segment.toolName || "tool"}-${index}-${segment.text.slice(0, 20)}`;

const UI_LOG_PREFIX = "[SmartTeachAgent][renderer]";

const buildHistoryTurns = (items: ChatItem[]): ChatHistoryTurn[] =>
  items
    .filter((item) => {
      if (item.role === "user") {
        return Boolean(item.content.trim());
      }
      if (item.role === "ai") {
        return item.status === "success" && Boolean(item.content.trim());
      }
      return false;
    })
    .map((item) => ({
      role: (item.role === "user" ? "user" : "assistant") as ChatHistoryTurn["role"],
      content: item.content.trim(),
    }))
    .slice(-MAX_HISTORY_TURNS);

const createMcpServerDraft = (index = 0): McpServerDraft => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${index}`,
  enabled: false,
  name: `http-server-${index + 1}`,
  url: "",
  headersText: "",
});

function App() {
  const initialConversation = createConversation(1);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [conversations, setConversations] = useState<Conversation[]>([initialConversation]);
  const [activeConversationId, setActiveConversationId] = useState<string>(initialConversation.id);
  const activeRequestIdRef = useRef<string | null>(null);
  const [collapsedToolKeys, setCollapsedToolKeys] = useState<string[]>([]);
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
  const [recording, setRecording] = useState<boolean>(false);
  const [transcribing, setTranscribing] = useState<boolean>(false);
  const [asrError, setAsrError] = useState<string>("");
  const [asrModelId, setAsrModelId] = useState<string>(DEFAULT_ASR_MODEL_ID);
  const [asrPreloading, setAsrPreloading] = useState<boolean>(false);
  const [asrReadyMap, setAsrReadyMap] = useState<Record<string, boolean>>({});
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const asrPipelineRef = useRef<{ modelId: string; pipeline: AsrPipeline } | null>(null);
  const asrPipelineLoadingRef = useRef<Promise<AsrPipeline> | null>(null);
  const zhSimplifierRef = useRef<ChineseConverter | null>(null);
  const zhSimplifierLoadingRef = useRef<Promise<ChineseConverter> | null>(null);

  const roles = useMemo(
    () =>
      ({
        ai: {
          placement: "start",
          variant: "borderless",
          contentRender: (
            content: string,
            info: { extraInfo?: { streaming?: boolean; segments?: ContentSegment[] } }
          ) => {
            const segments = info?.extraInfo?.segments;
            if (Array.isArray(segments) && segments.length > 0) {
              return (
                <Space direction="vertical" size={8} style={{ width: "100%" }}>
                  {segments.map((segment, index) =>
                    segment.type === "tool" ? (
                      <Think
                        key={`segment-tool-${index}`}
                        title={getToolTitle(segment)}
                        expanded={!collapsedToolKeys.includes(getToolSegmentKey(segment, index))}
                        onExpand={(nextExpand) => {
                          const toolKey = getToolSegmentKey(segment, index);
                          setCollapsedToolKeys((prev) =>
                            nextExpand
                              ? prev.filter((item) => item !== toolKey)
                              : Array.from(new Set([...prev, toolKey]))
                          );
                        }}
                        styles={{ content: { marginTop: 8 } }}
                      >
                        {renderToolText(segment)}
                      </Think>
                    ) : (
                      <XMarkdown
                        key={`segment-text-${index}`}
                        content={segment.text}
                        streaming={{
                          hasNextChunk:
                            Boolean(info?.extraInfo?.streaming) && index === segments.length - 1,
                        }}
                      />
                    )
                  )}
                </Space>
              );
            }
            return (
              <XMarkdown
                content={content}
                streaming={{ hasNextChunk: Boolean(info?.extraInfo?.streaming) }}
              />
            );
          },
          footer: () => null,
        },
        user: {
          placement: "end",
          variant: "filled",
          footerPlacement: "outer-end",
          footer: (content: string) => {
            const text = String(content || "").trim();
            if (!text) {
              return null;
            }
            return (
              <Actions
                variant="borderless"
                items={[
                  {
                    key: "retry-request",
                    icon: <i className="fa-solid fa-rotate-right" aria-hidden="true" />,
                    onItemClick: () => {
                      if (!loading) {
                        void sendMessage(text);
                      }
                    },
                  },
                ]}
              />
            );
          },
        },
      } as const),
    [collapsedToolKeys, loading]
  );

  useEffect(() => {
    const nextKeys: string[] = [];
    for (const conversation of conversations) {
      for (const item of conversation.items) {
        const segments = item.extraInfo?.segments || [];
        segments.forEach((segment, index) => {
          if (segment.type !== "tool") {
            return;
          }
          if (
            segment.status === "completed" ||
            segment.status === "failed" ||
            segment.status === "stopped"
          ) {
            nextKeys.push(getToolSegmentKey(segment, index));
          }
        });
      }
    }
    setCollapsedToolKeys((prev) => Array.from(new Set([...prev, ...nextKeys])));
  }, [conversations]);

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId),
    [conversations, activeConversationId]
  );

  const activeItems = activeConversation?.items ?? [];
  const conversationItems = useMemo(
    () =>
      conversations.map((conversation) => ({
        key: conversation.id,
        label: `${conversation.title} · ${formatConversationTime(conversation.createdAt)}`,
      })),
    [conversations]
  );

  const createNewConversation = (): void => {
    if (loading) {
      return;
    }
    const newConversation = createConversation(conversations.length + 1);
    setConversations((prev) => [...prev, newConversation]);
    setActiveConversationId(newConversation.id);
    setInput("");
  };

  const sendMessage = async (text: string): Promise<void> => {
    const clean = text.trim();
    if (!clean || loading || !activeConversationId) {
      return;
    }

    const currentConversationId = activeConversationId;
    const history = buildHistoryTurns(activeConversation?.items ?? []);
    const userKey = `user-${Date.now()}`;
    const aiKey = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.info(`${UI_LOG_PREFIX} sendMessage start requestId=${requestId} messageLength=${clean.length}`);
    activeRequestIdRef.current = requestId;

    setConversations((prev) =>
      prev.map((conversation) => {
        if (conversation.id !== currentConversationId) {
          return conversation;
        }
        const nextTitle =
          conversation.items.length === 0 && conversation.title.startsWith("新对话")
            ? buildTitleFromInput(clean) || conversation.title
            : conversation.title;
        return {
          ...conversation,
          title: nextTitle,
          items: [
            ...conversation.items,
            { key: userKey, role: "user", content: clean },
            {
              key: aiKey,
              role: "ai",
              content: "思考中...",
              streaming: true,
              status: "loading",
              extraInfo: { streaming: true, trace: [], segments: [] },
            },
          ],
        };
      })
    );
    setInput("");
    setLoading(true);

    try {
      let data: ChatResponse | undefined;
      if (window.smartTeach?.chatStream) {
        let stopped = false;
        data = await window.smartTeach.chatStream(clean, requestId, history, (event: StreamEvent) => {
          if (event.type === "error") {
            console.error(`${UI_LOG_PREFIX} stream error requestId=${requestId}`, event.error);
          }
          if (event.type === "stopped") {
            console.info(`${UI_LOG_PREFIX} stream stopped requestId=${requestId}`);
            stopped = true;
            setConversations((prev) =>
              prev.map((conversation) =>
                conversation.id === currentConversationId
                  ? {
                      ...conversation,
                      items: conversation.items.map((item) =>
                        item.key === aiKey
                          ? {
                              ...item,
                              streaming: false,
                              status: "abort",
                              extraInfo: { streaming: false },
                              content: `${item.content}\n\n（已停止）`,
                            }
                          : item
                      ),
                    }
                  : conversation
              )
            );
            return;
          }
          if (event.type !== "snapshot") {
            return;
          }
          console.info(
            `${UI_LOG_PREFIX} stream snapshot requestId=${requestId} segments=${event.segments.length} trace=${event.trace.length}`
          );
          setConversations((prev) =>
            prev.map((conversation) =>
              conversation.id === currentConversationId
                ? {
                    ...conversation,
                    items: conversation.items.map((item) =>
                      item.key === aiKey
                        ? {
                            ...item,
                            streaming: true,
                            content: buildAiContent(event.rendered || event.reply || "", true),
                            status: "loading",
                            extraInfo: {
                              streaming: true,
                              trace: event.trace || [],
                              segments: event.segments || [],
                            },
                          }
                        : item
                    ),
                  }
                : conversation
            )
          );
        });
        if (stopped) {
          console.info(`${UI_LOG_PREFIX} sendMessage end requestId=${requestId} stopped=true`);
          setLoading(false);
          activeRequestIdRef.current = null;
          return;
        }
      } else if (window.smartTeach?.chat) {
        data = await window.smartTeach.chat(clean, history);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: clean, history }),
        });
        data = (await response.json()) as ChatResponse;
        if (!response.ok) {
          throw new Error(data.error || "请求失败");
        }
      }

      if (!data) {
        throw new Error("未获取到响应数据");
      }

      if (data.error) {
        throw new Error(data.error);
      }
      console.info(`${UI_LOG_PREFIX} sendMessage success requestId=${requestId}`);

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === currentConversationId
            ? {
                ...conversation,
                items: conversation.items.map((item) =>
                  item.key === aiKey
                    ? {
                        ...item,
                        streaming: false,
                        content: buildAiContent(data.rendered || data.reply || "", false),
                        status: "success",
                        extraInfo: {
                          streaming: false,
                          trace: data.trace || [],
                          segments: data.segments || [],
                        },
                      }
                    : item
                ),
              }
            : conversation
        )
      );
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} sendMessage failed requestId=${requestId}`, error);
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === currentConversationId
            ? {
                ...conversation,
                items: conversation.items.map((item) =>
                  item.key === aiKey
                    ? {
                        ...item,
                        streaming: false,
                        content:
                          error instanceof Error
                            ? `调用失败：${error.message}`
                            : "调用失败：未知错误",
                        status: "error",
                        extraInfo: { streaming: false },
                      }
                    : item
                ),
              }
            : conversation
        )
      );
    } finally {
      console.info(`${UI_LOG_PREFIX} sendMessage finally requestId=${requestId}`);
      setLoading(false);
      activeRequestIdRef.current = null;
    }
  };

  const handleCancel = async (): Promise<void> => {
    const requestId = activeRequestIdRef.current;
    if (!requestId || !window.smartTeach?.stopChat) {
      return;
    }
    try {
      await window.smartTeach.stopChat(requestId);
    } catch {
      // ignore stop errors
    }
  };

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
        const nextServers =
          httpServers.map((server, index) => ({
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
        setMcpTestingMap({});
        setMcpTestResultMap({});
      } else {
        const legacyServer = (config.mcp as { macHttpServer?: {
          enabled?: boolean;
          name?: string;
          url?: string;
          headers?: Record<string, string>;
        } } | undefined)?.macHttpServer;
        if (legacyServer) {
          const server = legacyServer;
          setMcpServers([
            {
              id: createMcpServerDraft(0).id,
              enabled: Boolean(server.enabled),
              name: (server.name || "http-server-1").trim() || "http-server-1",
              url: (server.url || "").trim(),
              headersText:
                server.headers && Object.keys(server.headers).length > 0
                  ? JSON.stringify(server.headers, null, 2)
                  : "",
            },
          ]);
        } else {
          setMcpServers([createMcpServerDraft(0)]);
        }
        setMcpTestingMap({});
        setMcpTestResultMap({});
      }
      console.info(`${UI_LOG_PREFIX} loadConfigFile success path=${data.path}`);
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} loadConfigFile failed`, error);
      setConfigError(error instanceof Error ? error.message : "读取 config.json 失败");
    }
  };

  const openSettings = async (): Promise<void> => {
    console.info(`${UI_LOG_PREFIX} openSettings start`);
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
        headers = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, String(value)])
        );
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
    setMcpTestResultMap((prev) => ({
      ...prev,
      [id]: { ok: false, message: "正在测试连接..." },
    }));
    try {
      const result = await testApi({
        name: target.name.trim(),
        url: target.url.trim(),
        headers,
      });
      setMcpTestResultMap((prev) => ({
        ...prev,
        [id]: { ok: result.ok, message: result.message },
      }));
    } catch (error) {
      setMcpTestResultMap((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          message: error instanceof Error ? error.message : "测试连接失败",
        },
      }));
    } finally {
      setMcpTestingMap((prev) => ({ ...prev, [id]: false }));
    }
  };

  const saveEnvFile = async (): Promise<void> => {
    console.info(`${UI_LOG_PREFIX} saveEnvFile start length=${envFileContent.length}`);
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
      console.info(`${UI_LOG_PREFIX} saveEnvFile success path=${result.path}`);
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} saveEnvFile failed`, error);
      setEnvEditorError(error instanceof Error ? error.message : "保存 .env 文件失败");
    } finally {
      setEnvEditorSaving(false);
    }
  };

  const saveConfigFile = async (): Promise<void> => {
    console.info(`${UI_LOG_PREFIX} saveConfigFile start`);
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
          headers = Object.fromEntries(
            Object.entries(parsed).map(([key, value]) => [key, String(value)])
          );
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
      httpServers.push({
        enabled: server.enabled,
        name: cleanName,
        url: cleanUrl,
        headers,
      });
    }

    const nextConfig: AppConfig = { mcp: { httpServers } };

    setConfigSaving(true);
    setConfigError("");
    setConfigNotice("");
    try {
      const result = await writeConfigFile(nextConfig);
      setConfigPath(result.path);
      setConfigNotice(`保存成功：${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
      console.info(`${UI_LOG_PREFIX} saveConfigFile success path=${result.path}`);
    } catch (error) {
      console.error(`${UI_LOG_PREFIX} saveConfigFile failed`, error);
      setConfigError(error instanceof Error ? error.message : "保存 config.json 失败");
    } finally {
      setConfigSaving(false);
    }
  };

  const ensureAsrPipeline = async (modelId: string): Promise<AsrPipeline> => {
    if (asrPipelineRef.current?.modelId === modelId) {
      return asrPipelineRef.current.pipeline;
    }
    if (asrPipelineLoadingRef.current) {
      return asrPipelineLoadingRef.current;
    }
    const loadingTask = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      const createPipeline = pipeline as (...args: unknown[]) => Promise<unknown>;
      const transcriber = (await createPipeline(
        "automatic-speech-recognition",
        modelId
      )) as AsrPipeline;
      asrPipelineRef.current = { modelId, pipeline: transcriber };
      setAsrReadyMap((prev) => ({ ...prev, [modelId]: true }));
      return transcriber;
    })();
    asrPipelineLoadingRef.current = loadingTask;
    try {
      return await loadingTask;
    } finally {
      asrPipelineLoadingRef.current = null;
    }
  };

  const decodeAudioBlob = async (blob: Blob): Promise<Float32Array> => {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("当前环境不支持音频解码");
    }
    const audioContext = new AudioContextCtor({ sampleRate: 16000 });
    try {
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const channelCount = decoded.numberOfChannels;
      const length = decoded.length;
      if (channelCount === 1) {
        return new Float32Array(decoded.getChannelData(0));
      }
      const mixed = new Float32Array(length);
      for (let i = 0; i < channelCount; i += 1) {
        const channelData = decoded.getChannelData(i);
        for (let j = 0; j < length; j += 1) {
          mixed[j] += channelData[j] / channelCount;
        }
      }
      return mixed;
    } finally {
      await audioContext.close();
    }
  };

  const ensureZhSimplifier = async (): Promise<ChineseConverter> => {
    if (zhSimplifierRef.current) {
      return zhSimplifierRef.current;
    }
    if (zhSimplifierLoadingRef.current) {
      return zhSimplifierLoadingRef.current;
    }
    const loadingTask = (async () => {
      const openccModule = await import("opencc-js");
      const createConverter = (
        openccModule as unknown as {
          Converter: (options: { from: string; to: string }) => ChineseConverter;
        }
      ).Converter;
      const converter = createConverter({ from: "tw", to: "cn" });
      zhSimplifierRef.current = converter;
      return converter;
    })();
    zhSimplifierLoadingRef.current = loadingTask;
    try {
      return await loadingTask;
    } finally {
      zhSimplifierLoadingRef.current = null;
    }
  };

  const normalizeToSimplifiedChinese = async (text: string): Promise<string> => {
    const clean = text.trim();
    if (!clean) {
      return clean;
    }
    try {
      const converter = await ensureZhSimplifier();
      return converter(clean);
    } catch {
      return clean;
    }
  };

  const appendTranscript = (text: string): void => {
    const clean = text.trim();
    if (!clean) {
      return;
    }
    setInput((prev) => {
      const base = prev.trim();
      return base ? `${base}${base.endsWith(" ") ? "" : " "}${clean}` : clean;
    });
  };

  const transcribeAudio = async (blob: Blob): Promise<void> => {
    setTranscribing(true);
    setAsrError("");
    try {
      const [transcriber, audio] = await Promise.all([ensureAsrPipeline(asrModelId), decodeAudioBlob(blob)]);
      const result = await transcriber(audio, { language: "zh", task: "transcribe" });
      const text = String(result?.text || "").trim();
      if (!text) {
        throw new Error("未识别到语音内容，请重试");
      }
      const simplifiedText = await normalizeToSimplifiedChinese(text);
      appendTranscript(simplifiedText);
    } catch (error) {
      setAsrError(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      setTranscribing(false);
    }
  };

  const stopMediaTracks = (): void => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const startRecording = async (): Promise<void> => {
    if (recording || transcribing || loading) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setAsrError("当前环境不支持麦克风录音");
      return;
    }
    setAsrError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const preferredMimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const recordedBlob = new Blob(audioChunksRef.current, { type: preferredMimeType });
        audioChunksRef.current = [];
        mediaRecorderRef.current = null;
        setRecording(false);
        stopMediaTracks();
        if (recordedBlob.size > 0) {
          void transcribeAudio(recordedBlob);
        }
      };
      recorder.start();
      setRecording(true);
    } catch (error) {
      stopMediaTracks();
      setRecording(false);
      setAsrError(error instanceof Error ? error.message : "无法启动录音");
    }
  };

  const stopRecording = (): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      setRecording(false);
      stopMediaTracks();
      return;
    }
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const toggleRecording = (): void => {
    if (recording) {
      stopRecording();
      return;
    }
    void startRecording();
  };

  const preloadAsrModel = async (): Promise<void> => {
    if (asrPreloading || transcribing || recording || loading) {
      return;
    }
    setAsrPreloading(true);
    setAsrError("");
    try {
      await ensureAsrPipeline(asrModelId);
    } catch (error) {
      setAsrError(error instanceof Error ? error.message : "模型预加载失败");
    } finally {
      setAsrPreloading(false);
    }
  };

  const asrModelLabel = useMemo(() => {
    const matched = ASR_MODEL_OPTIONS.find((item) => item.value === asrModelId);
    return matched?.label || asrModelId;
  }, [asrModelId]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      stopMediaTracks();
    };
  }, []);

  return (
    <main className="page">
      <Card className="chat-card" variant="borderless">
        <div className="app-layout">
          <aside className="conversation-panel">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <div className="conversation-panel-header">
                <Typography.Title level={4} style={{ margin: 0 }}>
                  对话列表
                </Typography.Title>
              </div>
              <Conversations
                items={conversationItems}
                activeKey={activeConversationId}
                onActiveChange={(value) => setActiveConversationId(String(value))}
                creation={{
                  disabled: loading,
                  onClick: createNewConversation,
                }}
              />
            </Space>
          </aside>

          <section className="chat-panel">
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <div className="header">
                <div className="header-top">
                  <Typography.Title level={3} style={{ margin: 0 }}>
                    智教助手
                  </Typography.Title>
                  <Button
                    type="text"
                    aria-label="打开设置"
                    title="设置"
                    onClick={() => void openSettings()}
                    disabled={loading}
                    icon={<i className="fa-solid fa-gear" aria-hidden="true" />}
                  />
                </div>
                <Typography.Text type="secondary">
                  前端：Ant Design X ｜ 后端：Claude Agent SDK
                </Typography.Text>
              </div>

              <div className="chat-window">
                {activeItems.length > 0 ? (
                  <Bubble.List items={activeItems} role={roles} autoScroll />
                ) : (
                  <div className="empty-tip">开始一个新对话，问点什么吧。</div>
                )}
              </div>

              <Sender
                value={input}
                loading={loading}
                placeholder="输入你的问题，回车发送"
                onChange={setInput}
                onSubmit={sendMessage}
                onCancel={handleCancel}
                submitType="enter"
                autoSize={{ minRows: 2, maxRows: 6 }}
                disabled={!activeConversation}
                suffix={(oriNode) => (
                  <Space size={4}>
                    <Tooltip
                      title={
                        recording
                          ? "点击停止录音"
                          : transcribing
                            ? "正在识别语音，请稍候"
                            : "点击开始语音输入"
                      }
                    >
                      <Button
                        type={recording ? "primary" : "text"}
                        danger={recording}
                        shape="circle"
                        aria-label={recording ? "停止语音输入" : "开始语音输入"}
                        title={recording ? "停止语音输入" : "开始语音输入"}
                        icon={
                          <i
                            className={recording ? "fa-solid fa-stop" : "fa-solid fa-microphone"}
                            aria-hidden="true"
                          />
                        }
                        onClick={toggleRecording}
                        disabled={!activeConversation || loading || transcribing}
                      />
                    </Tooltip>
                    {oriNode}
                  </Space>
                )}
              />
              <Space size={8} wrap>
                <Select
                  value={asrModelId}
                  options={ASR_MODEL_SELECT_OPTIONS}
                  style={{ minWidth: 210 }}
                  size="small"
                  onChange={(value) => setAsrModelId(String(value))}
                  disabled={recording || transcribing || loading || asrPreloading}
                />
                <Button
                  size="small"
                  onClick={() => void preloadAsrModel()}
                  loading={asrPreloading}
                  disabled={recording || transcribing || loading || asrPreloading}
                >
                  {asrReadyMap[asrModelId] ? "模型已就绪" : "预加载语音模型"}
                </Button>
              </Space>
              {(recording || transcribing || asrError) && (
                <Typography.Text type={asrError ? "danger" : "secondary"}>
                  {asrError
                    ? `语音输入失败：${asrError}`
                    : recording
                      ? "录音中，点击麦克风按钮结束并开始识别..."
                      : `正在加载并运行语音识别模型（${asrModelLabel}）...`}
                </Typography.Text>
              )}
            </Space>
          </section>
        </div>
      </Card>
      <SettingsModal
        open={settingsOpen}
        loading={settingsLoading}
        envEditorLoading={envEditorLoading}
        envEditorSaving={envEditorSaving}
        envEditorError={envEditorError}
        envEditorNotice={envEditorNotice}
        envFilePath={envFilePath}
        envFileContent={envFileContent}
        onClose={() => setSettingsOpen(false)}
        onSaveEnv={saveEnvFile}
        onChangeEnvContent={setEnvFileContent}
        configPath={configPath}
        configSaving={configSaving}
        configError={configError}
        configNotice={configNotice}
        mcpServers={mcpServers}
        mcpTestingMap={mcpTestingMap}
        mcpTestResultMap={mcpTestResultMap}
        onAddMcpServer={addMcpServer}
        onRemoveMcpServer={removeMcpServer}
        onChangeMcpServer={updateMcpServer}
        onTestMcpServer={testMcpServerConnection}
        onSaveConfig={saveConfigFile}
      />
    </main>
  );
}

export default App;
