# CHANGELOG

## 0.12.0

十二期：`ws` WebSocket 采集插件（18 → 19）。

### 新增插件

**`ws`** —— 连接 → 可选订阅 → 收 N 帧 → 输出
- 依赖 Node 22+ 内置 `WebSocket`（undici），零外部依赖
- `headers` 支持 `${cred:KEY}` 插值（Bearer 鉴权）
- `subscribe`：对象自动 JSON 序列化，数组依次发送
- 三种结束条件（谁先到算谁）：收满 `messages` / `duration` 到时 / `idleMs` 无新帧
- `parseJson` 解析 JSON 帧；`filter` 只留含关键词的帧；`binarySkip` 跳二进制
- 每帧带 `at` 时间戳，便于算间隔

补齐"AI 无法直接触及"的一条通道：行情 / 推送 / 进度 / 协作光标。

### 新增脚本

- `scripts/ws-fixture.mjs` —— 本地 WS 测试服务器（手写握手 + 帧发送，零依赖）
  用于自验离线验证 ws 插件

### 质量

- 自验 138 → **139 项**（+ws 采集 4 帧并解析 JSON）
- 单元测试 154；CI smoke 17；插件 18 → 19

## 0.11.0

十一期：`form` 通用表单提交插件（17 → 18）。

### 新增插件

**`form`** —— 填字段 → 提交 → 等结果 → 按规则提取
- 通用：任意 URL + 任意字段 + 任意提交按钮（`forum` 是论坛专用固定流程）
- `fields` 自动识别元素类型：checkbox/radio 用 check、select 用 selectOption、其它 fill
- `clicks` 支持提交前依次点击（同意条、展开按钮）
- 无 `submit` 时在最后一个字段按 Enter
- `waitFor` 等结果出现；`extract` 在页面内 DOM 提取
- `takeText` 取"最长的 3 个段落"（避开菜单/语言列表噪声）
- `method: "http"` 直接 POST（无浏览器，快），支持 form-urlencoded 与 json
- `saveCookies` / `screenshot` 可选

实测：Wikipedia 搜索框提交"上海" → 跳转上海市词条，标题与正文摘要均正确。

### 质量

- 自验 137 → **138 项**（+form http 模式 POST）
- 单元测试 154；CI smoke 17；插件 17 → 18

## 0.10.0

十期：`crawl` 站点爬取插件（16 → 17）。

### 新增插件

**`crawl`** —— 从入口按层爬取
- BFS 按深度抓取，去重 / 限域（sameOrigin）/ 限页（maxPages）/ 控并发
- robots.txt 的 Disallow 前缀匹配（可用 `respectRobots: false` 关闭）
- `urlPattern` 正则过滤（只抓某栏目）
- 默认 fetch + cheerio（快），`render: true` 改走 Playwright（SPA）
- 每页返回：`url` / `depth` / `title` / `description` / `textLength` / `text`（可关）/ `links`（可关）
- `fields[]` 自定义字段；`delay` 礼貌间隔
- 统计 `fetched` / `failed` / `queued` / `skipped{robots,pattern,origin,error}`

补齐了 sitemap（只出 URL）与 webpage（单页）之间的中间层。

### 测试

- 自验 135 → **137 项**（+crawl 多层去重、+urlPattern 过滤）
- 单元测试保持 154；CI smoke 17

## 0.9.0

九期：控制台补齐三个页签（调度 / 校验 / 批量）+ 模板市场落地 + init 的 --no-install。

### 控制台（7 → 10 页签）

新增三个页签，覆盖 0.4–0.8 加的所有能力：

- **调度**：列出条目（状态/模式/runs/failures/nextRun）、按插件新建（every 或 cron）、
  启停、立即执行、删除
- **校验**：内容基线校验结果（逐插件 OK/FAIL + 原因）、一键重建基线、
  Ed25519 签名状态（signed/digest-mismatch/signed-invalid/unsigned）与批量签名
- **批量**：粘贴 JSONL 任务、设并发/重试、执行并看汇总与逐条结果

配套 REST：

| 端点 | 说明 |
| --- | --- |
| `GET/POST /api/schedules` | 列表 / 新建 |
| `DELETE /api/schedules/:name` | 删除 |
| `POST /api/schedules/:name/enable\|disable` | 启停 |
| `POST /api/schedules/:name/run` | 立即执行（run 类型） |
| `GET /api/verify` · `POST /api/verify/fix` | 校验 / 重建基线 |
| `GET/POST /api/signature` | 签名状态 / 批量签名 |
| `POST /api/batch` | 批量任务 |

### 模板市场

9 个模板打包成 tgz 发布到 GitHub Release（tag `templates-v1`），
`templates/registry.json` 全部指向真实下载 URL。跨机实测：

```bash
forge template remote                    # 9 条，url 均为 https://github.com/.../templates-v1/*.tgz
forge template add <asset-url>           # 下载 + 解包 + 注册 + 记 integrity
forge run exchange-rate -p '{"from":"EUR","to":"JPY"}'   # 174.85
```

新增脚本 `scripts/pack-templates.mjs`（tar -C 直接打内容，无 package/ 前缀）。

### init 加 `--no-install`

自验与 CI 每次跑 `init` 都会重装 `pdfjs-dist`（5MB），拖慢且偶发失败。
现在 `forge init --no-install` 只装插件不装 npm 依赖，并返回 `depsSkipped`
（只列真的声明了依赖的插件，实测只有 pdf-text）。

### 修复

- 控制台前端新页签用了模板字符串，破坏 `String.raw` 模板的闭合 → 全改字符串拼接
- 自验里新增的 4 个 API 断言被插到了 `finally { srv.kill() }` 之后，
  访问已死的 server 报 ECONNRESET → 移进 try 块
- `depsSkipped` 把所有插件都列进去了（无依赖插件也返回空数组）→ 改为读 package.json 判断

### 测试

- 自验 127 → **135 项**（+4 控制台 API、+1 pdf-text 依赖检查等）
- CI smoke 17 项
- 单元测试保持 **154**

## 0.8.0

八期：三个本地能力插件（格式化 / 查询 / PDF 读取）。

### 新增插件（13 → 16）

- **`out`** —— 结果格式化
  - JSON → CSV / Markdown 表格 / 列表 / TSV
  - 自动推断列（所有条目键的并集）、支持 `columns` 指定与 `headers` 重命名
  - CSV 正确转义（含分隔符/引号/换行的单元格）
  - 可读文件（`file`）或直接给数据（`data`）
- **`json-query`** —— 本地 JSON 查询（不联网）
  - JSONPath：`$.a.b` / `[0]` / `[-1]` / `[*]` / `[1:3]` / `$..title` / `[?(@.p>100)]`
  - 字段投影、排序（asc/desc）、去重（uniqueBy）、限量、flatten
- **`pdf-text`** —— PDF 文本提取
  - 本地文件或 URL，按页返回文本 + 元信息
  - 页码范围 `"1-3,5"`、`maxPages` 防超大文件
  - 依赖 `pdfjs-dist`，安装时自动装（缺失时给可执行提示）

### 修复

- `json-query` 的 JSONPath 命中"一个数组节点"时结果多包一层，导致 sort/limit 失效
- `json-query` 的谓词过滤 `[?(@.p>100)]` 没剥外层括号，永远返回空
- 自验里 batch 用 weather 做断言，受网络波动影响 → 改用纯本地插件

### 测试

- 自验 122 → **127 项**（新增 5：out markdown、out CSV 转义、json-query 排序、json-query 谓词、pdf-text 提取）
- 单元测试保持 **154**

## 0.7.0

七期：四个高频插件 + 控制台工作流页签 + 可分发的 Skill 包。

### 新增插件

- **`screenshot`** —— 网页截图
  - 整页 / 视口 / 元素三种范围；PNG / JPEG；`output: file|base64`
  - `hideSelectors` 截图前隐藏弹窗广告；`delay` 等动画
- **`pdf`** —— 网页转 PDF
  - A4/A3/A5/Letter/Legal/Tabloid，横向，边距，缩放
  - 页眉页脚模板（`span.date/title/url/pageNumber/totalPages`）、`pageRanges`
  - 打印前自动切 `media: print`；`networkidle` 超时回退 `domcontentloaded`
- **`page-meta`** —— 页面画像
  - title/description/canonical/robots/lang/charset、OG、Twitter Card
  - JSON-LD（解析成对象，坏条目降级为 `_unparsed`）
  - h1-h3 层级、链接/图片统计（内链/外链分开）、订阅源发现、hreflang 多语言
- **`sitemap`** —— 站点地图解析
  - `<urlset>` / `<sitemapindex>` 递归 / `.gz` / 纯文本
  - 自动发现顺序：robots.txt 的 `Sitemap:` → `/sitemap.xml` → `/sitemap_index.xml` → `/sitemap-index.xml` → `/sitemap.txt`
  - 过滤：`since`（lastmod）、`prefix`、`pattern`（正则）；结果按 lastmod 倒序

### 新增

- **Web 控制台「工作流」页签**：选工作流文件、填 input、执行、看步骤进度与输出
- **可分发的 Skill 包**：`skills/forgeapi/SKILL.md`，可直接 `cp` 到 `~/.dsh/skills/` 或 `~/.claude/skills/`
- **`package.json`** 补齐 `repository` / `homepage` / `bugs` / `files` / `mcp` 与 `bench` 脚本

### 修复

- 站点地图自动发现全部失败时，会把首页 HTML 当 sitemap 解析并静默返回 0 条 → 改为明确报错并列出已尝试路径
- Web 前端资源只在首次运行时写入，升级后旧 `app.js` 不更新 → 改为内容比对覆盖

### 测试

- 自验脚本 116 → **122 项**（新增 6 项：截图文件/ base64、PDF 体积、页面画像、站点地图发现/无发现报错）
- 单元测试 152 → **154**（新增 2 条 pipeline limit 变量用例）

## 0.6.0

六期：工作流编排（pipeline）。

### 新增

- **`forge pipeline <file>`** —— 声明式工作流，把多个插件串成数据管线
  - YAML / JSON 定义（`steps[]` + `output`），支持 `--dry-run` 预演与 `--stream` NDJSON 进度
  - 变量：`${input.x}` / `${steps.<id>.data...}` / `${item.x}` / `${index}` / `${env:NAME}` / `${cred:KEY}`
  - 纯引用保留原始类型（对象/数组直接传），混排文本转字符串
  - 支持点路径与数组索引 `${steps.rate.data.results[0].rates.CNY}`
- **步骤能力**
  - `forEach` 循环（每轮注入 `${item}` / `${index}`），`limit` 限量，`concurrency` 并发
  - `when` 条件跳过（`skipped: true`，后续继续）
  - `pick` 裁剪输出（相对 data 的点路径，减小体积）
  - `onError`：`abort`（默认）/ `continue`，步骤级覆盖 pipeline 级
- **调度集成**：`schedule add --kind pipeline --file pl.yaml`，`-p` 参数作为 pipeline input
- **HTTP API**
  - `POST /api/pipeline` —— inline `def` 或文件 `file`，返回 output + 步骤摘要 + 实时 logs
  - `GET /api/pipeline/list` —— 工作区 `pipelines/` 目录下的工作流
  - `GET /api/openapi.json` —— OpenAPI 3.0.3 描述（21 个端点，`enum` 预填已装插件名）
- **示例**：`examples/search-read.yaml`（搜索→逐条精读→汇总）、`examples/conditional.json`（条件 + 失败策略 + 汇率组合）

### 修复

- `pick` 路径拼接错误（`data.${pick}` 变成 `data.data.x`）→ 改为相对 data 解析

### 测试

- 单元测试 126 → **152**（新增 `v6.test.ts` 26 条：定义解析 3、变量 6、执行 17）
- 自验脚本 108 → **114 项，全部 PASS**

## 0.5.0

五期：Ed25519 插件签名、可信公钥链、内置调度器。

### 新增

- **`forge keygen`** —— 生成 Ed25519 密钥对
  - 存 `~/.forgeapi/keys/forge-ed25519.key`（0600）/ `.pub`
  - `--signer` 记录签名者名；`--force` 覆盖
- **`forge sign [plugin]`** —— 对插件内容签名
  - 签名为目录内容哈希（`FORGE.SIG` 不计入被签内容，保证签完仍可自校验）
  - 写 `<pluginDir>/FORGE.SIG`（JSON：digest / signature / keyId / signer / at）并同步 registry
  - 不给插件名则签全部；`--list` 看状态；`--export-pub` 顺带导出公钥
- **`forge trust <import|list|verify>`** —— 可信公钥链
  - `import <file>` 按 keyId 归档到 `keys/trusted/<keyId>.pub`
  - `verify` 用签名里的 keyId 找对应可信公钥验签
- **验签四态**：`signed` / `digest-mismatch`（内容改过）/ `signed-invalid`（keyId 不匹配或签名伪造）/ `unsigned`
- **`forge schedule <list|add|remove|enable|disable|run|daemon>`** —— 内置调度
  - 时间语义：`--every <秒>`（≥10）或 `--cron "<分 时 日 月 周>"`
  - 支持 `run` / `batch` / `watch` 三种调度类型
  - `daemon` 常驻轮询（`--interval`，`--once` 单轮）
  - 每次执行更新 `runs` / `failures` / `lastStatus` / `lastSummary` / `nextRun`

### 设计要点

- cron 日/周语义遵循标准：两者都受限时取「或」，否则取「且」
- 签名与完整性基线分工：`verify` 防同机静默改动（无密钥），`trust verify` 证来源可信（有密钥，可跨机）
- 调度状态存 `~/.forgeapi/schedules.json`，daemon 无状态重启友好

### 修复

- `schedule remove` 调了两次 `removeSchedule`（第一次真删，第二次返回 false）→ 只调一次
- `schedule.ts` 注释里的 `*/` 提前闭合块注释导致编译失败 → 改注释措辞

### 测试

- 单元测试 100 → **126**（新增 `v5.test.ts` 26 条：密钥 2、签名验签 7、可信公钥 2、cron 7、调度 8）
- 自验脚本 90 → **108 项，全部 PASS**

## 0.4.0

四期：批量调度、插件完整性校验、结果 diff 监控。

### 新增

- **`forge batch <file>`** —— 批量执行插件任务
  - 任务文件：JSON 数组或 JSONL（`{ plugin, command?, params?, id? }`，`#` 开头为注释）
  - `-c/--concurrency` 并发（默认 3，顺序与任务文件一致）
  - `-r/--retry` 重试次数（指数退避 `--retry-delay`）
  - `--rate` 每秒启动上限（串行门闸，并发下不失效）
  - `--timeout` 单任务超时
  - `--out <file>` 结果落盘 JSONL
  - `--stream` 逐条 NDJSON（`batch-start` / `progress` / `result` / `batch-end`）
  - `--json` 整批结果一次输出（含 `summary` 与逐条 `results`）
- **`forge verify [plugin]`** —— 插件完整性校验
  - 安装时自动记录目录内容哈希 + 逐文件摘要到 registry（`integrity` / `integrityFiles`）
  - 篡改后能定位到具体文件（内容变更 / 新增 / 缺失）
  - `--fix` 把当前状态写为新基线
  - 跳过 `node_modules` / `.git` / `dist` / `package-lock.json` 等运行期产物
- **`forge watch <plugin> [name]`** —— 抓取并与上次快照对比
  - 首跑建基线，后续输出 `added` / `removed` / `changed` / `unchanged`
  - `--key` 指定对齐键（缺省自动 `url`/`link`/`id`/`title`，都没有则用结构哈希）
  - `--fields` 只比较指定字段；`--reset` 清快照重建
  - 快照存 `data/<plugin>/snapshots/<name>.json`

### 修复

- 限速门闸在并发下失效（多个 worker 同时通过）→ 改串行 promise 链
- `pickKey` 只接受字符串键，数字 `id` 落入结构哈希 → 支持 number/bigint

### 测试

- 单元测试 71 → **100**（新增 `v4.test.ts` 29 条：任务解析 5、批量执行 9、完整性 6、diff 6、其他 3）
- 自验脚本 81 → **90 项，全部 PASS**

## 0.3.0

三期：MCP 资源与提示、模板远端分发、依赖自动安装、流式输出。

### 新增

- **MCP resources**：每个插件暴露 `forge://plugin/<name>/skill`（skill.md，无文件时按 schema 即时生成）、
  `forge://plugin/<name>/manifest`（声明式定义）、`forge://plugin/<name>/rules/<rule>`（提取规则 YAML）
  - `resources/list` / `resources/templates/list` / `resources/read`
- **MCP prompts**：4 个工作流模板 —— `webpage_extract` / `search_multi` / `news_brief` / `data_service`
  - `prompts/list` / `prompts/get`（参数渲染进提示文本，含工具名与调用示例）
- **模板远端分发**：
  - `forge template remote [kw] [--refresh]` —— 拉取远端索引（缓存 6h）
  - `forge template add <url>` —— 支持 `builtin:<name>` / `file://` / 相对路径 / `.tgz` / GitHub 仓库
  - 索引来源：`FORGE_REGISTRY` 环境变量 > `templates/sources.json` > 随包 `templates/registry.json`
- **依赖自动安装**：代码型插件带 `package.json` 且依赖缺失时，安装后自动 `npm install`
  - 装失败不阻断注册（仍可用，只是运行时缺依赖）
  - `--no-install` 跳过
  - npm 定位：优先直接调 `npm-cli.js`（免 shell，无 DEP0190 警告）
- **流式输出**：`forge run <plugin> --stream` 输出 NDJSON
  - 首行 `{type:"meta",count,ms}`、逐条 `{type:"item",value}`、末行 `{type:"end",count,ms}`
  - 失败时输出 `{type:"error",error}`
  - 自动识别结果数组：`results` / `items` / `topics` / `boards` / `posts` / `entries`

### 修复

- 元信息探测遇缺依赖直接失败 → 退化为读 `package.json`（name/version/description），装完依赖后插件可正常运行
- 各处 `JSON.parse` 未剥 BOM（Windows PowerShell / 记事本写出的文件）→ 统一剥 `\uFEFF`
- `builtinTemplatesRoot` 用 `URL.pathname` 解析中文路径失败 → 改 `fileURLToPath`

### 测试

- 单元测试 53 → **71**（新增 `v3.test.ts` 18 条：resources 7、prompts 4、远端模板 4、依赖安装 3）
- 自验脚本 66 → **81 项，全部 PASS**

## 0.2.0

二期：MCP 服务端、模板扩容到 9、浏览器进程池、聚合并发、`--params-file`。

### 新增

- **MCP 服务端**（`forge mcp`）：零依赖 JSON-RPC 2.0 over stdio
  - `initialize` / `tools/list` / `tools/call` / `ping` / `resources/list` / `prompts/list`
  - 每个插件一个工具，每个子命令 `<plugin>__<sub>` 一个工具
  - `--only a,b` 筛选、`--flat` 不展开子命令、`--list` 只打工具表
  - `tools/call` 惰性构建索引（客户端可跳过 `tools/list` 直接调）
- **浏览器进程池**（`core/browserpool.ts`）：进程内复用 Chromium，按 headless/UA/locale 分桶
  - CLI 单次执行后关池（避免 Node 被浏览器挂住）
  - Web / MCP 常驻（`reuseBrowser: true`），实测 7.2s → 0.77s（9.4x）
  - 空闲 60s 自动回收，`FORGE_BROWSER_IDLE_MS` 可调
- **聚合并发**（`core/concurrency.ts`）：`mapLimit` 限并发（默认 3，插件可声明 `concurrency`），保持来源声明顺序
- **结果缓存**：`ResultCache`（LRU + TTL），供插件按需使用
- **`--params-file <path>`**：从文件读 JSON 参数，规避 shell 引号问题；自动剥 BOM
- **模板 6 个新增**：`exchange-rate`、`translate`（Google + MyMemory 双源兜底）、
  `news-digest`（HN/Verge/BBC 多源+关键词过滤+去重排序）、`price-compare`（站点配置驱动比价 + demo 模式）、
  `github-trending`、`wiki-summary`
- **TS 插件直载**：`index.ts` 入候选（Node ≥22.6 type-stripping），实测安装与执行通过

### 修复

- `--json` 被 program 级选项吞掉 → 统一 `allOpts(cmd)` 读 `optsWithGlobals()`
- `template install` 不支持 `--force/--yes`
- 代码型模板不被播种（原逻辑只认 manifest）→ `seedTemplates` 改为 async，支持 import 取元信息
- 缺少 npm 依赖时的报错改为可直接执行的修复命令（安装期与运行期两处）
- `keyMap` 放在 `merge` 下不生效 → 同时认 `merge.keyMap` 与 `output.keyMap`
- 嵌套子命令选项解析失效 → 改为 argv 重写（`forge <plugin> <sub>` 归一成 `run <plugin> <sub>`）

### 测试

- 单元测试 31 → **53**（新增 `concurrency` 5 条、`mcp` 14 条、聚合并发 1 条、调试相关 2 条）
- 自验脚本 48 → **66 项**（新增 MCP 协议端到端、6 个模板真实调用、并发保序、浏览器池加速）

## 0.1.0

首个可用版本。CLI + 插件系统 + 无头浏览器 + 聚合 + AI 友好层 + Web 控制台 + 模板库 + 凭据加密。

### 核心

- `ForgePlugin` 契约：`name/version/description/schema/skill/permissions/commands/execute`
- 声明式插件（`plugin.json` / `plugin.yaml`）：`extract` / `aggregate` / `flow` 三种类型
- 代码型插件（`index.mjs` / `.js` / `.ts`）：任意逻辑 + 子命令注册；`.ts` 依赖 Node ≥22.6 原生 type-stripping，无需预编译
- 引擎：`registry.reload()` 每次执行复核启用状态；插件缓存不绕过 `disable`
- 上下文注入：`browser` / `getCredential` / `setCredential` / `log` / `progress` / `config` / `dataDir`

### CLI

- `run` / `list` / `info` / `install` / `remove` / `enable` / `disable`
- `schema` / `skill`（自动从 schema 生成参数表 + JSON Schema 段）
- `log` / `config` / `cfg` / `rule` / `template` / `init` / `serve` / `doctor`
- 插件子命令直达：`forge <plugin> <sub>`（argv 重写，避免 commander 嵌套选项歧义）
- 参数两种形态：JSON（`-p '{"a":1}'`）与 `k=v,k2=v2`
- 统一输出到 stdout，日志到 stderr，失败退出码 1

### 浏览器

- Playwright 惰性启动：插件不碰 `ctx.browser` 就不启动 Chromium
- 每插件一 context，cookie 落 `data/<plugin>/cookies.json` 并自动加载
- 会话步骤 14 种动作：`goto/fill/type/click/press/wait/waitFor/scroll/eval/extract/screenshot/cookie-save/cookie-load/sleep`
- 提取双通道：HTML 字符串（cheerio，CSS/正则）与页面 DOM（含 XPath）
- 变量插值：`${param}` / `${cred:KEY}` / `${env:NAME}`，纯引用保留原始类型

### 提取规则

- CSS / XPath / JSONPath / 四种选择器（`kind` 可显式指定）
- 类型：`text/html/attr/url/list/number/bool`；`transform`：`trim/lower/upper/number/json`
- `list` 支持嵌套子字段与 `limit`；`optional` 缺失跳过
- 空选择器 = 取当前节点自身（list 子字段常用）
- 规则文件：`data/<plugin>/rules/*.yaml`，`forge rule` 读写，YAML 写入前校验

### 聚合

- 来源类型：`api` / `json` / `webpage` / `code`
- 合并策略：`concat` / `dedupe_by_title` / `dedupe_by_key` / `first_nonempty`
- 去重时合并来源集合、补全缺失字段；`sortBy` / `limit`
- 来源失败不中断（`sources[].error`），响应包装键自动识别

### 安装

- 来源：本地目录 / `.tgz` / 单清单 `.json|.yaml` / 内置名 / HTTP(S) 直链 / GitHub 仓库（codeload tarball）
- 权限声明 + 交互确认（`--yes` 跳过）
- 缺少 npm 依赖时给出可直接执行的修复命令

### 凭据

- AES-256-GCM + scrypt(N=16384,r=8,p=1)，verifier 校验主密码
- 按 `plugin:key` 命名空间隔离；`init/unlock/lock/set/get/list`
- 文件：`~/.forgeapi/credentials.json`

### Web 控制台

- `forge serve`（默认 127.0.0.1:7842）
- 六个页签：插件 / 调试 / 规则 / 日志 / 配置 / 模板
- REST：`/api/plugins[...]`、`/api/run`、`/api/logs`、`/api/config`、`/api/templates`、`/api/vault/keys`、`/api/health`
- 调试执行实时回传 progress 日志

### 模板

- 本地模板库 + `index.json`；`list/search/install/export`
- 内置：`demo-hn`（声明式聚合）、`demo-forum-pack`（声明式 flow）、`demo-weather-service`（服务包装）

### 内置插件（10）

`webpage` `blog-list` `hn-search` `search-aggregate` `rss` `github-repo` `forum` `weather` `http-api` `demo-hn`

### 测试

- 31 条 `node:test`：提取器 16、聚合器 8、核心 7
- 实测覆盖：weather（地理位置+预报）、hn-search、search-aggregate、rss、blog-list、
  webpage（CSS/规则/自定义规则）、forum（4 个 action 分支）、Web `/api/run`、vault 全流程、
  tgz 安装、GitHub 仓库安装、禁用拦截、规则热写

### 已知边界

- 无 Chromium 时网页类插件报错并给出安装命令，HTTP/RSS 类不受影响
- GitHub 未认证限 60 次/小时（`github-repo set-token` 提升到 5000）
- HTML 字符串级 XPath 不支持（cheerio 无 XPath）；页面级 XPath 走真实 DOM
- zip 安装不支持（用 `.tgz` 或 GitHub 仓库地址）
- 模板「市场」为本地目录语义，跨机分享走 tgz/git