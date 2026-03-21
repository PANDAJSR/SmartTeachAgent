export async function testMcpHttpConnection(payload?: {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
}): Promise<{ ok: boolean; reachable: boolean; status: number | null; message: string }> {
  const serverName = String(payload?.name || "未命名服务器").trim() || "未命名服务器";
  const urlText = String(payload?.url || "").trim();
  if (!urlText) {
    return { ok: false, reachable: false, status: null, message: "URL 不能为空" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    return { ok: false, reachable: false, status: null, message: "URL 格式不正确" };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return { ok: false, reachable: false, status: null, message: "仅支持 HTTP/HTTPS 协议" };
  }

  const requestHeaders: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...(payload?.headers || {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "smartteachagent-test",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "SmartTeachAgent",
            version: "1.0.0",
          },
        },
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        ok: true,
        reachable: true,
        status: response.status,
        message: `${serverName} 连接成功（HTTP ${response.status}）`,
      };
    }
    return {
      ok: false,
      reachable: true,
      status: response.status,
      message: `${serverName} 可达，但握手失败（HTTP ${response.status}）`,
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return {
        ok: false,
        reachable: false,
        status: null,
        message: `${serverName} 连接超时（8s）`,
      };
    }
    return {
      ok: false,
      reachable: false,
      status: null,
      message: `${serverName} 连接失败：${error instanceof Error ? error.message : "未知错误"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
