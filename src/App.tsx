import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Cable,
  FlaskConical,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Play,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Square,
  Unplug,
  X,
} from "lucide-react";
import type {
  AppState,
  Connection,
  JsonObject,
  Run,
  ServerProfile,
} from "../shared/types";
import { validateArguments } from "../shared/schema";
import { api } from "./api";
import {
  ArgumentsForm,
  defaultArguments,
  JsonEditor,
  parseObject,
  ResultPanel,
  supportsForm,
} from "./components";
import { ProfileDialog, type ProfileDraft } from "./ProfileDialog";
import {
  forgetService,
  preferences,
  readDraft,
  rememberService,
  rememberTool,
  saveDraft,
} from "./preferences";

export default function App() {
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const profileRef = useRef("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
  const connectionRef = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("{}");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [validation, setValidation] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<{ demo: boolean; demoBase: string }>();
  const [dialog, setDialog] = useState<{
    profile?: ServerProfile;
    initial?: Partial<ProfileDraft>;
  } | null>(null);
  const epoch = useRef(0);
  const profile = profiles.find((item) => item.id === profileId);
  const currentConnection =
    connection?.profileId === profileId ? connection : null;
  const connected = currentConnection?.status === "connected";
  const tools = currentConnection?.tools ?? [];
  const tool = tools.find((item) => item.name === selected);
  const running = run?.status === "running";
  const busy = Boolean(loading) || running;
  const formSupported = tool ? supportsForm(tool.inputSchema) : false;
  let parsed: JsonObject = {};
  let parseError = "";
  try {
    parsed = parseObject(draft);
  } catch {
    parseError = "JSON 格式无效，请检查逗号、引号和括号。";
  }

  function chooseTool(
    name: string,
    active = currentConnection,
    id = profileRef.current,
    recentRun = run,
  ) {
    const next = active?.tools.find((item) => item.name === name);
    selectedRef.current = name;
    setSelected(name);
    setValidation([]);
    setBuffers({});
    setFieldErrors({});
    setConfirm(false);
    if (next) {
      const saved = readDraft(id, name);
      const snapshot =
        recentRun &&
        recentRun.connectionId === active?.id &&
        recentRun.toolName === name
          ? recentRun.arguments
          : defaultArguments(next);
      setDraft(saved ?? JSON.stringify(snapshot, null, 2));
      rememberTool(id, name);
      if (!supportsForm(next.inputSchema)) setMode("json");
    } else setDraft("{}");
  }
  function adopt(next: AppState) {
    setConnection(next.connection);
    setRun(next.run);
    setSyncError("");
    if (next.connection?.profileId !== profileRef.current) return;
    if (
      next.connection &&
      (connectionRef.current !== next.connection.id ||
        !next.connection.tools.some(
          (item) => item.name === selectedRef.current,
        ))
    ) {
      connectionRef.current = next.connection.id;
      const remembered = preferences().tools[profileRef.current];
      const name = next.connection.tools.some(
        (item) => item.name === remembered,
      )
        ? remembered
        : (next.connection.tools[0]?.name ?? "");
      chooseTool(name, next.connection, profileRef.current, next.run);
    }
  }
  function activate(id: string) {
    profileRef.current = id;
    setProfileId(id);
    rememberService(id);
    connectionRef.current = undefined;
    setSearch("");
    setSelected("");
    selectedRef.current = "";
    setDraft("{}");
    setValidation([]);
    setBuffers({});
    setFieldErrors({});
    setConfirm(false);
  }
  async function connectProfile(target: ServerProfile) {
    const currentEpoch = ++epoch.current;
    activate(target.id);
    setLoading("connect");
    setError("");
    try {
      const next = await api<AppState>("connect", {
        profileId: target.id,
      });
      if (currentEpoch === epoch.current) adopt(next);
    } catch (error) {
      if (currentEpoch === epoch.current)
        setError(error instanceof Error ? error.message : "连接失败");
    } finally {
      if (currentEpoch === epoch.current) setLoading("");
    }
  }
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api<AppState>("state"),
      api<{ profiles: ServerProfile[] }>("profiles"),
      api<NonNullable<typeof config>>("config"),
    ])
      .then(([state, saved, config]) => {
        if (!alive) return;
        setProfiles(saved.profiles);
        setConfig(config);
        setReady(true);
        const preferred =
          state.run?.status === "running"
            ? state.connection?.profileId
            : preferences().serviceId;
        const target =
          saved.profiles.find((item) => item.id === preferred) ??
          saved.profiles.find(
            (item) => item.id === state.connection?.profileId,
          ) ??
          saved.profiles[0];
        if (target) {
          activate(target.id);
          adopt(state);
          if (
            state.connection?.profileId !== target.id ||
            state.connection.status !== "connected"
          )
            void connectProfile(target);
        } else adopt(state);
      })
      .catch((error) => {
        if (alive) {
          setError(error.message);
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!connection) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const before = epoch.current;
      try {
        const next = await api<AppState>("state");
        if (alive && before === epoch.current) adopt(next);
      } catch (error) {
        if (alive)
          setSyncError(error instanceof Error ? error.message : "状态同步失败");
      } finally {
        if (alive) timer = setTimeout(() => void poll(), running ? 350 : 5000);
      }
    };
    timer = setTimeout(() => void poll(), running ? 100 : 5000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [connection?.id, running]);
  useEffect(() => {
    if (!run || !running) return;
    const tick = () => setElapsed(Date.now() - run.startedAt);
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [run?.id, running]);
  function editDraft(next: string) {
    setDraft(next);
    saveDraft(profileId, selected, next);
    setValidation([]);
    setConfirm(false);
  }
  function formatDraft() {
    try {
      editDraft(JSON.stringify(parseObject(draft), null, 2));
    } catch {
      setValidation(["JSON 格式无效，已保留原文，请修正后再格式化。"]);
    }
  }
  async function action(path: string, body = {}) {
    const currentEpoch = ++epoch.current;
    setError("");
    setLoading(path);
    try {
      const next = await api<AppState>(path, body);
      if (currentEpoch === epoch.current) adopt(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败");
    } finally {
      setLoading("");
    }
  }
  async function saveProfile(input: ProfileDraft) {
    const saved = await api<
      AppState & { profile: ServerProfile; profiles: ServerProfile[] }
    >("profiles/save", input);
    setProfiles(saved.profiles);
    setDialog(null);
    adopt(saved);
    await connectProfile(saved.profile);
  }
  async function deleteProfile(target: ServerProfile) {
    ++epoch.current;
    const next = await api<AppState & { profiles: ServerProfile[] }>(
      "profiles/delete",
      { id: target.id, revision: target.revision },
    );
    forgetService(target.id);
    setProfiles(next.profiles);
    setDialog(null);
    adopt(next);
    if (target.id === profileId) {
      const replacement = next.profiles[0];
      activate(replacement?.id ?? "");
      if (replacement) await connectProfile(replacement);
    }
  }
  async function addDemos() {
    if (!config) return;
    setLoading("demo");
    setError("");
    try {
      let savedProfiles = profiles;
      for (const transport of ["streamable-http", "sse"] as const) {
        const url = `${config.demoBase}/demo/${transport === "sse" ? "sse" : "mcp"}`;
        if (
          savedProfiles.some(
            (item) => item.url === url && item.transport === transport,
          )
        )
          continue;
        const baseName = transport === "sse" ? "SSE 演示" : "HTTP 演示";
        let name = baseName;
        let index = 2;
        while (savedProfiles.some((item) => item.name === name))
          name = `${baseName} ${index++}`;
        const saved = await api<{ profiles: ServerProfile[] }>(
          "profiles/save",
          { name, url, transport },
        );
        savedProfiles = saved.profiles;
      }
      setProfiles(savedProfiles);
      const target = savedProfiles.find(
        (item) => item.url === `${config.demoBase}/demo/mcp`,
      )!;
      await connectProfile(target);
    } catch (error) {
      setError(error instanceof Error ? error.message : "添加演示服务失败");
    } finally {
      setLoading("");
    }
  }
  async function execute(confirmed = false) {
    if (!tool || !currentConnection || !profile || busy) return;
    const problems = [
      ...Object.values(fieldErrors).filter(Boolean),
      ...(parseError
        ? [parseError]
        : validateArguments(tool.inputSchema, parsed)),
    ];
    if (problems.length) {
      setValidation(problems);
      return;
    }
    editDraft(JSON.stringify(parsed, null, 2));
    if (tool.annotations?.destructiveHint && !confirmed) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setError("");
    setLoading("call");
    try {
      setRun(
        await api<Run>("call", {
          connectionId: currentConnection.id,
          name: tool.name,
          arguments: parsed,
          timeoutMs: profile.timeoutMs,
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "调用失败");
    } finally {
      setLoading("");
    }
  }
  const visibleTools = tools.filter((item) =>
    `${item.name} ${item.title ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const activeRun =
    run?.connectionId === currentConnection?.id && run?.toolName === selected
      ? run
      : null;

  return (
    <div className="app-shell">
      <aside className="service-sidebar" aria-label="服务管理">
        <a className="brand" href="/" aria-label="MCP 客户端首页">
          <span className="brand-icon">
            <Cable size={23} />
          </span>
          <strong>MCP 客户端</strong>
        </a>
        <div className="services-heading">
          <span>服务</span>
          <span className="count">{profiles.length}</span>
        </div>
        {profiles.length > 5 && (
          <div className="sidebar-search">
            <Search size={14} />
            <input
              aria-label="搜索服务"
              placeholder="搜索服务"
              value={serverSearch}
              onChange={(event) => setServerSearch(event.target.value)}
            />
          </div>
        )}
        <nav className="service-list">
          {profiles
            .filter((item) =>
              item.name.toLowerCase().includes(serverSearch.toLowerCase()),
            )
            .map((item) => (
              <div
                className={`service-item ${item.id === profileId ? "active" : ""}`}
                key={item.id}
              >
                <button
                  className="service-select"
                  disabled={busy}
                  aria-pressed={item.id === profileId}
                  onClick={() => {
                    if (item.id === profileId && connected) return;
                    void connectProfile(item);
                  }}
                >
                  <span className="service-icon">
                    <Server size={17} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                  </span>
                  {connection?.profileId === item.id &&
                    connection.status === "connected" && (
                      <i className="online-dot" />
                    )}
                </button>
                <button
                  className="service-menu icon-button"
                  aria-label={`管理 ${item.name}`}
                  disabled={busy}
                  onClick={() => setDialog({ profile: item })}
                >
                  <MoreHorizontal size={17} />
                </button>
              </div>
            ))}
          {!profiles.length && (
            <p className="sidebar-empty">添加服务，开始连接。</p>
          )}
        </nav>
        <button
          className="add-service"
          disabled={busy || !ready}
          onClick={() => setDialog({})}
        >
          <Plus size={16} />
          添加 MCP 服务
        </button>
      </aside>
      <div className="workspace-shell">
        <main>
          <div className="page-heading">
            <div>
              <h1>{profile?.name ?? "MCP 服务"}</h1>
              <p>
                {profile ? (
                  <>
                    <span
                      className={`connection-dot ${connected ? "online" : ""}`}
                    />
                    {connected
                      ? "已连接"
                      : loading === "connect"
                        ? "连接中"
                        : "未连接"}
                    <span className="heading-divider" />
                    {profile.transport === "sse" ? "SSE" : "Streamable HTTP"}
                    <span className="endpoint-text" title={profile.url}>
                      {profile.url}
                    </span>
                  </>
                ) : (
                  "保存 MCP 服务，选择工具，直接运行。"
                )}
              </p>
            </div>
            <div className="heading-actions">
              {profile ? (
                <>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setDialog({ profile })}
                  >
                    <SlidersHorizontal size={16} />
                    编辑
                  </button>
                  {connected ? (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void action("disconnect")}
                    >
                      <Unplug size={15} />
                      断开
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void connectProfile(profile)}
                    >
                      {loading === "connect" ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Cable size={16} />
                      )}
                      连接服务
                    </button>
                  )}
                </>
              ) : (
                <button
                  className="primary-button"
                  disabled={!ready || busy}
                  onClick={() => setDialog({})}
                >
                  <Plus size={16} />
                  添加服务
                </button>
              )}
            </div>
          </div>
          {(error || syncError) && (
            <div className="error-banner" role="alert">
              <span>{error || syncError}</span>
              <button
                aria-label="关闭错误提示"
                onClick={() => {
                  setError("");
                  setSyncError("");
                }}
              >
                <X size={17} />
              </button>
            </div>
          )}
          {!profile ? (
            <div className="welcome-card">
              <Cable size={36} className="welcome-icon" />
              <h2>添加服务，开始调用</h2>
              <div className="welcome-actions">
                <button
                  className="primary-button"
                  disabled={busy || !ready}
                  onClick={() => setDialog({})}
                >
                  <Plus size={16} />
                  添加第一个服务
                </button>
                {config?.demo && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void addDemos()}
                  >
                    <FlaskConical size={16} />
                    添加演示服务
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <section className="tool-selector" aria-label="指定工具">
                <div className="selector-title">
                  <Braces size={20} />
                  <span>调用工具</span>
                  <span className="count">{tools.length}</span>
                </div>
                <div className="tool-search">
                  <Search size={16} />
                  <input
                    aria-label="搜索工具"
                    placeholder="按名称查找工具"
                    disabled={!connected || busy}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && visibleTools[0])
                        chooseTool(
                          (
                            visibleTools.find((item) => item.name === search) ??
                            visibleTools[0]
                          ).name,
                        );
                    }}
                  />
                </div>
                <select
                  aria-label="选择工具"
                  value={
                    visibleTools.some((item) => item.name === selected)
                      ? selected
                      : ""
                  }
                  disabled={!connected || busy}
                  onChange={(event) => chooseTool(event.target.value)}
                >
                  <option value="" disabled>
                    {connected
                      ? visibleTools.length
                        ? "选择一个工具"
                        : "没有匹配的工具"
                      : "连接后选择工具"}
                  </option>
                  {visibleTools.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                      {item.title?.trim() &&
                      item.title.trim() !== item.name.trim()
                        ? ` · ${item.title.trim()}`
                        : ""}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  title="刷新工具"
                  aria-label="刷新工具列表"
                  disabled={!connected || busy}
                  onClick={() => void action("tools/refresh")}
                >
                  <RefreshCw
                    size={16}
                    className={loading === "tools/refresh" ? "spin" : ""}
                  />
                </button>
              </section>
              <div className="workbench">
                <section className="parameters-panel" aria-label="工具参数">
                  <div className="panel-heading">
                    <div className="panel-label">
                      <span className="panel-icon">
                        <Braces size={17} />
                      </span>
                      <h2>请求参数</h2>
                    </div>
                    {tool && (
                      <div className="editor-tabs">
                        <button
                          disabled={
                            !formSupported || Boolean(parseError) || running
                          }
                          className={
                            mode === "form" && formSupported ? "active" : ""
                          }
                          onClick={() => setMode("form")}
                        >
                          表单
                        </button>
                        <button
                          disabled={
                            Object.values(fieldErrors).some(Boolean) || running
                          }
                          className={
                            mode === "json" || !formSupported ? "active" : ""
                          }
                          onClick={() => {
                            formatDraft();
                            setMode("json");
                            setBuffers({});
                          }}
                        >
                          JSON
                        </button>
                      </div>
                    )}
                  </div>
                  {tool ? (
                    <>
                      {tool.description && (
                        <div className="tool-caption">
                          <p title={tool.description}>{tool.description}</p>
                        </div>
                      )}
                      <div className="parameter-body">
                        {mode === "form" && formSupported ? (
                          <ArgumentsForm
                            tool={tool}
                            value={parsed}
                            disabled={busy}
                            buffers={buffers}
                            onChange={(value) =>
                              editDraft(JSON.stringify(value, null, 2))
                            }
                            setBuffer={(key, text, error = "") => {
                              setBuffers((previous) => ({
                                ...previous,
                                [key]: text,
                              }));
                              setFieldErrors((previous) => ({
                                ...previous,
                                [key]: error,
                              }));
                              setConfirm(false);
                            }}
                          />
                        ) : (
                          <>
                            <div className="code-toolbar">
                              <button
                                className="format-button"
                                disabled={busy}
                                onClick={formatDraft}
                              >
                                <Braces size={14} />
                                格式化
                              </button>
                            </div>
                            <JsonEditor
                              value={draft}
                              onChange={editDraft}
                              label="工具参数 JSON"
                              disabled={busy}
                            />
                          </>
                        )}
                        {(validation.length > 0 ||
                          Object.values(fieldErrors).some(Boolean)) && (
                          <div className="validation-errors" role="alert">
                            {[
                              ...new Set([
                                ...validation,
                                ...Object.values(fieldErrors).filter(Boolean),
                              ]),
                            ].map((message, index) => (
                              <div key={index}>{message}</div>
                            ))}
                          </div>
                        )}
                        <details className="schema-details">
                          <summary>
                            参数说明
                            <Plus size={13} />
                          </summary>
                          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                        </details>
                      </div>
                      <div className="execute-area">
                        {confirm && (
                          <div className="confirm-call" role="alert">
                            <p>此工具可能修改数据，确认调用 {tool.name}？</p>
                            <button
                              className="secondary-button"
                              onClick={() => setConfirm(false)}
                            >
                              返回
                            </button>
                            <button
                              className="primary-button"
                              onClick={() => void execute(true)}
                            >
                              确认调用
                            </button>
                          </div>
                        )}
                        {running ? (
                          <button
                            className="cancel-button"
                            disabled={Boolean(loading)}
                            onClick={() =>
                              void action("cancel", { runId: run.id })
                            }
                          >
                            <Square size={14} />
                            停止等待
                          </button>
                        ) : (
                          <button
                            className="execute-button"
                            disabled={!connected || Boolean(loading)}
                            onClick={() => void execute()}
                          >
                            {loading === "call" ? (
                              <LoaderCircle size={16} className="spin" />
                            ) : (
                              <Play size={15} fill="currentColor" />
                            )}
                            运行工具
                            <ArrowRight size={16} />
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="parameters-empty">
                      <Braces size={36} strokeWidth={1.3} />
                      <h3>
                        {loading === "connect"
                          ? "正在发现工具…"
                          : "选择一个工具"}
                      </h3>
                      <p>
                        {connected
                          ? currentConnection?.toolsSupported
                            ? "通过上方名称搜索和选择。"
                            : "该服务未提供工具能力。"
                          : "连接服务后，即可查看工具和参数。"}
                      </p>
                    </div>
                  )}
                </section>
                <ResultPanel
                  key={profileId}
                  run={activeRun}
                  elapsed={elapsed}
                />
              </div>
            </>
          )}
        </main>
      </div>
      {dialog && (
        <ProfileDialog
          profile={dialog.profile}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSave={saveProfile}
          onDelete={deleteProfile}
        />
      )}
    </div>
  );
}
