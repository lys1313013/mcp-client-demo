import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { buildApp } from "../server/app.js";
import { registerDemo } from "../server/demo.js";
import type { AppState, Run, TransportType } from "../shared/types.js";

for (const [transport, endpoint] of [
  ["sse", "/demo/sse"],
  ["streamable-http", "/demo/mcp"],
  ["streamable-http", "/demo/json"],
] as [TransportType, string][]) {
  test(`${transport} ${endpoint}: real transport, authentication, exact tool dispatch and failure semantics`, async (t) => {
    const remote = Fastify();
    const observed = registerDemo(remote, {
      token: "integration-secret-9381",
      header: ["x-tenant", "integration-team-29"],
      pageSize: 2,
    });
    const origin = await remote.listen({ host: "127.0.0.1", port: 0 });
    const app = buildApp();
    let cookie = "";
    t.after(async () => {
      await app.close();
      await remote.close();
    });
    async function request(path: string, body?: Record<string, unknown>) {
      const response = await app.inject({
        method: body === undefined ? "GET" : "POST",
        url: `/api/${path}`,
        headers: {
          host: "localhost",
          "x-mcp-workbench": "1",
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { payload: body }),
      });
      const setCookie = response.headers["set-cookie"];
      if (setCookie)
        cookie = String(
          Array.isArray(setCookie) ? setCookie[0] : setCookie,
        ).split(";")[0];
      return { status: response.statusCode, body: response.json() };
    }
    async function waitRun(id: string) {
      for (let i = 0; i < 150; i++) {
        const { body } = await request("state");
        const run = (body as AppState).run!;
        assert.equal(run.id, id);
        if (run.status !== "running") return run;
        await delay(20);
      }
      throw new Error("Tool did not complete");
    }
    const connectionInput = {
      transport,
      url: `${origin}${endpoint}`,
      token: "integration-secret-9381",
      headers: { "x-tenant": "integration-team-29" },
    };
    const badAuth = await request("connect", {
      ...connectionInput,
      token: "bad-token",
    });
    assert.equal(badAuth.status, 502);
    assert.match(badAuth.body.error, /认证失败/);

    const connected = await request("connect", connectionInput);
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    const connection = (connected.body as AppState).connection!;
    assert.equal(connection.name, "mcp-lab-demo");
    assert.equal(connection.transport, transport);
    assert.equal(connection.protocolVersion, "2025-11-25");
    assert.equal(connection.tools.length, 6, "all pages must be discovered");
    assert.equal(
      JSON.stringify(connected.body).includes(connectionInput.token),
      false,
    );

    const call = (
      name: string,
      args: Record<string, unknown>,
      timeoutMs?: number,
    ) =>
      request("call", {
        connectionId: connection.id,
        name,
        arguments: args,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    const invalid = await call("echo", { message: 123 });
    assert.equal(invalid.status, 400);
    assert.equal(
      observed.calls.length,
      0,
      "validation must happen before dispatch",
    );
    const unknown = await call("unknown_tool", {});
    assert.equal(unknown.status, 400);
    assert.equal(
      observed.calls.length,
      0,
      "unknown tool must not reach server",
    );

    const echoStart = await call("echo", {
      message: "hello selected tool",
      uppercase: true,
    });
    assert.equal(echoStart.status, 202);
    const echo = await waitRun(echoStart.body.id);
    assert.equal(echo.status, "success");
    assert.deepEqual(echo.result?.content, [
      { type: "text", text: "HELLO SELECTED TOOL" },
    ]);
    assert.deepEqual(observed.calls[0], {
      name: "echo",
      arguments: { message: "hello selected tool", uppercase: true },
    });

    const calc = await call("calculate", {
      numbers: [3, 6, 12],
      operation: "average",
    });
    const calcResult = await waitRun(calc.body.id);
    assert.equal(calcResult.status, "success");
    assert.deepEqual(calcResult.result?.structuredContent, { value: 7 });
    assert.equal(observed.calls[1].name, "calculate");

    const mixed = await call("mixed_result", {});
    const mixedResult = await waitRun(mixed.body.id);
    assert.equal(mixedResult.status, "success");
    assert.equal((mixedResult.result?.content as unknown[]).length, 3);
    assert.deepEqual(mixedResult.result?.structuredContent, {
      status: "ready",
      transports: ["sse", "streamable-http"],
    });

    const failure = await call("fail", {});
    const failureResult = await waitRun(failure.body.id);
    assert.equal(
      failureResult.status,
      "tool-error",
      "isError must override successful HTTP transport",
    );
    assert.match(JSON.stringify(failureResult.result), /DEMO_ERROR/);

    const secretEcho = await call("echo", { message: connectionInput.token });
    const secretResult = await waitRun(secretEcho.body.id);
    assert.equal(
      JSON.stringify(secretResult).includes(connectionInput.token),
      false,
    );
    assert.match(JSON.stringify(secretResult.result), /REDACTED/);

    const slow = await call("slow_task", { seconds: 3 });
    assert.equal(slow.status, 202);
    assert.equal((await call("echo", { message: "duplicate" })).status, 409);
    const cancelled = await request("cancel", { runId: slow.body.id });
    assert.equal(cancelled.body.run.status, "cancelled");
    assert.match(cancelled.body.run.error, /未知/);
    await delay(50);
    const timedOut = await call("slow_task", { seconds: 2 }, 100);
    const timeoutResult = await waitRun(timedOut.body.id);
    assert.equal(timeoutResult.status, "timeout");
    assert.match(timeoutResult.error!, /未知/);
    assert.equal(
      observed.calls.filter((call) => call.name === "slow_task").length,
      2,
      "never replay cancelled or timed-out calls",
    );

    const refreshed = await request("tools/refresh", {});
    assert.equal(refreshed.body.connection.tools.length, 6);
    const outsider = await app.inject({
      method: "GET",
      url: "/api/state",
      headers: { host: "localhost", "x-mcp-workbench": "1" },
    });
    assert.equal(
      outsider.json().connection,
      null,
      "browser sessions must not share credentials/connections",
    );
    const disconnected = await request("disconnect", {});
    assert.equal(disconnected.body.connection, null);
    assert.equal(
      (await call("echo", { message: "after-disconnect" })).status,
      409,
    );

    if (transport === "sse") {
      assert.ok(
        observed.requests.some(
          (request) => request.path === "/demo/sse" && request.authorized,
        ),
        "authenticate SSE GET",
      );
      assert.ok(
        observed.requests.some(
          (request) => request.path === "/demo/messages" && request.authorized,
        ),
        "authenticate message POST",
      );
    }
  });
}

test("local API rejects foreign origins, untrusted hosts and missing request marker", async (t) => {
  const app = buildApp({ devOrigin: "http://127.0.0.1:5173" });
  t.after(() => app.close());
  for (const headers of [
    {
      host: "localhost",
      origin: "https://untrusted.example",
      "x-mcp-workbench": "1",
    },
    { host: "untrusted.example", "x-mcp-workbench": "1" },
    { host: "localhost" },
  ]) {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/state", headers }))
        .statusCode,
      403,
    );
  }
  const request = (body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/connect",
      headers: { host: "localhost", "x-mcp-workbench": "1" },
      payload: body,
    });
  assert.equal(
    (await request({ transport: "sse", url: "file:///etc/passwd" })).statusCode,
    400,
  );
  assert.equal(
    (await request({ transport: "sse", url: "http://169.254.169.254/" }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await request({
        transport: "sse",
        url: "http://localhost:1234/",
        headers: { Host: "wrong" },
      })
    ).statusCode,
    400,
  );
});

test(
  "server shuts down cleanly with a live SSE demo connection",
  { timeout: 5000 },
  async () => {
    const app = buildApp({ demo: true });
    registerDemo(app);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${origin}/api/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mcp-workbench": "1" },
        body: JSON.stringify({ transport: "sse", url: `${origin}/demo/sse` }),
      });
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as AppState).connection?.tools.length,
        6,
      );
    } finally {
      await app.close();
    }
  },
);
