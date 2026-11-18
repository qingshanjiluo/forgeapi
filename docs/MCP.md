# MCP 接入指南

ForgeAPI 的每个插件都是一个 MCP 工具。外部 AI（Claude Code / Cursor / Cline / 自建 Agent）挂上 MCP 服务端后，就能直接调用本地封装好的网页与服务。

## 启动

```bash
forge mcp                                  # 暴露全部启用插件（stdio）
forge mcp --only weather,rss,search-aggregate   # 只暴露指定插件
forge mcp --flat                           # 不把子命令暴露成独立工具
forge mcp --list                           # 只打印工具表（JSON），便于排查
```

## 客户端配置

### Claude Code（`~/.claude.json` 或项目 `.mcp.json`）

```json
{
  "mcpServers": {
    "forgeapi": {
      "command": "node",
      "args": ["G:/皮皮/编程项目/forgeapi/dist/mcp/index.js"],
      "env": { "FORGE_HOME": "C:/Users/<you>/.forgeapi" }
    }
  }
}
```

### Cursor（`.cursor/mcp.json`）

```json
{
  "mcpServers": {
    "forgeapi": {
      "command": "node",
      "args": ["G:/皮皮/编程项目/forgeapi/dist/mcp/index.js"]
    }
  }
}
```

全局安装后可直接用 `forge`：

```json
{ "mcpServers": { "forgeapi": { "command": "forge", "args": ["mcp"] } } }
```

## 协议行为

| 方法 | 行为 |
| --- | --- |
| `initialize` | 返回 `protocolVersion: 2024-11-05`、`serverInfo`、`capabilities`（tools + resources + prompts），附一段使用说明 |
| `notifications/initialized` | 不返回（通知无 id） |
| `ping` | `{}` |
| `tools/list` | 每个启用插件一个工具；每个子命令一个 `<plugin>__<sub>` 工具 |
| `tools/call` | 执行插件，返回 `content[0].text` = 结果 JSON，`isError` 标记失败 |
| `resources/list` | 每插件的 skill / manifest / 规则资源 |
| `resources/templates/list` | URI 模板（`forge://plugin/{plugin}/skill` 等） |
| `resources/read` | 读资源正文（见下节） |
| `prompts/list` | 4 个工作流模板 |
| `prompts/get` | 渲染 prompt（参数填进文本） |
| 未知方法 | `-32601` |
| 未知工具 / 资源 / prompt | `-32602` |

## 资源（AI 可读文档）

| URI | 内容 | MIME |
| --- | --- | --- |
| `forge://plugin/<name>/skill` | 插件 skill.md；磁盘没有时按 schema **即时生成** | `text/markdown` |
| `forge://plugin/<name>/manifest` | 声明式插件的 `plugin.json` | `application/json` |
| `forge://plugin/<name>/rules/<rule>` | 提取规则 YAML | `application/yaml` |

```json
// resources/read 请求
{ "jsonrpc": "2.0", "id": 3, "method": "resources/read",
  "params": { "uri": "forge://plugin/weather/skill" } }

// 响应
{ "result": { "contents": [{ "uri": "...", "mimeType": "text/markdown", "text": "# weather v0.1.0\n..." }] } }
```

好处：AI 先读 skill 再调工具，参数不会猜错。

## 提示模板（工作流）

| name | 参数 | 作用 |
| --- | --- | --- |
| `webpage_extract` | `url`（必填）、`fields` | 读网页 skill → 调 `forge_webpage` → 缺字段时写规则重跑 → 整理输出 |
| `search_multi` | `query`（必填）、`limit` | 调 `forge_search-aggregate` 三源合并，按 score 整理 |
| `news_brief` | `keyword`、`limit` | 调 `forge_news-digest`，输出「时间 \| 来源 \| 标题 \| 链接」简报 |
| `data_service` | `service`（必填）、`params`（必填） | 调 weather / exchange-rate / translate / wiki-summary，出错先读该插件 skill |

```json
{ "jsonrpc": "2.0", "id": 6, "method": "prompts/get",
  "params": { "name": "search_multi", "arguments": { "query": "rust async", "limit": "5" } } }
```

工具名规则：非 `[A-Za-z0-9_-]` 字符替换为 `_`，截断 64 字符。
`inputSchema` = 插件 schema 归一化（强制 `type: object` + `additionalProperties: false`）。

## 工具表示例

```json
[
  {
    "name": "weather",
    "description": "天气：城市名或经纬度查询当前天气与多日预报（Open-Meteo，免密钥）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "city": { "type": "string", "description": "城市名（中文/英文）" },
        "lat": { "type": "number", "description": "纬度" },
        "lon": { "type": "number", "description": "经度" },
        "days": { "type": "integer", "description": "预报天数 1-16", "default": 3 }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "weather__geocode",
    "description": "只做地理编码，返回候选城市列表（插件 weather 的子命令）",
    "inputSchema": { "type": "object", "properties": { "city": { "type": "string" }, "count": { "type": "integer" } }, "additionalProperties": false }
  }
]
```

## 调用结果

成功：

```json
{
  "content": [{ "type": "text", "text": "{\"ok\":true,\"data\":{...},\"ms\":1234}" }],
  "isError": false
}
```

失败（插件返回 `ok:false` 或抛错）：

```json
{
  "content": [{ "type": "text", "text": "{\"ok\":false,\"error\":\"Chromium 启动失败…\"}" }],
  "isError": true
}
```

调用同时写入 `~/.forgeapi/logs/*.jsonl`，可用 `forge log --plugin <name>` 回看。

## 性能

服务端常驻，Chromium 进程按配置复用（`reuseBrowser: true`）：
首次网页工具调用约 3~7s，后续同类调用约 0.7s。
浏览器空闲 60s 自动关闭（`FORGE_BROWSER_IDLE_MS` 可调，0 = 不自动关）。

## 排障

| 现象 | 原因 / 处置 |
| --- | --- |
| 客户端看不到工具 | `forge mcp --list` 先确认工具表；检查 `FORGE_HOME` 是否指向装了插件的工作区 |
| 调用返回 "插件已禁用" | `forge enable <plugin>` |
| 网页类工具报 Chromium 缺失 | `npx playwright install chromium` |
| 工具数比预期少 | 代码型插件缺依赖时会被跳过，stderr 有 `跳过插件 X: …`；进该插件目录 `npm install` |
| 客户端收不到响应 | 协议走 stdout，任何 print 到 stdout 的插件都会污染流；插件里用 `ctx.log`（走 stderr） |

## 与 CLI 的关系

MCP 服务端与 CLI 共用同一个 `FORGE_HOME`、同一套插件注册表、同一份调用日志。
CLI 是一次性进程（执行完关浏览器），MCP 是常驻进程（复用浏览器）。
两者都可以同时跑，注册表变更（安装/启停）对已启动的 MCP 需要重启进程或等下次 `tools/call` 触发重建。

## 与 HTTP API 的关系

同一套能力有三种入口：

| 入口 | 适合 | 形态 |
| --- | --- | --- |
| CLI | 人 / 脚本 / cron | `forge run`、`forge pipeline` |
| MCP | AI 客户端（Claude Code / Cursor） | stdio JSON-RPC |
| HTTP | 其他服务 / 前端 / 非 AI 程序 | REST + OpenAPI |

HTTP 侧端点：`/api/plugins`、`/api/run`、`/api/pipeline`、`/api/logs`、`/api/config`、`/api/templates`、`/api/vault/keys`。
描述文件：`GET /api/openapi.json`（OpenAPI 3.0.3，`paths` 含全部端点，`enum` 预填当前已装插件名）。