import { useMemo, useRef, useState } from "react";
import { Bubble, Conversations, Sender, Think } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { Card, Space, Typography } from "antd";

type Role = "user" | "ai";

type ChatItem = {
  key: string;
  role: Role;
  content: string;
  status?: "loading" | "success" | "error" | "abort";
  extraInfo?: {
    streaming?: boolean;
    trace?: TraceEntry[];
  };
};

type TraceEntry = {
  type: "tool" | "thinking";
  text: string;
};

type ChatResponse = {
  reply?: string;
  error?: string;
  trace?: TraceEntry[];
};

type StreamEvent =
  | {
      type: "snapshot";
      reply: string;
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

function App() {
  const initialConversation = createConversation(1);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [conversations, setConversations] = useState<Conversation[]>([initialConversation]);
  const [activeConversationId, setActiveConversationId] = useState<string>(initialConversation.id);
  const activeRequestIdRef = useRef<string | null>(null);

  const roles = useMemo(
    () =>
      ({
        ai: {
          placement: "start",
          variant: "borderless",
          typing: (_content: string, info: { extraInfo?: { streaming?: boolean } }) =>
            info?.extraInfo?.streaming
              ? {
                  effect: "typing" as const,
                  step: [2, 5] as [number, number],
                  interval: 30,
                  keepPrefix: true,
                }
              : false,
          contentRender: (content: string, info: { extraInfo?: { streaming?: boolean } }) =>
            info?.extraInfo?.streaming ? content : <XMarkdown content={content} />,
          footer: (_content: string, info: { extraInfo?: { streaming?: boolean; trace?: TraceEntry[] } }) => {
            const trace = info?.extraInfo?.trace || [];
            const streaming = Boolean(info?.extraInfo?.streaming);
            const thinkingSteps = trace.filter((item) => item.type === "thinking").map((item) => item.text);
            const toolSteps = trace.filter((item) => item.type === "tool").map((item) => item.text);

            if (!streaming && thinkingSteps.length === 0 && toolSteps.length === 0) {
              return null;
            }

            return (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                <Think title={streaming ? "思考中" : "思考过程"} loading={streaming} defaultExpanded={false}>
                  {thinkingSteps.length > 0 ? (
                    <ol style={{ margin: 0, paddingLeft: 18 }}>
                      {thinkingSteps.map((step, idx) => (
                        <li key={`thinking-${idx}`}>{step}</li>
                      ))}
                    </ol>
                  ) : streaming ? (
                    <Typography.Text type="secondary">等待模型返回 thinking block...</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">本次模型未返回 thinking block。</Typography.Text>
                  )}
                </Think>

                {toolSteps.length > 0 ? (
                  <Think title="工具调用过程" defaultExpanded={false}>
                    <ol style={{ margin: 0, paddingLeft: 18 }}>
                      {toolSteps.map((step, idx) => (
                        <li key={`tool-${idx}`}>{step}</li>
                      ))}
                    </ol>
                  </Think>
                ) : null}
              </Space>
            );
          },
        },
        user: { placement: "end", variant: "filled" },
      } as const),
    []
  );

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
    const userKey = `user-${Date.now()}`;
    const aiKey = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
              status: "loading",
              extraInfo: { streaming: true, trace: [] },
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
        data = await window.smartTeach.chatStream(clean, requestId, (event: StreamEvent) => {
          if (event.type === "stopped") {
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
          setConversations((prev) =>
            prev.map((conversation) =>
              conversation.id === currentConversationId
                ? {
                    ...conversation,
                    items: conversation.items.map((item) =>
                      item.key === aiKey
                        ? {
                            ...item,
                            content: buildAiContent(event.reply || "", true),
                            status: "loading",
                            extraInfo: { streaming: true, trace: event.trace || [] },
                          }
                        : item
                    ),
                  }
                : conversation
            )
          );
        });
        if (stopped) {
          setLoading(false);
          activeRequestIdRef.current = null;
          return;
        }
      } else if (window.smartTeach?.chat) {
        data = await window.smartTeach.chat(clean);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ message: clean }),
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

      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === currentConversationId
            ? {
                ...conversation,
                items: conversation.items.map((item) =>
                  item.key === aiKey
                    ? {
                        ...item,
                        content: buildAiContent(data.reply || "", false),
                        status: "success",
                        extraInfo: { streaming: false, trace: data.trace || [] },
                      }
                    : item
                ),
              }
            : conversation
        )
      );
    } catch (error) {
      setConversations((prev) =>
        prev.map((conversation) =>
          conversation.id === currentConversationId
            ? {
                ...conversation,
                items: conversation.items.map((item) =>
                  item.key === aiKey
                    ? {
                        ...item,
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
                <Typography.Title level={3} style={{ margin: 0 }}>
                  智教助手
                </Typography.Title>
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
              />
            </Space>
          </section>
        </div>
      </Card>
    </main>
  );
}

export default App;
