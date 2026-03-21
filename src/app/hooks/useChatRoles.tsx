import { Actions, Think } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { Space } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { ContentSegment, Conversation } from "../types";
import { getToolSegmentKey, getToolTitle } from "../types";
import { renderToolText } from "../utils/toolRender";

type UseChatRolesPayload = {
  conversations: Conversation[];
  activeConversationId: string;
  loading: boolean;
  ttsGenerating: boolean;
  ttsPlaying: boolean;
  sendMessage: (text: string) => Promise<void>;
  stopTtsPlayback: () => void;
  playTtsText: (text: string) => Promise<void>;
};

export function useChatRoles(payload: UseChatRolesPayload) {
  const [collapsedToolKeys, setCollapsedToolKeys] = useState<string[]>([]);

  useEffect(() => {
    const nextKeys: string[] = [];
    for (const conversation of payload.conversations) {
      for (const item of conversation.items) {
        const segments = item.extraInfo?.segments || [];
        segments.forEach((segment, index) => {
          if (segment.type !== "tool") {
            return;
          }
          if (segment.status === "completed" || segment.status === "failed" || segment.status === "stopped") {
            nextKeys.push(getToolSegmentKey(segment, index));
          }
        });
      }
    }
    setCollapsedToolKeys((prev) => Array.from(new Set([...prev, ...nextKeys])));
  }, [payload.conversations]);

  return useMemo(
    () => ({
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
                        hasNextChunk: Boolean(info?.extraInfo?.streaming) && index === segments.length - 1,
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
        footerPlacement: "outer-start",
        footer: (content: string, info: { key?: string | number; status?: string }) => {
          if (info?.status !== "success") {
            return null;
          }
          const aiKey = String(info?.key || "");
          if (!aiKey) {
            return null;
          }
          const currentConversation = payload.conversations.find(
            (conversation) => conversation.id === payload.activeConversationId
          );
          const items = currentConversation?.items || [];
          const aiIndex = items.findIndex((item) => item.key === aiKey);
          const retryTarget =
            aiIndex > 0
              ? [...items.slice(0, aiIndex)].reverse().find((item) => item.role === "user" && item.content.trim())
              : undefined;
          const aiText = String(content || "").trim();
          if (!retryTarget && !aiText) {
            return null;
          }
          return (
            <Actions
              variant="borderless"
              items={[
                ...(retryTarget
                  ? [
                      {
                        key: "retry-request",
                        icon: <i className="fa-solid fa-rotate-right" aria-hidden="true" />,
                        label: "重新生成",
                        onItemClick: () => {
                          if (!payload.loading) {
                            void payload.sendMessage(retryTarget.content);
                          }
                        },
                      },
                    ]
                  : []),
                ...(aiText
                  ? [
                      {
                        key: "speak-request",
                        icon: (
                          <i
                            className={
                              payload.ttsGenerating
                                ? "fa-solid fa-spinner fa-spin"
                                : payload.ttsPlaying
                                  ? "fa-solid fa-stop"
                                  : "fa-solid fa-volume-high"
                            }
                            aria-hidden="true"
                          />
                        ),
                        label: payload.ttsGenerating ? "生成中..." : payload.ttsPlaying ? "停止朗读" : "朗读",
                        onItemClick: () => {
                          if (payload.ttsPlaying) {
                            payload.stopTtsPlayback();
                            return;
                          }
                          if (!payload.ttsGenerating) {
                            void payload.playTtsText(aiText);
                          }
                        },
                      },
                    ]
                  : []),
              ]}
            />
          );
        },
      },
      user: {
        placement: "end",
        variant: "filled",
        footer: () => null,
      },
    }),
    [collapsedToolKeys, payload]
  );
}
