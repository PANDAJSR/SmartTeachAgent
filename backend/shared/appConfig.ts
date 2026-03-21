import { promises as fs } from "node:fs";
import path from "path";
import { configFilePath } from "./paths";

export type HttpMcpServer = {
  enabled: boolean;
  name: string;
  url: string;
  headers: Record<string, string>;
};

export type AppConfig = {
  mcp: {
    httpServers: HttpMcpServer[];
  };
};

export function createDefaultConfig(): AppConfig {
  return {
    mcp: {
      httpServers: [],
    },
  };
}

function normalizeServer(rawServer: unknown, index: number): HttpMcpServer | null {
  if (!rawServer || typeof rawServer !== "object") {
    return null;
  }
  const enabled = Boolean((rawServer as { enabled?: unknown }).enabled);
  const name =
    String((rawServer as { name?: unknown }).name || `http-server-${index + 1}`).trim() ||
    `http-server-${index + 1}`;
  const url = String((rawServer as { url?: unknown }).url || "").trim();
  const rawHeaders = (rawServer as { headers?: unknown }).headers;
  const headers =
    rawHeaders && typeof rawHeaders === "object"
      ? Object.fromEntries(
          Object.entries(rawHeaders as Record<string, unknown>).map(([key, value]) => [key, String(value)])
        )
      : {};
  return { enabled, name, url, headers };
}

export function normalizeAppConfig(raw: unknown): AppConfig {
  const defaultConfig = createDefaultConfig();
  if (!raw || typeof raw !== "object") {
    return defaultConfig;
  }

  const rawMcp = (raw as { mcp?: unknown }).mcp;
  if (!rawMcp || typeof rawMcp !== "object") {
    return defaultConfig;
  }

  const rawHttpServers = (rawMcp as { httpServers?: unknown }).httpServers;
  if (Array.isArray(rawHttpServers)) {
    return {
      mcp: {
        httpServers: rawHttpServers
          .map((item, index) => normalizeServer(item, index))
          .filter((item): item is HttpMcpServer => Boolean(item)),
      },
    };
  }

  const legacyServer = (rawMcp as { macHttpServer?: unknown }).macHttpServer;
  const legacyNormalized = normalizeServer(legacyServer, 0);
  if (!legacyNormalized) {
    return defaultConfig;
  }
  return { mcp: { httpServers: [legacyNormalized] } };
}

export async function readAppConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(configFilePath, "utf-8");
    return normalizeAppConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return createDefaultConfig();
    }
    throw error;
  }
}

export async function writeAppConfig(config: unknown): Promise<AppConfig> {
  const normalized = normalizeAppConfig(config);
  await fs.mkdir(path.dirname(configFilePath), { recursive: true });
  await fs.writeFile(configFilePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  return normalized;
}

export function buildMcpServers(
  config: AppConfig
): Record<string, { type: "http"; url: string; headers?: Record<string, string> }> {
  const result: Record<string, { type: "http"; url: string; headers?: Record<string, string> }> = {};
  const usedNames = new Set<string>();

  for (const [index, server] of config.mcp.httpServers.entries()) {
    if (!server.enabled || !server.url) {
      continue;
    }
    let name = server.name.trim() || `http-server-${index + 1}`;
    if (usedNames.has(name)) {
      name = `${name}-${index + 1}`;
    }
    usedNames.add(name);
    result[name] = {
      type: "http",
      url: server.url,
      headers: Object.keys(server.headers).length > 0 ? server.headers : undefined,
    };
  }

  return result;
}
