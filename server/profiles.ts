import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ServerProfile } from "../shared/types.js";

export const credentialsSchema = z
  .object({
    token: z.string().max(8192).default(""),
    headers: z.record(z.string().max(8192)).default({}),
  })
  .strict();
export const profileInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    name: z.string().trim().min(1, "请输入服务名称").max(60),
    url: z.string().url().max(4096),
    transport: z.enum(["sse", "streamable-http"]),
    timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
    credentials: credentialsSchema.optional(),
  })
  .strict();
export type ProfileInput = z.infer<typeof profileInputSchema>;
interface StoredProfile extends Omit<ServerProfile, "hasCredentials"> {
  credentials?: z.infer<typeof credentialsSchema>;
}
class ProfileError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

export class ProfileStore {
  private file: string;
  constructor(private directory: string) {
    this.file = join(directory, "servers.json");
  }
  private read(): StoredProfile[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.profiles))
        throw new Error("format");
      return data.profiles;
    } catch {
      throw new ProfileError("无法读取已保存的服务，请检查本机配置文件。", 500);
    }
  }
  private write(records: StoredProfile[]) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temp,
        JSON.stringify({ version: 1, profiles: records }, null, 2),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  private public(record: StoredProfile): ServerProfile {
    const { credentials, ...profile } = record;
    return {
      ...profile,
      hasCredentials: Boolean(
        credentials &&
          (credentials.token || Object.keys(credentials.headers).length),
      ),
    };
  }
  list() {
    return this.read().map((record) => this.public(record));
  }
  get(id: string) {
    const record = this.read().find((record) => record.id === id);
    if (!record) throw new ProfileError("服务配置不存在，请刷新列表。", 404);
    return record;
  }
  save(input: ProfileInput) {
    const records = this.read();
    const previous = input.id
      ? records.find((record) => record.id === input.id)
      : undefined;
    if (input.id && !previous) throw new ProfileError("服务配置不存在。", 404);
    if (previous && input.revision !== previous.revision)
      throw new ProfileError("服务配置已被更新，请重新打开编辑。", 409);
    if (
      records.some(
        (record) =>
          record.id !== input.id &&
          record.name.toLowerCase() === input.name.toLowerCase(),
      )
    )
      throw new ProfileError("服务名称已存在，请使用其他名称。", 409);
    if (!previous && records.length >= 50)
      throw new ProfileError("最多保存 50 个服务。");
    if (
      previous?.credentials &&
      !input.credentials &&
      new URL(previous.url).origin !== new URL(input.url).origin
    )
      throw new ProfileError(
        "服务域名或端口已改变，请确认并提交该服务的凭据。",
      );
    const record: StoredProfile = {
      id: previous?.id ?? randomUUID(),
      name: input.name,
      url: input.url,
      transport: input.transport,
      timeoutMs: input.timeoutMs,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      credentials: input.credentials ?? previous?.credentials,
    };
    this.write(
      previous
        ? records.map((item) => (item.id === record.id ? record : item))
        : [...records, record],
    );
    return this.public(record);
  }
  remove(id: string, revision: number) {
    const records = this.read();
    const record = records.find((record) => record.id === id);
    if (!record) throw new ProfileError("服务已删除。", 404);
    if (record.revision !== revision)
      throw new ProfileError("配置已更新，请刷新后再删除。", 409);
    this.write(records.filter((record) => record.id !== id));
  }
}
