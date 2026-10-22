import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ProfileStore,
  profileInputSchema,
  credentialsSchema,
} from "./profiles.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { validateArguments } from "../shared/schema.js";
import type {
  AppState,
  Connection,
  JsonObject,
  Run,
  Tool,
} from "../shared/types.js";

const MAX_RESPONSE = 20 * 1024 * 1024;
const connectSchema = z
  .object({
    transport: z.enum(["sse", "streamable-http"]),
    url: z.string().url().max(4096),
    token: z.string().max(8192).optional(),
    headers: z.record(z.string().max(8192)).default({}),
  })
  .strict();
const callSchema = z
  .object({
    connectionId: z.string().uuid(),
    name: z.string().min(1).max(1024),
    arguments: z.record(z.unknown()),
    timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
  })
  .strict();

class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
interface Session {
  touchedAt: number;
  client?: Client;
  transport?: SSEClientTransport | StreamableHTTPClientTransport;
  connection: Connection | null;
  run: Run | null;
  abort?: AbortController;
  busy: boolean;
  secrets: string[];
  tools?: Tool[];
}

function redact<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    let text = value as string;
    for (const secret of secrets
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)) {
      if (text === secret) text = "[REDACTED]";
      else if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    }
    return text as T;
  }
  if (Array.isArray(value))
    return value.map((item) => redact(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redact(child, secrets),
      ]),
    ) as T;
  return value;
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "请求失败";
  if (/401|Unauthorized/i.test(message))
    return "认证失败，请检查 Token 或 Header。";
  if (/403|Forbidden/i.test(message)) return "权限不足，服务器拒绝了当前凭据。";
  if (/fetch failed|ECONNREFUSED/i.test(message))
    return "无法连接服务器，请检查地址和服务是否启动。";
  if (/timeout|timed out/i.test(message))
    return "请求超时，服务端执行结果未知。";
  return message.slice(0, 2000);
}

function validateEndpoint(raw: string) {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AppError(
      "请输入 HTTP(S) 地址；认证请使用独立的 Token 或 Header。",
    );
  }
  if (/^(169\.254\.|0\.0\.0\.0$|\[?fe80:|metadata\.)/i.test(url.hostname)) {
    throw new AppError("不允许访问该地址。");
  }
  return url;
}

function getHeaders(config: z.infer<typeof connectSchema>) {
  const headers = new Headers();
  if (Object.keys(config.headers).length > 30)
    throw new AppError("最多配置 30 个 Header。");
  for (const [name, value] of Object.entries(config.headers)) {
    if (
      /^(host|origin|cookie|connection|content-length|content-type|accept|mcp-.*|proxy-.*|sec-.*|transfer-encoding)$/i.test(
        name,
      )
    ) {
      throw new AppError(`不能覆盖受管理的 Header：${name}`);
    }
    try {
      headers.set(name, value);
    } catch {
      throw new AppError(`Header 格式无效：${name}`);
    }
  }
  if (config.token?.trim())
    headers.set("Authorization", `Bearer ${config.token.trim()}`);
  return headers;
}

function guardedFetch(endpoint: URL, headers: Headers): typeof fetch {
  return async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (target.origin !== endpoint.origin)
      throw new AppError("服务端返回了跨源端点，已阻止发送凭据。");
    const merged = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    headers.forEach((value, key) => merged.set(key, value));
    new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
    const response = await fetch(input, {
      ...init,
      headers: merged,
      redirect: "error",
    });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          size += value.byteLength;
          if (size > MAX_RESPONSE) {
            await reader.cancel();
            controller.error(
              new Error("响应超过 20 MiB 上限，请缩小查询范围。"),
            );
          } else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function listTools(client: Client): Promise<Tool[]> {
  if (!client.getServerCapabilities()?.tools) return [];
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(15_000);
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await client.listTools(
      { cursor },
      { timeout: 15_000, signal },
    );
    tools.push(...(result.tools as Tool[]));
    if (!result.nextCursor) return tools;
    if (cursors.has(result.nextCursor))
      throw new AppError("服务器返回了重复的分页游标。", 502);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new AppError("工具列表超过 100 页，请缩小服务器暴露的工具范围。", 502);
}

export function buildApp(
  options: { devOrigin?: string; demo?: boolean; dataDir?: string } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  });
  const sessions = new Map<string, Session>();
  const profiles = new ProfileStore(
    options.dataDir ?? resolve(process.cwd(), ".data"),
  );
  app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return reply.code(403).send({ error: "仅允许本机访问。" });
    }
    if (!request.url.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== options.devOrigin) {
      return reply.code(403).send({ error: "请求来源不受信任。" });
    }
    if (request.headers["x-mcp-workbench"] !== "1") {
      return reply.code(403).send({ error: "缺少工作台请求标识。" });
    }
    let id = request.cookies.mcp_session;
    if (!id || !sessions.has(id)) {
      if (sessions.size >= 100)
        throw new AppError("本地会话数量已满，请稍后重试。", 429);
      id = randomUUID();
      sessions.set(id, {
        touchedAt: Date.now(),
        connection: null,
        run: null,
        busy: false,
        secrets: [],
      });
      reply.setCookie("mcp_session", id, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 8 * 3600,
      });
      request.cookies.mcp_session = id;
    }
    sessions.get(id)!.touchedAt = Date.now();
  });

  const sessionFor = (request: {
    cookies: Record<string, string | undefined>;
  }) => sessions.get(request.cookies.mcp_session!)!;
  const state = (session: Session): AppState => ({
    connection: session.connection,
    run: session.run,
  });
  async function closeSession(session: Session) {
    if (session.run?.status === "running") {
      session.run.status = "interrupted";
      session.run.error = "连接已断开，服务端执行结果未知。";
      session.run.durationMs = Date.now() - session.run.startedAt;
    }
    session.abort?.abort();
    const client = session.client;
    session.client = undefined;
    session.transport = undefined;
    session.connection = null;
    session.secrets = [];
    session.tools = undefined;
    await client?.close().catch(() => {});
  }

  app.get("/api/state", async (request) => state(sessionFor(request)));
  app.get("/api/config", async (request) => ({
    demo: Boolean(options.demo),
    demoBase: `http://127.0.0.1:${request.socket.localPort}`,
    node: process.versions.node,
  }));

  app.get("/api/profiles", async () => ({ profiles: profiles.list() }));
  app.post("/api/profiles/credentials", async (request, reply) => {
    const input = z
      .object({ id: z.string().uuid(), revision: z.number().int().positive() })
      .parse(request.body);
    const profile = profiles.get(input.id);
    if (profile.revision !== input.revision)
      throw new AppError("配置已更新，请刷新后再编辑。", 409);
    reply.header("Cache-Control", "no-store");
    return { credentials: profile.credentials ?? { token: "", headers: {} } };
  });
  function assertProfileIdle(id?: string) {
    if (!id) return;
    for (const session of sessions.values()) {
      if (
        session.busy ||
        (session.connection?.profileId === id &&
          session.run?.status === "running")
      )
        throw new AppError("请等待连接或调用结束后再修改服务。", 409);
    }
  }
  async function invalidateProfile(id: string) {
    for (const session of sessions.values())
      if (session.connection?.profileId === id) await closeSession(session);
  }
  app.post("/api/profiles/save", async (request) => {
    const input = profileInputSchema.parse(request.body);
    validateEndpoint(input.url);
    if (input.credentials) getHeaders({ ...input, ...input.credentials });
    assertProfileIdle(input.id);
    const profile = profiles.save(input);
    if (input.id) await invalidateProfile(input.id);
    return {
      profile,
      profiles: profiles.list(),
      ...state(sessionFor(request)),
    };
  });
  app.post("/api/profiles/delete", async (request) => {
    const input = z
      .object({ id: z.string().uuid(), revision: z.number().int().positive() })
      .parse(request.body);
    assertProfileIdle(input.id);
    profiles.remove(input.id, input.revision);
    await invalidateProfile(input.id);
    return { profiles: profiles.list(), ...state(sessionFor(request)) };
  });

  app.post("/api/connect", async (request) => {
    const input = z
      .union([
        connectSchema,
        z
          .object({
            profileId: z.string().uuid(),
            credentials: credentialsSchema.optional(),
          })
          .strict(),
      ])
      .parse(request.body);
    const profile =
      "profileId" in input ? profiles.get(input.profileId) : undefined;
    const config = profile
      ? connectSchema.parse({
          url: profile.url,
          transport: profile.transport,
          ...(("credentials" in input ? input.credentials : undefined) ??
            profile.credentials),
        })
      : connectSchema.parse(input);
    const session = sessionFor(request);
    if (session.busy || session.run?.status === "running")
      throw new AppError("请等待当前操作结束。", 409);
    const endpoint = validateEndpoint(config.url);
    const headers = getHeaders(config);
    const secrets = [
      config.token?.trim() ?? "",
      ...headers.values(),
      ...endpoint.searchParams.values(),
    ].filter(Boolean);
    session.busy = true;
    const client = new Client(
      { name: "mcp-lab", version: "0.1.0" },
      { capabilities: {} },
    );
    const fetcher = guardedFetch(endpoint, headers);
    const transport =
      config.transport === "sse"
        ? new SSEClientTransport(endpoint, {
            requestInit: { headers },
            eventSourceInit: { fetch: fetcher },
            fetch: fetcher,
          })
        : new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers },
            fetch: fetcher,
          });
    let protocolVersion = "";
    const setProtocolVersion = transport.setProtocolVersion.bind(transport);
    transport.setProtocolVersion = (version) => {
      protocolVersion = version;
      setProtocolVersion(version);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A transport may wait for an SSE endpoint before the SDK request timeout starts.
      await Promise.race([
        (async () => {
          await client.connect(transport, { timeout: 15_000 });
          return true;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AppError("连接超时，请检查地址与传输类型。", 504)),
            15_000,
          );
        }),
      ]);
      const tools = await listTools(client);
      await closeSession(session);
      session.client = client;
      session.transport = transport;
      session.secrets = secrets;
      session.tools = tools;
      session.run = null;
      const info = client.getServerVersion();
      const displayUrl = new URL(endpoint);
      for (const key of displayUrl.searchParams.keys())
        displayUrl.searchParams.set(key, "••••");
      session.connection = {
        id: randomUUID(),
        profileId: profile?.id,
        transport: config.transport,
        url: displayUrl.toString(),
        name: info?.name ?? endpoint.hostname,
        version: info?.version ?? "",
        protocolVersion,
        status: "connected",
        toolsSupported: Boolean(client.getServerCapabilities()?.tools),
        tools: redact(tools, secrets),
      };
      client.onclose = () => {
        if (session.client !== client) return;
        if (session.connection) session.connection.status = "disconnected";
        if (session.run?.status === "running") {
          session.run.status = "interrupted";
          session.run.error = "连接中断，服务端执行结果未知。";
          session.run.durationMs = Date.now() - session.run.startedAt;
        }
      };
      client.onerror = () => {
        // Transport errors invalidate the usable connection; reconnect explicitly, never replay calls.
        if (session.client === client && session.connection)
          session.connection.status = "disconnected";
      };
      return state(session);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new AppError(
        redact(readableError(error), secrets),
        error instanceof AppError ? error.statusCode : 502,
      );
    } finally {
      clearTimeout(timer);
      session.busy = false;
    }
  });

  app.post("/api/disconnect", async (request) => {
    const session = sessionFor(request);
    if (session.busy) throw new AppError("正在建立连接，请稍后再试。", 409);
    await closeSession(session);
    return state(session);
  });

  app.post("/api/tools/refresh", async (request) => {
    const session = sessionFor(request);
    if (!session.client || session.connection?.status !== "connected")
      throw new AppError("请先连接 MCP。", 409);
    const client = session.client;
    const tools = await listTools(client);
    if (session.client !== client || !session.connection)
      throw new AppError("连接已变化，请重试。", 409);
    session.connection.tools = redact(tools, session.secrets);
    session.tools = tools;
    return state(session);
  });

  app.post("/api/call", async (request, reply) => {
    const input = callSchema.parse(request.body);
    const session = sessionFor(request);
    if (session.busy || session.run?.status === "running")
      throw new AppError("已有工具正在执行。", 409);
    if (
      !session.client ||
      session.connection?.status !== "connected" ||
      session.connection.id !== input.connectionId
    ) {
      throw new AppError("连接已变化或已断开，请重新连接。", 409);
    }
    const tool = session.tools?.find((tool) => tool.name === input.name);
    if (!tool) throw new AppError("该工具不在当前服务器的工具列表中。");
    const validation = validateArguments(tool.inputSchema, input.arguments);
    if (validation.length) throw new AppError(validation.join("\n"));
    const client = session.client;
    const secrets = [...session.secrets];
    const run: Run = {
      id: randomUUID(),
      connectionId: input.connectionId,
      toolName: input.name,
      arguments: redact(input.arguments, secrets),
      status: "running",
      startedAt: Date.now(),
    };
    const controller = new AbortController();
    session.abort = controller;
    session.run = run;
    void (async () => {
      try {
        const result = await client.request(
          {
            method: "tools/call",
            params: { name: input.name, arguments: input.arguments },
          },
          CallToolResultSchema,
          {
            timeout: input.timeoutMs,
            maxTotalTimeout: input.timeoutMs,
            signal: controller.signal,
            onprogress: (progress) => {
              if (run.status === "running")
                run.progress = redact(progress, secrets);
            },
          },
        );
        if (run.status !== "running") return;
        run.result = redact(result as JsonObject, secrets);
        run.status = result.isError ? "tool-error" : "success";
        if (result.resultType && result.resultType !== "complete") {
          run.status = "error";
          run.error = "服务端返回了当前客户端未支持的交互结果，调用尚未完成。";
        }
        if (!result.isError && tool.outputSchema) {
          const outputErrors = validateArguments(
            tool.outputSchema,
            result.structuredContent,
          );
          if (outputErrors.length) {
            run.status = "error";
            run.error = `输出不符合 Schema：${outputErrors.join("；")}`;
          }
        }
      } catch (error) {
        if (run.status !== "running") return;
        const message = readableError(error);
        run.status = /timeout|timed out|超时/i.test(message)
          ? "timeout"
          : "error";
        run.error = redact(message, secrets);
      } finally {
        run.durationMs ??= Date.now() - run.startedAt;
        if (session.run === run) session.abort = undefined;
      }
    })();
    return reply.code(202).send(run);
  });

  app.post("/api/cancel", async (request) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.body);
    const session = sessionFor(request);
    if (session.run?.id !== runId)
      throw new AppError("调用已变化，请刷新状态。", 409);
    if (session.run.status === "running") {
      session.run.status = "cancelled";
      session.run.error = "已停止等待；服务端是否完成执行未知。";
      session.run.durationMs = Date.now() - session.run.startedAt;
      session.abort?.abort();
    }
    return state(session);
  });

  app.setErrorHandler((error, request, reply) => {
    const session = request.cookies
      ? sessions.get(request.cookies.mcp_session ?? "")
      : undefined;
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}：${issue.message}`)
            .join("\n")
        : readableError(error);
    const statusCode =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    reply
      .code(error instanceof z.ZodError ? 400 : statusCode)
      .send({ error: redact(message, session?.secrets ?? []) });
  });
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (
        !session.busy &&
        session.run?.status !== "running" &&
        Date.now() - session.touchedAt > 8 * 3600_000
      ) {
        sessions.delete(id);
        void closeSession(session);
      }
    }
  }, 60_000);
  cleanup.unref();
  app.addHook("preClose", async () => {
    clearInterval(cleanup);
    await Promise.all([...sessions.values()].map(closeSession));
  });
  return app;
}
