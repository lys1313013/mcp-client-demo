import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { buildApp } from "../server/app.js";
import { registerDemo } from "../server/demo.js";
import { formatJsonText } from "../src/components.js";

test("saved services survive restart, preserve authentication, isolate selection and support CRUD", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "mcp-profiles-"));
  const remote = Fastify();
  registerDemo(remote, {
    token: "persistent-token-5417",
    header: ["x-team", "persistent-team-84"],
  });
  const origin = await remote.listen({ host: "127.0.0.1", port: 0 });
  let app = buildApp({ dataDir });
  let cookie = "";
  t.after(async () => {
    await app.close();
    await remote.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function request(path: string, body?: Record<string, unknown>) {
    const response = await app.inject({
      method: body ? "POST" : "GET",
      url: `/api/${path}`,
      headers: {
        host: "localhost",
        "x-mcp-workbench": "1",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { payload: body } : {}),
    });
    const setCookie = response.headers["set-cookie"];
    if (setCookie) cookie = String(setCookie).split(";")[0];
    return { status: response.statusCode, body: response.json() };
  }
  const credentials = {
    token: "persistent-token-5417",
    headers: { "x-team": "persistent-team-84" },
  };
  const saved = await request("profiles/save", {
    name: "Knowledge",
    url: `${origin}/demo/mcp`,
    transport: "streamable-http",

    credentials,
  });
  assert.equal(saved.status, 200);
  const http = saved.body.profile;
  const savedSse = await request("profiles/save", {
    name: "Search",
    url: `${origin}/demo/sse`,
    transport: "sse",

    credentials,
  });
  assert.equal(savedSse.status, 200);
  const sse = savedSse.body.profile;
  assert.equal(savedSse.body.profiles.length, 2);
  assert.equal(JSON.stringify(saved.body).includes(credentials.token), false);
  assert.equal(
    JSON.stringify(saved.body).includes(credentials.headers["x-team"]),
    false,
  );
  const disk = await readFile(join(dataDir, "servers.json"), "utf8");
  assert.deepEqual(JSON.parse(disk).profiles[0].credentials, credentials);
  assert.equal(disk.includes(origin), true);
  assert.equal((await stat(join(dataDir, "servers.json"))).mode & 0o777, 0o600);

  await app.close();
  app = buildApp({ dataDir });
  cookie = "";
  assert.equal((await request("profiles")).body.profiles.length, 2);
  for (const [profile, text] of [
    [http, "HTTP saved connection"],
    [sse, "SSE saved connection"],
  ] as const) {
    const connected = await request("connect", { profileId: profile.id });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.connection.profileId, profile.id);
    assert.equal(connected.body.connection.transport, profile.transport);
    const called = await request("call", {
      connectionId: connected.body.connection.id,
      name: "echo",
      arguments: { message: text },
    });
    assert.equal(called.status, 202);
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await request("state")).body.run;
      if (run.status !== "running") break;
      await delay(10);
    }
    assert.equal(run.status, "success");
    assert.deepEqual(run.result.content, [{ type: "text", text }]);
  }
  assert.deepEqual(
    (
      await request("profiles/credentials", {
        id: sse.id,
        revision: sse.revision,
      })
    ).body.credentials,
    credentials,
  );
  const oldConnectionId = (await request("state")).body.connection.id;
  assert.equal(
    (
      await request("profiles/save", {
        id: sse.id,
        revision: sse.revision,
        name: sse.name,
        url: "https://another.example/sse",
        transport: sse.transport,
      })
    ).status,
    400,
    "saved credentials must not follow an endpoint origin change implicitly",
  );
  const edited = await request("profiles/save", {
    id: sse.id,
    revision: sse.revision,
    name: "Search renamed",
    url: sse.url,
    transport: sse.transport,
  });
  assert.equal(edited.status, 200);
  assert.equal(
    edited.body.profile.hasCredentials,
    true,
    "unchanged credentials retained",
  );
  assert.equal(
    edited.body.connection,
    null,
    "editing invalidates stale connections",
  );
  assert.equal(
    (
      await request("call", {
        connectionId: oldConnectionId,
        name: "echo",
        arguments: { message: "stale" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("profiles/save", {
        id: sse.id,
        revision: sse.revision,
        name: "Conflict",
        url: sse.url,
        transport: sse.transport,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request("connect", { profileId: sse.id })).status,
    200,
    "preserved credentials still work",
  );
  const cleared = await request("profiles/save", {
    id: sse.id,
    revision: edited.body.profile.revision,
    name: "Search renamed",
    url: sse.url,
    transport: sse.transport,
    credentials: { token: "", headers: {} },
  });
  assert.equal(cleared.body.profile.hasCredentials, false);
  assert.equal(
    (await request("connect", { profileId: sse.id })).status,
    502,
    "credentials actually removed",
  );
  assert.equal(
    (await request("connect", { profileId: sse.id, credentials })).status,
    200,
    "temporary authentication supported",
  );
  const deleted = await request("profiles/delete", {
    id: sse.id,
    revision: cleared.body.profile.revision,
  });
  assert.equal(deleted.body.profiles.length, 1);
  assert.equal(deleted.body.connection, null);
  assert.equal((await request("connect", { profileId: sse.id })).status, 404);
  await app.close();
  app = buildApp({ dataDir });
  cookie = "";
  const remaining = (await request("profiles")).body.profiles;
  assert.deepEqual(
    remaining.map((item: { id: string }) => item.id),
    [http.id],
  );
  await writeFile(join(dataDir, "servers.json"), "{broken");
  assert.equal(
    (await request("profiles")).status,
    500,
    "corrupt files must not be overwritten",
  );
  assert.equal(
    (
      await request("profiles/save", {
        name: "Must not overwrite",
        url: `${origin}/demo/mcp`,
        transport: "streamable-http",
      })
    ).status,
    500,
  );
  assert.equal(
    await readFile(join(dataDir, "servers.json"), "utf8"),
    "{broken",
  );
});

test("JSON content is pretty-printed and non-JSON text is preserved", () => {
  assert.equal(
    formatJsonText('{"value":20,"list":[1,2]}'),
    '{\n  "value": 20,\n  "list": [\n    1,\n    2\n  ]\n}',
  );
  assert.equal(formatJsonText("hello\nMCP"), "hello\nMCP");
  assert.equal(formatJsonText('{"invalid"'), '{"invalid"');
});
