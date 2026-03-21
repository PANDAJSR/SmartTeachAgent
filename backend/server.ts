import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import { createLogger } from "./shared/logger";
import { envFilePath } from "./shared/paths";
import { runClaudeChat } from "./shared/chatRuntime";
import type { ChatHistoryTurn } from "./shared/chatRuntime";

const app = express();
const { logInfo, logError } = createLogger("[SmartTeachAgent][server]");

const envLoadResult = dotenv.config({ path: envFilePath, override: true });
if (envLoadResult.error) {
  logError(`加载 env 失败，路径=${envFilePath}`, envLoadResult.error);
} else {
  logInfo(`已加载 env，路径=${envFilePath}，包含键数量=${Object.keys(envLoadResult.parsed || {}).length}`);
}
logInfo(`ANTHROPIC_API_KEY 已配置=${Boolean(process.env.ANTHROPIC_API_KEY)}`);

const port = Number(process.env.PORT || 3001);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "claude-agent-sdk-demo" });
});

type ChatRequestBody = {
  message?: string;
  history?: ChatHistoryTurn[];
};

app.post("/api/chat", async (req: Request<unknown, unknown, ChatRequestBody>, res: Response) => {
  const message = String(req.body?.message || "").trim();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  logInfo(`[${requestId}] 收到 /api/chat，messageLength=${message.length}`);

  if (!message) {
    return res.status(400).json({ error: "message 不能为空" });
  }

  try {
    const result = await runClaudeChat({ logInfo, logError }, {
      message,
      history: req.body?.history,
      debugTag: `server:${requestId}`,
      appendThinkingDelta: false,
    });
    logInfo(`[${requestId}] /api/chat 成功返回`);
    return res.json(result);
  } catch (error) {
    logError(`[${requestId}] /api/chat 异常`, error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "服务异常",
    });
  }
});

app.listen(port, () => {
  logInfo(`Claude Agent Demo backend running at http://localhost:${port}`);
});
