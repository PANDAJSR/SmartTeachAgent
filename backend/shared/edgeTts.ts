import { app } from "electron";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "path";

export type EdgeTtsPayload = {
  requestId?: string;
  text?: string;
  voice?: string;
  rate?: string;
  pitch?: string;
  volume?: string;
};

export type EdgeTtsStreamEvent =
  | {
      type: "chunk";
      chunkBase64: string;
      mimeType: "audio/mpeg";
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

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return char;
    }
  });
}

function buildVoiceOptions(payload?: EdgeTtsPayload) {
  return {
    voice: String(payload?.voice || process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural").trim(),
    rate: String(payload?.rate || process.env.EDGE_TTS_RATE || "default").trim(),
    pitch: String(payload?.pitch || process.env.EDGE_TTS_PITCH || "default").trim(),
    volume: String(payload?.volume || process.env.EDGE_TTS_VOLUME || "default").trim(),
  };
}

export async function synthesizeWithEdgeTts(payload?: EdgeTtsPayload): Promise<{
  ok: true;
  mimeType: "audio/mpeg";
  audioBase64: string;
  voice: string;
}> {
  const text = String(payload?.text || "").trim();
  if (!text) {
    throw new Error("text 不能为空");
  }

  const voiceOptions = buildVoiceOptions(payload);
  const { EdgeTTS } = await import("node-edge-tts");
  const tts = new EdgeTTS({
    voice: voiceOptions.voice,
    lang: "zh-CN",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    rate: voiceOptions.rate,
    pitch: voiceOptions.pitch,
    volume: voiceOptions.volume,
    timeout: 15000,
  });

  const ttsDir = path.join(app.getPath("temp"), "smartteachagent-tts");
  await fs.mkdir(ttsDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
  const filepath = path.join(ttsDir, filename);

  try {
    await tts.ttsPromise(text, filepath);
    const audioBuffer = await fs.readFile(filepath);
    return {
      ok: true,
      mimeType: "audio/mpeg",
      audioBase64: audioBuffer.toString("base64"),
      voice: voiceOptions.voice,
    };
  } finally {
    try {
      await fs.unlink(filepath);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function streamSynthesizeWithEdgeTts(
  payload: EdgeTtsPayload | undefined,
  activeSockets: Map<string, { close: () => void }>,
  onEvent: (event: EdgeTtsStreamEvent) => void
): Promise<void> {
  const text = String(payload?.text || "").trim();
  const requestId = String(payload?.requestId || "").trim();
  if (!text) {
    throw new Error("text 不能为空");
  }
  if (!requestId) {
    throw new Error("requestId 不能为空");
  }

  const voiceOptions = buildVoiceOptions(payload);
  const { EdgeTTS } = await import("node-edge-tts");
  const tts = new EdgeTTS({
    voice: voiceOptions.voice,
    lang: "zh-CN",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
    rate: voiceOptions.rate,
    pitch: voiceOptions.pitch,
    volume: voiceOptions.volume,
    timeout: 30000,
  });

  const ws = await tts._connectWebSocket();
  activeSockets.set(requestId, { close: () => ws.close() });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finalize = (cb: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      activeSockets.delete(requestId);
      cb();
    };

    const timeout = setTimeout(() => {
      finalize(() => {
        try {
          ws.close();
        } catch {
          // ignore close errors
        }
        reject(new Error("语音生成超时"));
      });
    }, 30000);

    ws.on("message", (rawData: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        if (rawData.toString().includes("Path:turn.end")) {
          clearTimeout(timeout);
          finalize(() => resolve());
        }
        return;
      }

      const separator = Buffer.from("Path:audio\r\n");
      const separatorIndex = rawData.indexOf(separator);
      const chunk = separatorIndex >= 0 ? rawData.subarray(separatorIndex + separator.length) : rawData;
      if (!chunk.length) {
        return;
      }
      onEvent({
        type: "chunk",
        chunkBase64: chunk.toString("base64"),
        mimeType: "audio/mpeg",
      });
    });

    ws.on("error", (error: Error) => {
      clearTimeout(timeout);
      finalize(() => reject(error));
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      if (!settled) {
        finalize(() => reject(new Error("语音连接已关闭")));
      }
    });

    const wsRequestId = randomBytes(16).toString("hex");
    ws.send(
      `X-RequestId:${wsRequestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">
          <voice name="${voiceOptions.voice}">
            <prosody rate="${voiceOptions.rate}" pitch="${voiceOptions.pitch}" volume="${voiceOptions.volume}">
              ${escapeXml(text)}
            </prosody>
          </voice>
        </speak>`
    );
  });
}
