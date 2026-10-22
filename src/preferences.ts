interface Preferences {
  serviceId: string;
  tools: Record<string, string>;
}
export function preferences(): Preferences {
  try {
    return {
      serviceId: "",
      tools: {},
      ...JSON.parse(localStorage.getItem("mcp-lab-workspace") ?? "{}"),
    };
  } catch {
    return { serviceId: "", tools: {} };
  }
}
export function rememberService(serviceId: string) {
  try {
    localStorage.setItem(
      "mcp-lab-workspace",
      JSON.stringify({ ...preferences(), serviceId }),
    );
  } catch {
    /* Optional storage. */
  }
}
export function rememberTool(serviceId: string, tool: string) {
  try {
    const saved = preferences();
    localStorage.setItem(
      "mcp-lab-workspace",
      JSON.stringify({
        ...saved,
        tools: { ...saved.tools, [serviceId]: tool },
      }),
    );
  } catch {
    /* Optional storage. */
  }
}
export function readDraft(serviceId: string, tool: string) {
  try {
    return sessionStorage.getItem(`mcp-draft:${serviceId}:${tool}`);
  } catch {
    return null;
  }
}
export function saveDraft(serviceId: string, tool: string, draft: string) {
  try {
    if (draft.length <= 1_048_576)
      sessionStorage.setItem(`mcp-draft:${serviceId}:${tool}`, draft);
  } catch {
    /* Optional storage. */
  }
}
export function forgetService(serviceId: string) {
  try {
    const saved = preferences();
    delete saved.tools[serviceId];
    localStorage.setItem(
      "mcp-lab-workspace",
      JSON.stringify({
        ...saved,
        serviceId: saved.serviceId === serviceId ? "" : saved.serviceId,
      }),
    );
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(`mcp-draft:${serviceId}:`))
        sessionStorage.removeItem(key);
  } catch {
    /* Optional storage. */
  }
}
