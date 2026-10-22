export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: {
      "X-MCP-Workbench": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response
    .json()
    .catch(() => ({ error: "服务没有返回有效 JSON。" }));
  if (!response.ok)
    throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data as T;
}
