import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject, Tool } from "../shared/types.js";

const tools: Tool[] = [
  {
    name: "echo",
    title: "文本回声",
    description: "返回输入文本，可选转为大写。",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          title: "内容",
          default: "Hello, MCP.",
          minLength: 1,
        },
        uppercase: { type: "boolean", title: "转为大写", default: false },
      },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "calculate",
    title: "数值计算",
    description: "计算一组数字的总和或平均值。",
    inputSchema: {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          title: "数字",
          items: { type: "number" },
          default: [12, 24, 36],
          minItems: 1,
        },
        operation: {
          type: "string",
          title: "运算",
          enum: ["sum", "average"],
          default: "sum",
        },
      },
      required: ["numbers", "operation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "inspect_payload",
    title: "检查结构",
    description: "原样返回嵌套对象，验证 JSON 参数。",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          title: "数据",
          default: { project: "MCP Lab", enabled: true, tags: ["sse", "http"] },
        },
      },
      required: ["payload"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "mixed_result",
    title: "多类型结果",
    description: "返回文本、JSON、图片和嵌入资源。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "slow_task",
    title: "进度测试",
    description: "逐步返回进度，用于验证等待与取消。",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "integer",
          title: "运行秒数",
          minimum: 1,
          maximum: 30,
          default: 3,
        },
      },
      required: ["seconds"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail",
    title: "错误测试",
    description: "返回一个工具错误，验证失败状态。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

export function registerDemo(
  app: FastifyInstance,
  options: {
    token?: string;
    pageSize?: number;
    header?: [string, string];
  } = {},
) {
  const servers = new Set<Server>();
  const http = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();
  const calls: { name: string; arguments: JsonObject }[] = [];
  const requests: { path: string; authorized: boolean }[] = [];
  function makeServer() {
    const server = new Server(
      { name: "mcp-lab-demo", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const start = Number(request.params?.cursor ?? 0);
      const count = options.pageSize ?? tools.length;
      return {
        tools: tools.slice(start, start + count),
        ...(start + count < tools.length
          ? { nextCursor: String(start + count) }
          : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = request.params.arguments ?? {};
      calls.push({ name: request.params.name, arguments: args });
      switch (request.params.name) {
        case "echo": {
          const message = String(args.message);
          return {
            content: [
              {
                type: "text",
                text: args.uppercase ? message.toUpperCase() : message,
              },
            ],
          };
        }
        case "calculate": {
          const numbers = args.numbers as number[];
          const sum = numbers.reduce((a, b) => a + b, 0);
          const value =
            args.operation === "average" ? sum / numbers.length : sum;
          return {
            content: [{ type: "text", text: JSON.stringify({ value }) }],
            structuredContent: { value },
          };
        }
        case "inspect_payload":
          return {
            content: [
              { type: "text", text: JSON.stringify(args.payload, null, 2) },
            ],
            structuredContent: args.payload,
          };
        case "mixed_result":
          return {
            content: [
              {
                type: "text",
                text: "MCP connection verified.\n多内容块按原始顺序返回。",
              },
              {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              },
              {
                type: "resource",
                resource: {
                  uri: "demo://status",
                  mimeType: "application/json",
                  text: '{"status":"ready"}',
                },
              },
            ],
            structuredContent: {
              status: "ready",
              transports: ["sse", "streamable-http"],
            },
          };
        case "slow_task": {
          const total = Number(args.seconds);
          for (let i = 1; i <= total; i++) {
            await delay(1000, undefined, { signal: extra.signal });
            const progressToken = request.params._meta?.progressToken;
            if (progressToken !== undefined)
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: i,
                  total,
                  message: `${i} / ${total}`,
                },
              });
          }
          return {
            content: [{ type: "text", text: `已完成 ${total} 秒任务。` }],
          };
        }
        case "fail":
          return {
            isError: true,
            content: [
              { type: "text", text: "DEMO_ERROR：这是服务端返回的工具错误。" },
            ],
          };
        default:
          throw new Error("Unknown tool");
      }
    });
    return server;
  }
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/demo/")) return;
    const authorized =
      (!options.token ||
        request.headers.authorization === `Bearer ${options.token}`) &&
      (!options.header ||
        request.headers[options.header[0]] === options.header[1]);
    requests.push({ path: request.url.split("?")[0], authorized });
    if (!authorized) return reply.code(401).send({ error: "Unauthorized" });
  });

  for (const path of ["/demo/mcp", "/demo/json"]) {
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: path,
      handler: async (request, reply) => {
        const sessionId = request.headers["mcp-session-id"] as
          | string
          | undefined;
        let transport = sessionId ? http.get(sessionId) : undefined;
        if (
          !transport &&
          !sessionId &&
          request.method === "POST" &&
          isInitializeRequest(request.body)
        ) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: path.endsWith("json"),
            onsessioninitialized: (id) => {
              http.set(id, transport!);
            },
          });
          const server = makeServer();
          await server.connect(transport);
          const onclose = transport.onclose;
          transport.onclose = () => {
            if (transport?.sessionId) http.delete(transport.sessionId);
            servers.delete(server);
            onclose?.();
          };
        }
        if (!transport)
          return reply
            .code(sessionId ? 404 : 400)
            .send({ error: "Unknown session" });
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    });
  }
  app.get("/demo/sse", async (request, reply) => {
    reply.hijack();
    const transport = new SSEServerTransport("/demo/messages", reply.raw);
    sse.set(transport.sessionId, transport);
    const server = makeServer();
    await server.connect(transport);
    reply.raw.on("close", () => {
      sse.delete(transport.sessionId);
      servers.delete(server);
      void server.close();
    });
  });
  app.post("/demo/messages", async (request, reply) => {
    const id = (request.query as { sessionId?: string }).sessionId;
    const transport = id ? sse.get(id) : undefined;
    if (!transport) return reply.code(404).send({ error: "Unknown session" });
    reply.hijack();
    await transport.handlePostMessage(request.raw, reply.raw, request.body);
  });
  app.addHook("preClose", async () => {
    await Promise.all([...servers].map((server) => server.close()));
  });
  return { calls, requests };
}
