import { useEffect, useRef, useState } from "react";
import { ChevronDown, Eye, EyeOff, Trash2, X } from "lucide-react";
import type { ServerProfile, TransportType } from "../shared/types";
import { api } from "./api";
import { parseObject } from "./components";

export interface Credentials {
  token: string;
  headers: Record<string, string>;
}
export interface ProfileDraft {
  id?: string;
  revision?: number;
  name: string;
  url: string;
  transport: TransportType;
  timeoutMs: number;
  credentials?: Credentials;
}
export function ProfileDialog({
  profile,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  profile?: ServerProfile;
  initial?: Partial<ProfileDraft>;
  onClose: () => void;
  onSave: (draft: ProfileDraft) => Promise<void>;
  onDelete: (profile: ServerProfile) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(profile?.name ?? initial?.name ?? "");
  const [url, setUrl] = useState(profile?.url ?? initial?.url ?? "");
  const [transport, setTransport] = useState<TransportType>(
    profile?.transport ?? initial?.transport ?? "streamable-http",
  );
  const [timeout, setTimeout] = useState((profile?.timeoutMs ?? 60_000) / 1000);
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("{}");
  const [showToken, setShowToken] = useState(false);
  const [loaded, setLoaded] = useState(!profile);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
  }, []);
  useEffect(() => {
    if (!profile) return;
    let alive = true;
    void api<{ credentials: Credentials }>("profiles/credentials", {
      id: profile.id,
      revision: profile.revision,
    })
      .then(({ credentials }) => {
        if (!alive) return;
        setToken(credentials.token);
        setHeaders(JSON.stringify(credentials.headers, null, 2));
        setLoaded(true);
      })
      .catch((error) => {
        if (alive)
          setError(error instanceof Error ? error.message : "读取配置失败");
      });
    return () => {
      alive = false;
    };
  }, [profile]);
  async function save() {
    if (!loaded) return;
    setError("");
    setBusy(true);
    try {
      const parsed = parseObject(headers);
      if (Object.values(parsed).some((value) => typeof value !== "string"))
        throw new Error("Header 值必须是字符串。");
      setHeaders(JSON.stringify(parsed, null, 2));
      await onSave({
        id: profile?.id,
        revision: profile?.revision,
        name: name.trim(),
        url: url.trim(),
        transport,
        timeoutMs: timeout * 1000,
        credentials: { token, headers: parsed as Record<string, string> },
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="profile-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="profile-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-heading">
          <div>
            <h2 id="profile-title">{profile ? "编辑服务" : "添加 MCP 服务"}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭配置"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <fieldset disabled={busy || !loaded} className="profile-fields">
          <label>
            服务名称
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：我的知识库"
              required
              maxLength={60}
            />
          </label>
          <div className="transport-switch" aria-label="传输方式">
            <button
              type="button"
              aria-pressed={transport === "streamable-http"}
              className={transport === "streamable-http" ? "selected" : ""}
              onClick={() => setTransport("streamable-http")}
            >
              Streamable HTTP
            </button>
            <button
              type="button"
              aria-pressed={transport === "sse"}
              className={transport === "sse" ? "selected" : ""}
              onClick={() => setTransport("sse")}
            >
              SSE
            </button>
          </div>
          <label>
            服务地址
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={
                transport === "sse"
                  ? "https://example.com/sse"
                  : "https://example.com/mcp"
              }
              required
              spellCheck={false}
            />
          </label>
          <details className="auth-details">
            <summary>
              认证与高级设置
              <ChevronDown size={15} />
            </summary>
            <div className="token-field">
              <label htmlFor="bearer-token">Bearer Token</label>
              <div className="token-input">
                <input
                  id="bearer-token"
                  type={showToken ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="可选"
                />
                <button
                  type="button"
                  className="icon-button token-visibility"
                  aria-label={showToken ? "隐藏 Token" : "显示 Token"}
                  title={showToken ? "隐藏 Token" : "显示 Token"}
                  aria-pressed={showToken}
                  onClick={() => setShowToken((visible) => !visible)}
                >
                  {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <label>
              Headers（JSON）
              <textarea
                aria-label="自定义 Headers"
                value={headers}
                spellCheck={false}
                onChange={(event) => {
                  setHeaders(event.target.value);
                }}
                onBlur={() => {
                  try {
                    setHeaders(JSON.stringify(parseObject(headers), null, 2));
                  } catch {
                    /* Keep invalid input for correction. */
                  }
                }}
              />
            </label>
            <label>
              调用超时（秒）
              <input
                type="number"
                min={1}
                max={300}
                value={timeout}
                onChange={(event) => setTimeout(Number(event.target.value))}
                required
              />
            </label>
          </details>
        </fieldset>
        {error && (
          <div className="dialog-error" role="alert">
            {error}
          </div>
        )}
        {deleting && profile && (
          <div className="delete-confirm" role="alert">
            <p>删除「{profile.name}」的本地配置？MCP 服务本身不受影响。</p>
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                返回
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onDelete(profile);
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : "删除失败",
                    );
                    setBusy(false);
                  }
                }}
              >
                确认删除
              </button>
            </div>
          </div>
        )}
        <div className="dialog-footer">
          {profile && (
            <button
              type="button"
              className="delete-button"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={15} />
              删除服务
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || deleting || !loaded}
          >
            {busy ? "处理中…" : "保存并连接"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
