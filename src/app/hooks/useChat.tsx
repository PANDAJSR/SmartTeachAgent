import { useMemo, useRef, useState } from "react";
import { useChatRoles } from "./useChatRoles";
import {
  UI_LOG_PREFIX,
  buildAiContent,
  buildHistoryTurns,
  buildTitleFromInput,
  createConversation,
  formatConversationTime,
  type ChatResponse,
  type Conversation,
  type StreamEvent,
} from "../types";

type UseChatPayload = {
  ttsGenerating: boolean;
  ttsPlaying: boolean;
  playTtsText: (text: string) => Promise<void>;
  stopTtsPlayback: () => void;
};

type UseChatResult = {
  input: string;
  setInput: (value: string) => void;
  loading: boolean;
  conversations: Conversation[];
  activeConversationId: string;
  setActiveConversationId: (value: string) => void;
  activeConversation: Conversation | undefined;
  activeItems: Conversation["items"];
  conversationItems: Array<{ key: string; label: string }>;
  roles: Record<string, unknown>;
  createNewConversation: () => void;
  sendMessage: (text: string) => Promise<void>;
  handleCancel: () => Promise<void>;
  appendTranscript: (text: string) => void;
};

export function useChat(payload: UseChatPayload): UseChatResult {
  const initialConversation = createConversation(1);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [conversations, setConversations] = useState<Conversation[]>([initialConversation]);
  const [activeConversationId, setActiveConversationId] = useState<string>(initialConversation.id);
  const activeRequestIdRef = useRef<string | null>(null);

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
    activeRequestIdRef.current = requestId;
    console.info(`${UI_LOG_PREFIX} sendMessage start requestId=${requestId} messageLength=${clean.length}`);

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
                        content: error instanceof Error ? `调用失败：${error.message}` : "调用失败：未知错误",
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

  const roles = useChatRoles({
    conversations,
    activeConversationId,
    loading,
    ttsGenerating: payload.ttsGenerating,
    ttsPlaying: payload.ttsPlaying,
    sendMessage,
    stopTtsPlayback: payload.stopTtsPlayback,
    playTtsText: payload.playTtsText,
  });

  const createNewConversation = (): void => {
    if (loading) {
      return;
    }
    const newConversation = createConversation(conversations.length + 1);
    setConversations((prev) => [...prev, newConversation]);
    setActiveConversationId(newConversation.id);
    setInput("");
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

  return {
    input,
    setInput,
    loading,
    conversations,
    activeConversationId,
    setActiveConversationId,
    activeConversation,
    activeItems,
    conversationItems,
    roles,
    createNewConversation,
    sendMessage,
    handleCancel,
    appendTranscript,
  };
}
