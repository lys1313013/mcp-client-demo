import { useState } from "react";
import { Braces, Check, Copy, Download, Terminal, X } from "lucide-react";
import type { JsonObject, Run, Tool } from "../shared/types";

export function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("参数必须是 JSON 对象。");
  return value as JsonObject;
}

export function formatJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function defaultArguments(tool: Tool): JsonObject {
  const result: JsonObject = {};
  for (const [key, schema] of Object.entries(
    (tool.inputSchema.properties ?? {}) as Record<string, JsonObject>,
  )) {
    if (schema.default !== undefined) result[key] = schema.default;
  }
  return result;
}

export function supportsForm(schema: JsonObject) {
  return (
    ![
      "oneOf",
      "anyOf",
      "allOf",
      "$ref",
      "if",
      "patternProperties",
      "dependentSchemas",
    ].some((key) => key in schema) &&
    schema.type === "object" &&
    Object.values(
      (schema.properties ?? {}) as Record<string, JsonObject>,
    ).every(
      (property) =>
        !["oneOf", "anyOf", "allOf", "$ref"].some((key) => key in property) &&
        typeof property.type === "string" &&
        ["string", "number", "integer", "boolean", "array", "object"].includes(
          property.type,
        ),
    )
  );
}

export function JsonEditor({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="json-editor">
      <div className="line-numbers" aria-hidden="true">
        {value.split("\n").map((_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <textarea
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        disabled={disabled}
        onBlur={() => {
          try {
            onChange(JSON.stringify(parseObject(value), null, 2));
          } catch {
            /* Preserve invalid JSON. */
          }
        }}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "f"
          ) {
            event.preventDefault();
            try {
              onChange(JSON.stringify(parseObject(value), null, 2));
            } catch {
              /* Preserve invalid JSON. */
            }
          }
          if (event.key === "Tab") {
            event.preventDefault();
            const start = event.currentTarget.selectionStart;
            const end = event.currentTarget.selectionEnd;
            onChange(value.slice(0, start) + "  " + value.slice(end));
            const element = event.currentTarget;
            requestAnimationFrame(() => {
              element.selectionStart = element.selectionEnd = start + 2;
            });
          }
        }}
      />
    </div>
  );
}

export function ArgumentsForm({
  tool,
  value,
  onChange,
  buffers,
  setBuffer,
  disabled,
}: {
  tool: Tool;
  value: JsonObject;
  onChange: (value: JsonObject) => void;
  buffers: Record<string, string>;
  setBuffer: (key: string, text: string, error?: string) => void;
  disabled: boolean;
}) {
  const properties = (tool.inputSchema.properties ?? {}) as Record<
    string,
    JsonObject
  >;
  const required = (tool.inputSchema.required ?? []) as string[];
  if (!Object.keys(properties).length)
    return (
      <div className="no-parameters">
        <Braces size={30} strokeWidth={1.2} />
        <span>无需参数，直接调用。</span>
      </div>
    );
  function update(key: string, next: unknown) {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else result[key] = next;
    onChange(result);
  }
  return (
    <div className="arguments-form">
      {Object.entries(properties).map(([key, schema]) => {
        const id = `argument-${key}`;
        const label = typeof schema.title === "string" ? schema.title : key;
        const current = value[key];
        const optional = !required.includes(key);
        return (
          <div className="field" key={key}>
            <div className="field-heading">
              <label htmlFor={id} title={String(schema.description ?? "")}>
                {label}
                {!optional && <span className="required">*</span>}
              </label>
              <span className="field-type">
                {String(schema.type)}
                {optional && current !== undefined && (
                  <button
                    type="button"
                    className="inline-icon"
                    aria-label={`清除 ${label}`}
                    onClick={() => {
                      update(key, undefined);
                      setBuffer(key, "");
                    }}
                    disabled={disabled}
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            </div>
            {Array.isArray(schema.enum) ? (
              <select
                id={id}
                value={current === undefined ? "" : JSON.stringify(current)}
                disabled={disabled}
                onChange={(event) =>
                  update(
                    key,
                    event.target.value
                      ? JSON.parse(event.target.value)
                      : undefined,
                  )
                }
              >
                <option value="">请选择</option>
                {schema.enum.map((option, index) => (
                  <option value={JSON.stringify(option)} key={index}>
                    {String(option)}
                  </option>
                ))}
              </select>
            ) : schema.type === "boolean" ? (
              <label className="boolean-field">
                <input
                  id={id}
                  type="checkbox"
                  checked={current === true}
                  disabled={disabled}
                  onChange={(event) => update(key, event.target.checked)}
                />
                <span>
                  {current === undefined
                    ? "未设置"
                    : current
                      ? "true"
                      : "false"}
                </span>
              </label>
            ) : ["array", "object"].includes(String(schema.type)) ? (
              <textarea
                id={id}
                className="nested-json"
                spellCheck={false}
                disabled={disabled}
                value={
                  buffers[key] ??
                  (current === undefined
                    ? ""
                    : JSON.stringify(current, null, 2))
                }
                placeholder={schema.type === "array" ? "[]" : "{}"}
                onChange={(event) => {
                  const text = event.target.value;
                  if (!text.trim()) {
                    update(key, undefined);
                    setBuffer(key, text);
                    return;
                  }
                  try {
                    const parsed = JSON.parse(text);
                    update(key, parsed);
                    setBuffer(key, text);
                  } catch {
                    setBuffer(key, text, `${label}：JSON 格式无效`);
                  }
                }}
              />
            ) : schema.type === "string" ? (
              <textarea
                id={id}
                className="text-argument"
                value={typeof current === "string" ? current : ""}
                disabled={disabled}
                placeholder={key}
                rows={3}
                onChange={(event) => update(key, event.target.value)}
              />
            ) : (
              <input
                id={id}
                type="number"
                step={schema.type === "integer" ? "1" : "any"}
                value={typeof current === "number" ? current : ""}
                disabled={disabled}
                placeholder={key}
                onChange={(event) =>
                  update(
                    key,
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  )
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value) ?? "undefined";
    return (
      <span className={`json-${typeof value}`}>
        {text.length > 4000 ? `${text.slice(0, 4000)}…（下载完整结果）` : text}
      </span>
    );
  }
  const entries = Object.entries(value);
  if (depth >= 6) return <span>{JSON.stringify(value).slice(0, 2000)}</span>;
  return (
    <details className="json-tree" open={depth < 2}>
      <summary>
        {Array.isArray(value)
          ? `[ ${entries.length} 项 ]`
          : `{ ${entries.length} 个字段 }`}
      </summary>
      <div>
        {entries.slice(0, 200).map(([key, child]) => (
          <div className="json-entry" key={key}>
            <span className="json-key">{key}</span>
            <span className="json-colon">:</span>
            <JsonTree value={child} depth={depth + 1} />
          </div>
        ))}
        {entries.length > 200 && (
          <span>其余 {entries.length - 200} 项请下载查看。</span>
        )}
      </div>
    </details>
  );
}

function ContentBlock({ block }: { block: JsonObject }) {
  if (block.type === "text") {
    const text = formatJsonText(String(block.text ?? ""));
    return (
      <pre className="text-result">
        {text.slice(0, 1_048_576)}
        {text.length > 1_048_576 ? "\n… 预览已截断，请下载完整结果。" : ""}
      </pre>
    );
  }
  if (
    block.type === "image" &&
    /^image\/(png|jpeg|gif|webp)$/.test(String(block.mimeType))
  )
    return (
      <div className="image-result">
        <img
          src={`data:${block.mimeType};base64,${block.data}`}
          alt="工具返回的图片"
        />
        <span>{String(block.mimeType)}</span>
      </div>
    );
  if (
    block.type === "audio" &&
    /^audio\/(wav|mpeg|mp3|ogg|webm|mp4)$/.test(String(block.mimeType))
  )
    return (
      <audio controls src={`data:${block.mimeType};base64,${block.data}`} />
    );
  if (
    block.type === "resource" &&
    block.resource &&
    typeof block.resource === "object"
  ) {
    const resource = block.resource as JsonObject;
    return (
      <div className="embedded-resource">
        <div className="resource-uri">{String(resource.uri ?? "")}</div>
        {typeof resource.text === "string" ? (
          <pre className="text-result">
            {formatJsonText(resource.text).slice(0, 1_048_576)}
          </pre>
        ) : (
          <JsonTree value={resource} />
        )}
      </div>
    );
  }
  return <JsonTree value={block} />;
}

const statusLabels: Record<Run["status"], string> = {
  running: "执行中",
  success: "调用成功",
  "tool-error": "工具返回错误",
  error: "调用失败",
  cancelled: "已停止等待",
  timeout: "调用超时",
  interrupted: "连接中断",
};

export function ResultPanel({
  run,
  elapsed,
}: {
  run: Run | null;
  elapsed: number;
}) {
  const [tab, setTab] = useState<"result" | "json">("result");
  const [copyState, setCopyState] = useState("");
  const raw = run?.result ?? (run?.error ? { error: run.error } : null);
  const serialized = raw === null ? "" : JSON.stringify(raw, null, 2);
  const blocks = Array.isArray(run?.result?.content)
    ? (run.result.content as JsonObject[])
    : [];
  async function copy() {
    try {
      await navigator.clipboard.writeText(serialized);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState(""), 2000);
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([serialized], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${run?.toolName ?? "result"}-${run?.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="result-panel" aria-label="调用结果">
      <div className="panel-heading">
        <div className="panel-label">
          <Terminal size={17} />
          <h2>结果</h2>
        </div>
        <div className="icon-actions">
          <button
            className="icon-button"
            aria-label={copyState === "copied" ? "已复制" : "复制结果"}
            title={copyState === "failed" ? "复制失败，请下载结果" : "复制结果"}
            disabled={!serialized}
            onClick={() => void copy()}
          >
            {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            className="icon-button"
            aria-label="下载结果"
            title="下载结果"
            disabled={!serialized}
            onClick={download}
          >
            <Download size={16} />
          </button>
        </div>
      </div>
      {!run ? (
        <div className="result-empty">
          <div className="orbital-icon">
            <span />
            <Terminal size={28} strokeWidth={1.2} />
          </div>
          <h3>等待一次调用</h3>
          <p>选择工具，运行后在这里查看结果。</p>
        </div>
      ) : (
        <>
          <div className="run-summary" role="status">
            <span className={`run-status ${run.status}`}>
              <i />
              {statusLabels[run.status]}
            </span>
            <span className="duration">
              {((run.durationMs ?? elapsed) / 1000).toFixed(2)} s
            </span>
          </div>
          {run.status === "running" && (
            <div className="running-result">
              <div className="signal-bars">
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
              <span>{run.progress?.message ?? "正在等待 MCP 响应"}</span>
              {run.progress?.total && (
                <progress
                  max={run.progress.total}
                  value={run.progress.progress}
                  aria-label="调用进度"
                />
              )}
            </div>
          )}
          {run.error && (
            <div className="result-error" role="alert">
              {run.error}
            </div>
          )}
          {raw && (
            <>
              <div className="result-tabs">
                <button
                  className={tab === "result" ? "active" : ""}
                  onClick={() => setTab("result")}
                >
                  结果
                </button>
                <button
                  className={tab === "json" ? "active" : ""}
                  onClick={() => setTab("json")}
                >
                  原始 JSON
                </button>
              </div>
              <div className="result-body">
                {tab === "json" ? (
                  <pre className="raw-result">
                    {serialized.slice(0, 1_048_576)}
                    {serialized.length > 1_048_576
                      ? "\n… 预览已截断，请下载完整结果。"
                      : ""}
                  </pre>
                ) : (
                  <>
                    {blocks.map((block, index) => (
                      <div className="content-block" key={index}>
                        <ContentBlock block={block} />
                      </div>
                    ))}
                    {run.result?.structuredContent !== undefined && (
                      <details
                        className="structured-result"
                        open={!blocks.length}
                      >
                        <summary>结构化数据</summary>
                        <JsonTree value={run.result.structuredContent} />
                      </details>
                    )}
                    {!blocks.length &&
                      run.result?.structuredContent === undefined && (
                        <JsonTree value={raw} />
                      )}
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
