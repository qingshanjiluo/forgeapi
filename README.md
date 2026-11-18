# ForgeAPI · 锻炉

> 把网页、公开服务、第三方来源，锻造成 AI 能直接调用的统一接口。

[![CI](https://github.com/qingshanjiluo/forgeapi/actions/workflows/ci.yml/badge.svg)](https://github.com/qingshanjiluo/forgeapi/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

本地 CLI，把「没有 API 的东西」和「散落各处的 API」封装成结构化 JSON。
不内置 AI——通过 **CLI + 插件 + Skill 文档 + MCP**，让 Claude Code / Cursor / 自建 Agent 直接调用。

```bash
forge run search-aggregate -p '{"query":"rust async","limit":5}'
forge run webpage --params-file p.json
forge pipeline examples/search-read.yaml -p 'query=rust'
forge mcp                      # 挂到 AI 客户端
```

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [30 秒上手](#30-秒上手)
- [13 个内置插件](#13-个内置插件)
- [9 个模板](#9-个模板)
- [数据获取方式（五种通道）](#数据获取方式五种通道)
- [CLI 全命令](#cli-全命令)
- [插件开发](#插件开发)
- [工作流编排](#工作流编排)
- [AI 接入：MCP / Skill / HTTP](#ai-接入mcp--skill--http)
- [脚本与自动化](#脚本与自动化)
- [安全模型](#安全模型)
- [架构](#架构)
- [开发与验证](#开发与验证)

---

## 它解决什么问题

AI 要拿数据，通常三条路都不顺：

| 现状 | 问题 |
| --- | --- |
| 目标站没有 API | AI 只能看到 HTML，不敢解析、容易解析错 |
| 有 API 但散落各处 | 每个都要单独写鉴权、参数映射、错误处理 |
| 需要登录/多步骤 | AI 无法维持会话，拿不到数据 |

ForgeAPI 把这些都收进一个本地 CLI：

- **没有 API 的页面** → 用无头浏览器按规则提取（CSS / XPath / 正则 / JSONPath）
- **散落的 API** → 统一成 `{ok, data, error, meta, ms}`，一个调用形态
- **需要登录的站** → 声明式多步会话（goto/fill/click/wait/cookie），登录态落盘复用
- **多个来源** → 聚合成一个结果集（去重、合并来源、按分数排序）

并且把「怎么调」写成三种机器可读的形态：**JSON Schema**（参数）、**Skill Markdown**（说明）、**MCP tools**（直接调用）。

---

## 30 秒上手

```bash
# 1) 装依赖
npm install
npx playwright install chromium     # 网页类插件需要

# 2) 编译 + 初始化（装内置插件、播种模板）
npm run build
node dist/cli/index.js init

# 3) 试一把
node dist/cli/index.js run weather -p '{"city":"上海","days":2}'
```

可选用 `npm link` 后直接敲 `forge`：

```bash
npm link
forge doctor                          # 环境自检
forge list                            # 13 个内置插件
```

工作区默认在 `~/.forgeapi`，可用 `FORGE_HOME` 覆盖：

```
~/.forgeapi/
├── config.json            全局配置
├── plugins.json           插件注册表（含内容基线哈希）
├── credentials.json       加密凭据（AES-256-GCM）
├── schedules.json         调度条目
├── keys/                  Ed25519 签名密钥
├── plugins/<name>/        插件
├── templates/             模板库 + index.json + registry.json
├── pipelines/             工作流
├── data/<name>/           插件私有数据（config / cookies / rules / snapshots / shots / pdfs）
└── logs/YYYY-MM-DD.jsonl  调用日志
```

---

## 13 个内置插件

`forge init` 后即可用。全部**免密钥**，除 GitHub 有未认证限流。

| 插件 | 用途 | 关键参数 | 通道 |
| --- | --- | --- | --- |
| `webpage` | 任意网页按规则抽字段 | `url`, `rule`, `root`, `waitFor` | 浏览器 |
| `blog-list` | 列表页批量抓条目（翻页/懒加载） | `url`, `limit`, `pages`, `item`, `title` | 浏览器 |
| `search-aggregate` | HN/Wiki/GitHub 多源并发去重 | `query`, `sources`, `limit` | HTTP |
| `hn-search` | Hacker News 搜索 | `query`, `tags`, `limit` | HTTP |
| `rss` | RSS/Atom 解析（单/多 feed） | `url` 或 `urls[]`, `limit` | HTTP |
| `github-repo` | 仓库信息/Issue/搜索/README/Release/目录树 | `repo`, `action`, `query` | HTTP |
| `forum` | 论坛登录→板块→列表→详情 | `base`, `action`, `board`, `topic` | 浏览器+会话 |
| `weather` | 天气（Open-Meteo） | `city` 或 `lat`+`lon`, `days` | HTTP |
| `http-api` | 通用 HTTP/JSON 封装 | `endpoint`, `method`, `query`, `body`, `jsonpath` | HTTP |
| `screenshot` | 网页截图（整页/元素/base64） | `url`, `selector`, `fullPage`, `output`, `type` | 浏览器 |
| `pdf` | 网页转 PDF | `url`, `format`, `landscape`, `margin`, `pageRanges` | 浏览器 |
| `page-meta` | 页面画像（OG/Twitter/JSON-LD/标题层级/订阅源） | `url`, `includeJsonLd` | 浏览器 |
| `sitemap` | 站点地图解析与 URL 发现（index/gzip/纯文本） | `url`, `limit`, `since`, `prefix`, `pattern` | HTTP |

每个插件都带 `skill.md`，`forge skill <name>` 可读，MCP 里是 `forge://plugin/<name>/skill` 资源。

### 单个例子

```bash
# 页面画像：先搞清楚这页是什么
forge run page-meta -p '{"url":"https://github.com"}'
# → title / description / og.* / jsonLd / headings / counts / feeds / hreflang

# 站点地图发现：一次拿到全站 URL
forge run sitemap -p '{"url":"https://www.sitemaps.org","limit":20,"since":"2022-01-01"}'
# → urls[] 按 lastmod 倒序 + sitemaps 报告

# 截图存证
forge run screenshot -p '{"url":"https://example.com","fullPage":false}'
# → file: ~/.forgeapi/data/screenshot/shots/....png

# 网页转 PDF（页脚带页码）
forge run pdf --params-file p.json
# p.json: {"url":"...","format":"A4","displayHeaderFooter":true,
#          "footerTemplate":"<div style=\"font-size:9px;text-align:center\"><span class=pageNumber></span>/<span class=totalPages></span></div>"}
```

---

## 9 个模板

模板是「零代码插件」——用 `plugin.json` 声明来源与合并策略，装完就能跑。

```bash
forge template list                # 本地模板
forge template remote              # 远端索引
forge template install translate   # 装一个
forge template export my-plugin    # 把自己的插件导出成模板
```

| 模板 | 用途 | 关键参数 |
| --- | --- | --- |
| `exchange-rate` | 汇率（ECB/Frankfurter） | `from`, `to`, `amount` |
| `translate` | 翻译（Google + MyMemory 双源兜底） | `text`, `from`, `to` |
| `wiki-summary` | 维基词条摘要 | `title`, `lang`, `sentences` |
| `news-digest` | 多源新闻聚合 + 关键词过滤 + 去重 | `keyword`, `limit`, `feeds` |
| `price-compare` | 比价骨架（站点配置驱动） | `query`, `sites`, `demos` |
| `github-trending` | GitHub 趋势榜 | `language`, `since`, `limit` |
| `demo-hn` | HN 头条（声明式聚合示例） | `limit` |
| `demo-forum-pack` | 论坛登录流（声明式 flow 示例） | `base` |
| `demo-weather-service` | 公开服务包装示例 | `lat`, `lon`, `days` |

**模板装完即插件**，`forge list` 里能看到，MCP 里自动变成工具。

---

## 数据获取方式（五种通道）

### 1. 直连 HTTP / JSON

最轻，无浏览器。

```bash
forge run http-api -p '{"endpoint":"https://api.github.com/users/octocat"}'
forge run http-api -p '{"endpoint":"https://api.x.com/list","jsonpath":"$.data.items"}'
```

响应自动识别常见包装键：`data` / `results` / `items` / `list` / `hits` / `records` / `rows`。

### 2. 无头浏览器提取

Playwright，支持 CSS / XPath / JSONPath / 正则四种选择器。

```bash
forge run webpage -p '{"url":"https://example.com"}'

# 自定义规则
forge rule webpage shop --set 'fields:
  - {name: 标题, selector: "h1.product-title"}
  - {name: 价格, selector: ".price", type: number}
  - {name: 评论, selector: ".review-item", type: list, limit: 20, fields: [
      {name: 用户, selector: ".user-name"},
      {name: 内容, selector: ".review-content"}]}'
forge run webpage -p '{"url":"https://shop/x","rule":"shop"}'
```

规则字段：

| 键 | 可选值 |
| --- | --- |
| `selector` | CSS / `//xpath` / `$.jsonpath` / `re:regex` |
| `type` | `text` `html` `attr` `url` `list` `number` `bool` |
| `transform` | `trim` `lower` `upper` `number` `json` |
| `optional` | 缺失时不写 null，直接跳过该字段 |
| `limit` | list 最多几条 |

### 3. 完整会话（登录 / 多步）

```yaml
steps:
  - { action: goto, url: "https://forum.example.com/login" }
  - { action: fill, selector: "#user", value: "${cred:USERNAME}" }
  - { action: fill, selector: "#pass", value: "${cred:PASSWORD}" }
  - { action: click, selector: "button[type=submit]" }
  - { action: waitFor, selector: ".dashboard" }
  - { action: cookie-save }
  - { action: goto, url: "https://forum.example.com/b/general" }
  - { action: extract, key: "topics", fields: [{ name: t, selector: ".topic-title" }] }
```

14 种动作：`goto` `fill` `type` `click` `press` `wait` `waitFor` `scroll` `eval` `extract` `screenshot` `cookie-save` `cookie-load` `sleep`。

`forum` 插件已内置这套流程（login / boards / list / detail / me 五个 action，选择器可通过 `forge cfg forum --set` 覆盖）。

### 4. 多来源聚合

```bash
forge run search-aggregate -p '{"query":"AI 绘画","sources":"hn,wiki,github","limit":10}'
```

```json
{
  "ok": true,
  "data": {
    "query": "AI 绘画",
    "results": [{ "title": "...", "url": "...", "score": 320, "来源": "hn,github" }],
    "total": 24,
    "sources": [{ "name": "hn", "count": 10 }, { "name": "wiki", "count": 8 }]
  }
}
```

合并策略：`concat` / `dedupe_by_title` / `dedupe_by_key` / `first_nonempty`。
来源并发（默认 3，可配 `concurrency`），失败隔离（单源失败不中断，记 `sources[].error`）。

### 5. 文件产物（截图 / PDF）

```bash
forge run screenshot -p '{"url":"U","output":"base64"}'   # 直接给 AI 看图
forge run screenshot -p '{"url":"U","fullPage":true}'     # 存盘返回路径
forge run pdf -p '{"url":"U","format":"A3","landscape":true}'
```

产物落 `~/.forgeapi/data/<plugin>/`，返回绝对路径。

---

## CLI 全命令

```
run         执行插件（子命令直达：forge <plugin> <sub>）
pipeline    执行声明式工作流
batch       批量执行任务文件（JSON/JSONL）
list        列出插件
info        插件详情
schema      参数 Schema（JSON）
skill       Skill 文档（Markdown）
install     装插件（目录/tgz/URL/GitHub 仓库，自动装依赖）
remove      卸载
enable / disable
log         调用日志
watch       抓取 + 与快照 diff
verify      完整性校验（对比基线哈希，--fix 重建）
keygen      生成 Ed25519 密钥
sign        对插件签名（--list 看状态，--export-pub 导出公钥）
trust       可信公钥：import / list / verify
schedule    内置调度：list/add/remove/enable/disable/run/daemon
template    模板：list / search / install / export / remote / add
cfg         插件私有配置
rule        提取规则读写
config      全局配置 / 凭据库
mcp         MCP 服务端（stdio）
serve       Web 控制台 + REST API
init        初始化工作区
doctor      环境自检
```

### 参数传法（三种）

```bash
forge run weather -p '{"city":"上海"}'              # 内联 JSON
forge run weather -p 'city=上海,days=3'            # k=v 简写
forge run weather --params-file p.json             # 文件（Windows 推荐）
```

`--params-file` 会剥 BOM，PowerShell `Set-Content` 写的文件也能读。

### 输出约定

**stdout 只有结果 JSON**，日志全部走 stderr：

```json
{ "ok": true, "data": { ... }, "error": null, "meta": null, "ms": 1234 }
```

失败时 `ok: false`，`error` 有原因，退出码 1。

### 流式输出

大批量抓取用 `--stream`，边收边处理：

```bash
forge run blog-list --stream --params-file p.json | jq -c 'select(.type=="item")'
# {"type":"meta","count":50}
# {"type":"item","value":{...}}
# {"type":"end","count":50}
```

`pipeline` / `batch` 也支持 `--stream`（`pipeline-start` / `step` / `pipeline-end` / `output`）。

---

## 插件开发

### 三种形态

| 形态 | 文件 | 适合 |
| --- | --- | --- |
| 声明式 | `plugin.json` / `plugin.yaml` | 纯配置：单页提取、多源聚合、多步会话 |
| 代码型 | `index.mjs` / `.js` / `.ts` | 任意逻辑（`.ts` 走 Node 原生 type-stripping，无需预编译） |
| 内联代码源 | `sources[].type: "code"` | 声明式里嵌一段 JS，无需单独文件 |

### 最小代码型插件

```js
// my-plugin/index.mjs
export default {
  name: 'my-plugin',
  version: '0.1.0',
  description: '一句话说清',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: { q: { type: 'string', description: '查询词' } },
    required: ['q'],
  },
  async execute(params, ctx) {
    ctx.progress('开始查询');
    const r = await fetch(`https://api.example.com/s?q=${encodeURIComponent(params.q)}`);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  },
  commands: [
    {
      name: 'sub',
      description: '子命令',
      schema: { type: 'object', properties: {} },
      async handler(p, ctx) { return { ok: true, data: { sub: true } }; },
    },
  ],
};
```

```bash
forge install ./my-plugin      # 自动装 npm 依赖（有 package.json 时）
forge run my-plugin -p '{"q":"test"}'
forge skill my-plugin --write ./my-plugin/skill.md
```

### ctx API

| 成员 | 说明 |
| --- | --- |
| `ctx.browser` | Playwright 封装：`page()` / `runSteps()` / `fetchExtract()` / `saveCookies()` |
| `ctx.getCredential(key)` | 读本插件凭据（AES-256-GCM，按插件隔离） |
| `ctx.setCredential(key, val)` | 写凭据（需已解锁） |
| `ctx.log(level, msg)` | `info` / `warn` / `error` / `debug`（走 stderr） |
| `ctx.progress(msg)` | 实时进度（CLI stderr / Web 调试面板） |
| `ctx.dataDir` | 本插件私有目录 |
| `ctx.config` | 全局配置只读副本 |

### 声明式插件

```json
{
  "name": "agg",
  "version": "0.1.0",
  "description": "多源聚合",
  "type": "aggregate",
  "permissions": ["net"],
  "schema": { "type": "object", "properties": { "query": { "type": "string" } } },
  "sources": [
    { "name": "a", "type": "api", "url": "https://a/api", "params": { "q": "${query}" }, "jsonpath": "$.items" },
    { "name": "b", "type": "webpage", "url": "https://b/s?q=${query}", "rule": "list-rule" },
    { "name": "c", "type": "code", "code": "return [{title: 'x' + params.query}];" }
  ],
  "merge": { "strategy": "dedupe_by_title", "fields": ["title", "url"], "limit": 30 }
}
```

`type` 三选一：`extract`（单页）/ `aggregate`（多源）/ `flow`（多步）。

### 权限声明

`net` / `browser` / `fs-read` / `fs-write` / `credential` / `exec`。
安装时逐项确认（`--yes` 跳过）。

---

## 工作流编排

把多个插件串成一条管线：上一步输出直接喂下一步。

```yaml
# examples/search-read.yaml
name: search-then-read
onError: continue
input: { query: rust, limit: 3 }
steps:
  - id: search
    plugin: search-aggregate
    params: { query: "${input.query}", limit: 5, sources: "hn,wiki" }
  - id: detail
    plugin: webpage
    forEach: "${steps.search.data.results}"     # 循环
    limit: 3
    concurrency: 2
    onError: continue
    pick: "title"                                # 只留 title 字段
    params: { url: "${item.url}" }
output:
  query: "${input.query}"
  total: "${steps.search.data.total}"
  pages: "${steps.detail.items}"
```

```bash
forge pipeline examples/search-read.yaml -p 'query=rust async'
forge pipeline pl.yaml --dry-run        # 只打计划
forge pipeline pl.yaml --stream         # NDJSON 进度
```

变量：`${input.x}` / `${steps.<id>.data...}` / `${item.x}` / `${index}` / `${env:NAME}` / `${cred:KEY}`
纯引用保留原始类型（对象/数组直传），支持数组索引 `${steps.rate.data.results[0].rates.CNY}`。

失败策略：`abort`（默认，中止）/ `continue`（继续后续），步骤级可覆盖。

---

## AI 接入：MCP / Skill / HTTP

同一套能力，三种入口：

| 入口 | 适合 | 形态 |
| --- | --- | --- |
| CLI | 人 / 脚本 / cron | `forge run` / `pipeline` / `batch` |
| **MCP** | Claude Code / Cursor / Cline | stdio JSON-RPC |
| HTTP | 其他服务 / 前端 / 非 AI 程序 | REST + OpenAPI |

### MCP（推荐）

```bash
forge mcp                                   # 全部启用插件
forge mcp --only weather,rss --flat         # 只暴露两个，不展开子命令
forge mcp --list                            # 只打工具表
```

客户端配置：

```json
{
  "mcpServers": {
    "forgeapi": { "command": "forge", "args": ["mcp"] }
  }
}
```

三套能力：

**tools** —— 每个插件一个工具，每个子命令一个 `<plugin>__<sub>`：

```
tools/list → [ { name: "weather", description: "...", inputSchema: {...} } ]
tools/call → { content: [{ type: "text", text: "{\"ok\":true,\"data\":{...}}" }], isError: false }
```

**resources** —— 让 AI 读文档再动手：

| URI | 内容 |
| --- | --- |
| `forge://plugin/<name>/skill` | skill.md（无文件时按 schema 即时生成） |
| `forge://plugin/<name>/manifest` | 声明式 `plugin.json` |
| `forge://plugin/<name>/rules/<rule>` | 提取规则 YAML |

**prompts** —— 4 个现成工作流：`webpage_extract` / `search_multi` / `news_brief` / `data_service`

详细协议见 [docs/MCP.md](docs/MCP.md)。

### Skill

仓库内 `skills/forgeapi/SKILL.md` 是一份可直接安装的 skill：

```bash
# 安装到 DSH
cp -r skills/forgeapi ~/.dsh/skills/forgeapi

# 或给 Claude Code
cp -r skills/forgeapi ~/.claude/skills/forgeapi
```

装好后 AI 在这类任务会自动加载它：抓网页字段、多源搜索、RSS、GitHub、论坛会话、天气汇率、截图 PDF、站点地图、数据管线。

### HTTP API

```bash
forge serve                 # http://127.0.0.1:7842
curl http://127.0.0.1:7842/api/openapi.json   # OpenAPI 3.0.3
```

| 端点 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/plugins` | 插件列表 |
| `GET /api/plugins/:name` | 详情（schema/skill/config/rules） |
| `GET /api/plugins/:name/schema` | 参数 Schema |
| `GET /api/plugins/:name/skill` | Skill Markdown |
| `GET/PUT /api/plugins/:name/config` | 私有配置 |
| `GET/POST /api/plugins/:name/rules` | 提取规则 |
| `POST /api/plugins/install` | 安装 |
| `POST /api/run` | 执行插件（带实时 logs） |
| `POST /api/pipeline` | 执行工作流（inline def 或 file） |
| `GET /api/pipeline/list` | 工作区工作流 |
| `GET /api/logs` | 调用日志 |
| `GET/PUT /api/config` | 全局配置 |
| `GET /api/vault/keys` | 凭据键名（不返回值） |
| `GET /api/templates` | 模板列表/搜索 |
| `GET /api/openapi.json` | OpenAPI 描述 |

Web 控制台七个页签：插件 / 调试 / 规则 / 日志 / 配置 / 模板 / 工作流。

---

## 脚本与自动化

### 批量任务

```bash
# tasks.jsonl（每行一个任务；# 开头为注释）
{"id":"w1","plugin":"weather","params":{"lat":31.23,"lon":121.47}}
{"id":"r1","plugin":"exchange-rate","params":{"from":"USD","to":"CNY"}}

forge batch tasks.jsonl -c 4 -r 3 --rate 5     # 并发4、最多3次、5个/秒
forge batch tasks.jsonl --stream               # NDJSON 进度与结果
forge batch tasks.jsonl --out results.jsonl    # 落盘
```

语义保证：结果顺序 = 任务文件顺序；失败记 `index/plugin/id/error`；限速在并发下仍有效。

### 变化监控

```bash
forge watch hn-search demo -p 'query=rust,limit=3'   # 建基线
forge watch hn-search demo -p 'query=rust,limit=5'   # 出差异
# 对比 demo：3 → 5 条
# 新增 2，删除 0，变更 0，未变 3
forge watch hn-search demo --reset                    # 清快照
```

对齐键自动识别 `url`/`link`/`id`/`title`，可 `--key` 指定、`--fields` 缩小比较面。

### 定时调度

```bash
forge schedule add weather --name hourly --cron "0 * * * *" -p 'city=上海'
forge schedule add --kind pipeline --name daily --cron "0 8 * * *" --file pl.yaml
forge schedule add --kind batch --name b1 --every 1800 --file tasks.jsonl
forge schedule list
forge schedule run hourly        # 立即执行一次
forge schedule daemon            # 常驻（--once 单轮，适合外部计划任务）
```

cron 支持 `*` / 区间 / 步长 / 列表；日与周都受限时取「或」（标准语义）。

### 测试脚本

```bash
npm test          # 152 个单元测试
npm run selftest  # 122 项端到端自验（真实网络 + 真实浏览器）
npm run bench     # 浏览器池复用基准
```

---

## 安全模型

### 凭据

AES-256-GCM + scrypt（N=16384,r=8,p=1），按 `plugin:key` 命名空间隔离：

```bash
forge config --vault init --password P
forge config --vault set --plugin forum --key USERNAME --value u --password P
forge config --vault lock
```

插件只能读到自己命名空间的键（实测跨插件读取返回 null）。

### 内容完整性

安装即记录目录内容哈希 + 逐文件摘要：

```bash
forge verify weather
# [FAIL] weather  内容与基线不一致
#        基线 43201aa1...  实际 df6b05d1...
#        - index.mjs（内容变更）
forge verify weather --fix     # 有意改动后重建基线
```

### 来源可信（Ed25519）

```bash
forge keygen --signer "publisher"
forge sign my-plugin
forge sign --export-pub ./publisher.pub

# 使用方
forge trust import ./publisher.pub
forge trust verify my-plugin
```

四种结果：`signed` / `digest-mismatch`（内容改过）/ `signed-invalid`（keyId 不匹配或签名伪造）/ `unsigned`。

`verify` 防同机静默改动（无密钥），`trust verify` 证来源可信（有密钥，可跨机）。

### 权限

插件声明 `net` / `browser` / `fs-read` / `fs-write` / `credential` / `exec`，安装时确认。

---

## 架构

```
CLI (src/cli)              commander 命令表、argv 重写、参数解析
├─ bootstrap.ts            init：内置插件安装 + 模板播种

核心 (src/core) 21 模块
├─ engine.ts               插件加载 + 上下文注入 + 声明式执行
├─ browser.ts              Playwright 封装（14 动作、双提取通道）
├─ browserpool.ts          Chromium 进程池（复用、代理绕过 loopback、空闲回收）
├─ extract.ts              CSS/JSONPath/正则 + 变量插值
├─ aggregate.ts            4 种合并策略
├─ pipeline.ts             工作流编排（变量/forEach/when/pick/onError）
├─ scheduler.ts            批量调度（并发/重试/限速/超时/落盘）
├─ schedule.ts             cron 解析 + 调度条目
├─ concurrency.ts          mapLimit + ResultCache
├─ integrity.ts            内容哈希与基线
├─ signing.ts              Ed25519 签名验签 + 可信公钥
├─ credentials.ts          AES-256-GCM 凭据库
├─ registry.ts             插件注册表 + 目录探测
├─ installer.ts            安装（目录/tgz/URL/仓库）+ 依赖自动装
├─ templates.ts            模板库 + 远端索引
├─ calllog.ts              JSONL 调用日志
├─ skillgen.ts             插件 → Skill Markdown
└─ types.ts / workspace.ts / log.ts / diff.ts / version.ts

MCP (src/mcp)              JSON-RPC 2.0：tools / resources / prompts
Server (src/server)        REST + OpenAPI + 内嵌 Web 控制台
plugins/builtin            13 个内置插件
templates                  9 个模板 + registry.json
examples                   3 个工作流示例
skills/forgeapi            可分发的 Skill 包
```

分层与决策细节见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 开发与验证

```bash
npm run build      # tsc
npm run dev        # tsc --watch
npm test           # 单元测试（154）
npm run selftest   # 端到端自验（122 项）
```

当前状态：

```
单元测试   154 个（8 文件）
自验       122 项断言，全部 PASS
覆盖       提取器 / 聚合器 / 凭据 / 注册表 / 引擎 / MCP / 并发 / 调度
           / 完整性 / diff / 签名 / pipeline / 批量 / 新四插件
```

自验跑真实的网络与真实浏览器，覆盖：13 插件执行、模板安装、凭据加密与隔离、
MCP 协议六环节、批量汇总、完整性篡改检测、伪造签名识别、cron 解析、
工作流执行与条件跳过、浏览器池加速、截图/PDF/页面画像/站点地图。

### 已知边界

| 项 | 说明 |
| --- | --- |
| Chromium | 网页类需 `npx playwright install chromium`；缺失时报错并给安装命令 |
| GitHub 限流 | 未认证 60 次/小时；`forge github-repo set-token` 提升到 5000 |
| HTML 字符串级 XPath | 不支持（cheerio 无 XPath）；页面级 XPath 走真实 DOM |
| zip 安装 | 不支持；用 `.tgz` 或 GitHub 仓库地址 |
| 签名信任 | TOFU（首次导入决定），无 CA 体系 |
| 模板「市场」 | 本地目录 + 远端索引语义，无中心化服务 |

---

## 文档

| 文件 | 内容 |
| --- | --- |
| **[docs/DATA-COOKBOOK.md](docs/DATA-COOKBOOK.md)** | **数据获取手册：按「我要什么」查，照着敲** |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、模块职责、关键决策 |
| [docs/PLUGIN-AUTHORING.md](docs/PLUGIN-AUTHORING.md) | 三种入口、ctx API、规则语法、调试 |
| [docs/MCP.md](docs/MCP.md) | MCP 协议、resources、prompts、客户端配置 |
| [docs/PIPELINE.md](docs/PIPELINE.md) | 工作流变量、循环、条件、失败策略 |
| [docs/BATCH-VERIFY-WATCH.md](docs/BATCH-VERIFY-WATCH.md) | 批量、完整性校验、diff 监控 |
| [docs/SIGNING-AND-SCHEDULE.md](docs/SIGNING-AND-SCHEDULE.md) | Ed25519 签名、可信公钥、cron 调度 |
| [docs/AI-SKILL.md](docs/AI-SKILL.md) | 给 AI 的速查入口 |
| [skills/forgeapi/SKILL.md](skills/forgeapi/SKILL.md) | 可分发的 Skill 包（可直接安装） |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → 0.7.0 全量变更 |

---

## 许可

MIT