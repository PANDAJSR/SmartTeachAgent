import "dotenv/config";

import { query } from "@anthropic-ai/claude-agent-sdk";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { buildClaudeOptions } from "./claudeOptions";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "claude-agent-sdk-demo" });
});

type ChatRequestBody = {
  message?: string;
};

app.post(
  "/api/chat",
  async (req: Request<unknown, unknown, ChatRequestBody>, res: Response) => {
    const message = (req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ error: "message 不能为空" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: "缺少 ANTHROPIC_API_KEY，请先在 .env 中配置后重试",
      });
    }

    try {
      let finalResult = "";
      let resultMeta: {
        costUsd?: number;
        durationMs?: number;
        turns?: number;
        stopReason?: string | null;
      } | null = null;

      const options = buildClaudeOptions();

      for await (const sdkMessage of query({ prompt: message, options })) {
        if (sdkMessage.type !== "result") {
          continue;
        }

        if (sdkMessage.subtype === "success") {
          finalResult = sdkMessage.result;
          resultMeta = {
            costUsd: sdkMessage.total_cost_usd,
            durationMs: sdkMessage.duration_ms,
            turns: sdkMessage.num_turns,
            stopReason: sdkMessage.stop_reason,
          };
        } else {
          const detail = sdkMessage.errors?.join("; ") || "Claude Agent 执行失败";
          throw new Error(detail);
        }
      }

      if (!finalResult) {
        throw new Error("未获取到 Claude 返回内容");
      }

      return res.json({
        reply: finalResult,
        meta: resultMeta,
      });
    } catch (error) {
      console.error("[api/chat] error:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "服务异常",
      });
    }
  }
);

app.listen(port, () => {
  console.log(`Claude Agent Demo backend running at http://localhost:${port}`);
});
