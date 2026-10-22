# MCP / LAB

一个简洁的本地 MCP 网页客户端。React 页面负责选择工具和展示结果，Node.js 通过官方 SDK 连接远程 MCP 服务。

## 当前已实现

- **SSE / Streamable HTTP**：独立选择传输方式、连接、断开、重新连接。
- **多服务管理**：添加、编辑、删除和切换服务，配置保存到本机，重启后继续使用。
- **指定工具调用**：发现全部分页工具，按名称搜索并选择，每个服务分别记住所选工具和参数草稿。
- **参数输入**：表单和 JSON 双模式；JSON 支持按钮、失焦与 `⌘/Ctrl + Shift + F` 格式化，发送前前后端均校验。
- **结果展示**：文本、结构化 JSON、图片、音频、嵌入资源，以及完整结果 JSON 的复制和下载。
- **运行状态**：区分成功、工具错误、协议错误、超时和停止等待；显示耗时和服务端进度。
- **基础认证**：Bearer Token 和自定义 Headers；SSE 的 GET 和 POST 均携带配置的认证。
- **本地演示**：开发模式提供真实 MCP 演示端点，所有演示结果均来自协议调用。

界面采用浅色侧栏工作台，认证设置收进配置弹窗。当前已实现连接、工具调用、结果展示和多服务配置管理；stdio、资源／提示词浏览、OAuth、持久化历史及同时保持多个活跃连接尚未实现。

## 启动

要求 Node.js **26.12.1**，版本固定在 `.nvmrc`。项目没有修改系统 Node.js。

```bash
nvm install
nvm use
npm ci
npm run dev
```

访问 [http://127.0.0.1:5173](http://127.0.0.1:5173)。前端端口为 `5173`，Node.js 服务为 `3333`，默认均只监听本机。

如果当前机器没有 `nvm`，安装 `.nvmrc` 指定版本的 Node.js 后执行 `npm ci` 即可。本次开发安装的项目内运行时也可以使用：

```bash
PATH="$PWD/.runtime/node_modules/node/bin:$PATH" npm run dev
```

`.runtime/` 是被忽略的本机辅助目录，不属于项目交付依赖。

## 使用

1. 点击侧栏“添加服务”，填写名称、完整 MCP 地址和传输方式。
2. 需要认证时展开“认证与高级设置”，填写 Token 或 Header JSON；凭据随配置保存，Token 默认隐藏，可点击眼睛按钮显示／隐藏。
3. 点击“保存并连接”，搜索并选择指定工具，例如 `search` 或 `query_data`。
4. 填写参数，点击“运行工具”，右侧展示格式化后的结果。
5. 点击侧栏中的其他服务切换连接；通过服务旁的菜单或顶部“编辑”修改、删除配置。

刷新会恢复上次选择的服务、工具和参数草稿，必要时自动重连，但不会自动执行工具。最多保存 50 个服务；每个浏览器会话同时只有一个活跃连接。

SSE 地址通常形如 `https://example.com/sse`，Streamable HTTP 地址通常形如 `https://example.com/mcp`，实际路径由服务端决定。连接失败不会自动切换传输。

空白工作台中的“添加演示服务”会保存 HTTP 和 SSE 两个演示配置。也可手动添加下列真实演示端点：

| 端点 | 传输／返回形式 |
| --- | --- |
| `http://127.0.0.1:3333/demo/sse` | HTTP+SSE |
| `http://127.0.0.1:3333/demo/mcp` | Streamable HTTP，SSE 响应 |
| `http://127.0.0.1:3333/demo/json` | Streamable HTTP，JSON 响应 |

演示工具包括 `echo`、`calculate`、`inspect_payload`、`mixed_result`、`slow_task` 和 `fail`。例如选择 `calculate`，输入：

```json
{
  "numbers": [10, 20, 30],
  "operation": "average"
}
```

结果应为 `{"value":20}`。`fail` 用于检查工具错误，`slow_task` 用于检查进度与停止等待。

## 构建与运行产物

```bash
npm run build
npm start
```

访问 [http://127.0.0.1:3333](http://127.0.0.1:3333)。生产运行由 Node.js 同源提供页面和 API，默认不启用演示端点。

可用 `PORT=3335 npm start` 修改生产端口。开发模式的端口固定，避免前端代理与后端地址不一致。

## Docker 部署

```bash
docker compose up -d
```

访问 http://127.0.0.1:3333。镜像在阿里云 ACR 的 `lys1313013/mcp-client-demo` 仓库发布，提供 `latest` 和提交 SHA 标签，支持 `linux/amd64` 与 `linux/arm64`。

服务配置和凭据保存在命名数据卷 `mcp-client-data` 中，重建容器不会丢失；`docker compose down -v` 会删除该卷。镜像不包含本机 `.data`、凭据或演示服务数据。

默认仅发布到本机回环地址，应用未提供用户登录。远程服务器可使用 SSH 隧道访问：`ssh -L 3333:127.0.0.1:3333 user@server`。容器中的 `localhost` 指容器本身，连接宿主机 MCP 时使用适合该 Docker 环境的宿主机地址。

本地构建：`docker build -t mcp-client-demo:local .`。运行配置支持 `HOST`、`PORT` 和 `DATA_DIR`；Docker 默认监听容器内 `0.0.0.0:3333`，配置目录为 `/app/.data`。

GitHub Actions 在测试、构建成功后发布 ACR 镜像，需要仓库 Secrets：`ALIYUN_ACR_USERNAME`、`ALIYUN_ACR_PASSWORD`。沿用其他项目的 ACR 命名空间及关闭镜像证明清单的兼容设置。

## 验证

```bash
npm test
npm run build
```

集成测试启动真实监听 TCP 端口的 MCP 服务，再通过应用 API 连接和调用，覆盖：

- HTTP+SSE、Streamable HTTP 的 SSE 响应和 JSON 响应。
- 正确／错误认证、Header 传递、分页发现、按名称调用和结果内容断言。
- 无效参数与未知工具被本地拦截，`isError` 被正确识别为工具失败。
- 超时、取消、重复点击防护、会话隔离、凭据脱敏和本机 API 来源校验。
- 活跃 SSE 连接下的正常服务关闭，防止开发热重启被长连接阻塞。
- 多服务配置重启恢复、保存认证后真实调用、编辑冲突、凭据清除、删除持久化与文件损坏保护。
- JSON 文本格式化及非 JSON 文本保留。

浏览器已验证添加多个服务、切换 HTTP／SSE、按服务恢复工具与参数、刷新恢复，以及 JSON 格式化后调用 `calculate` 返回平均值 `4`。未使用用户的外部 MCP 地址或凭据进行验证。

## 兼容与当前边界

| 项目 | 已安装／验证版本 |
| --- | --- |
| Node.js | 26.12.1 |
| React | 19.3.1 |
| MCP TypeScript SDK | 1.32.1 |
| 本次实际协商并测试的 MCP 协议 | 2025-11-25 |

SDK 1.32.1 的支持列表还包含 `2025-06-18`、`2025-03-26`、`2024-11-05`、`2024-10-07`，但本次没有逐版本独立验收。需求中的 `2026-07-28` 支持仍待适配，不声称已经兼容。

- 服务配置及 Token、Headers 以明文 JSON 保存到 `.data/servers.json`，文件权限为 `0600`，目录已被 Git 忽略。眼睛按钮只控制页面显示，不对文件加密。
- 编辑时回填已保存凭据，Token 默认隐藏；清空字段后保存即可移除。列表 API 不回传凭据，编辑专用接口按需读取且禁止缓存。
- 单浏览器会话保留一个活跃连接和最后一次运行；Node.js 重启后页面会重新连接已保存的配置。各浏览器共享本机服务配置，这不是多用户系统。
- 浏览器 localStorage 仅记住服务 ID 和工具选择；参数草稿放在 sessionStorage，刷新保留，关闭标签页后不保证保留。调用结果无持久化历史；服务端返回的凭据值在展示前脱敏。
- 停止等待／超时不表示服务端已回滚；业务调用不会自动重试。
- 响应流累计上限为 20 MiB；对于旧式长驻 SSE 流，该限制累计到整条流，达到后需要重连。单次文本预览上限为 1 MiB，完整已接收结果可下载。
- 当前采用显式重连；OAuth、跨源 SSE 消息端点及 HTTP 重定向不在本阶段支持范围内。
- 未实现的客户端交互能力不向 MCP 服务端声明。输出不符合工具 Schema 时保留响应并标记错误。

## 代码结构

```text
src/                 React 工作台、参数编辑和结果组件
server/app.ts        本机 API、会话、MCP 连接与调用生命周期
server/profiles.ts   本机 JSON 配置存储
src/preferences.ts   服务／工具选择与参数草稿
server/demo.ts       真实 MCP 演示／集成测试服务
server/index.ts      服务启动和生产静态文件
shared/              前后端共享类型与 Schema 校验
tests/               实际传输集成测试
docs/                功能需求文档
```

完整规划见 [功能需求文档](docs/mcp-client-requirements.md)。
