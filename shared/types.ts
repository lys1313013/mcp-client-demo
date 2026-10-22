export type TransportType = "sse" | "streamable-http";
export type JsonObject = Record<string, unknown>;
export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
}
export interface Connection {
  id: string;
  profileId?: string;
  transport: TransportType;
  url: string;
  name: string;
  version: string;
  protocolVersion: string;
  status: "connected" | "disconnected";
  toolsSupported: boolean;
  tools: Tool[];
}
export type RunStatus =
  | "running"
  | "success"
  | "tool-error"
  | "error"
  | "cancelled"
  | "timeout"
  | "interrupted";
export interface Run {
  id: string;
  connectionId: string;
  toolName: string;
  arguments: JsonObject;
  status: RunStatus;
  startedAt: number;
  durationMs?: number;
  result?: JsonObject;
  error?: string;
  progress?: { progress: number; total?: number; message?: string };
}
export interface AppState {
  connection: Connection | null;
  run: Run | null;
}

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  transport: TransportType;
  timeoutMs: number;
  hasCredentials: boolean;
  revision: number;
  updatedAt: string;
}
