import { useMemo, useState } from "react";
import { Bubble, Conversations, Sender } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { Card, Space, Typography } from "antd";

type Role = "user" | "ai";

type ChatItem = {
  key: string;
  role: Role;
  content: string;
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

const toMarkdownList = (items: string[]): string => items.map((item, idx) => `${idx + 1}. ${item}`).join("\n");

const buildAiContent = (reply: string, trace?: TraceEntry[]): string => {
  const sections: string[] = [reply.trim() || "（无文本回复）"];

  if (trace && trace.length > 0) {
    const toolSteps = trace.filter((item) => item.type === "tool").map((item) => item.text);
    const thinkingSteps = trace.filter((item) => item.type === "thinking").map((item) => item.text);

    if (toolSteps.length > 0) {
      sections.push("### 工具调用过程");
      sections.push(toMarkdownList(toolSteps));
    }

    if (thinkingSteps.length > 0) {
      sections.push("### 思考过程（摘要）");
      sections.push(toMarkdownList(thinkingSteps));
    }
  }

  return sections.join("\n\n");
};

function App() {
  const initialConversation = createConversation(1);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [conversations, setConversations] = useState<Conversation[]>([initialConversation]);
  const [activeConversationId, setActiveConversationId] = useState<string>(initialConversation.id);

  const roles = useMemo(
    () =>
      ({
        ai: {
          placement: "start",
          variant: "borderless",
          contentRender: (content: string) => <XMarkdown content={content} />,
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
            { key: aiKey, role: "ai", content: "思考中..." },
          ],
        };
      })
    );
    setInput("");
    setLoading(true);

    try {
      let data: ChatResponse;
      if (window.smartTeach?.chat) {
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
                    ? { ...item, content: buildAiContent(data.reply || "", data.trace) }
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
                      }
                    : item
                ),
              }
            : conversation
        )
      );
    } finally {
      setLoading(false);
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
