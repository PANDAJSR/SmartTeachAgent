import { XMarkdown } from "@ant-design/x-markdown";
import type { ContentSegment } from "../types";

export const renderToolText = (segment: ContentSegment) => {
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
