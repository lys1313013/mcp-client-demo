import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { registerDemo } from "./demo.js";

const demo = process.argv.includes("--demo");
const app = buildApp({
  demo,
  dataDir: process.env.DATA_DIR,
  devOrigin: demo ? "http://127.0.0.1:5173" : undefined,
});
if (demo) registerDemo(app);
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
if (existsSync(clientDir)) {
  await app.register(staticFiles, { root: clientDir });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.code(404).send({ error: "接口不存在。" })
      : reply.sendFile("index.html"),
  );
}
const port = Number(process.env.PORT ?? 3333);
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
console.log(
  `MCP Lab API: http://127.0.0.1:${port}${demo ? " (local demo enabled)" : ""}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
