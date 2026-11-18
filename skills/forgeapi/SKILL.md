---
name: forgeapi
description: 用本地 forge CLI 把网页、公开服务、第三方来源变成结构化数据。当需要抓网页字段、多源搜索聚合、RSS、GitHub 仓库信息、论坛会话、天气汇率翻译维基、网页截图/PDF/元信息、站点地图发现，或要把多个数据源串成一条管线时使用。关键词：forge、抓取、聚合、网页提取、数据管线、截图、PDF、sitemap。
---

# ForgeAPI 执行手册

本地 CLI `forge` 把「没有 API 的东西」和「散落各处的 API」封装成统一 JSON 接口。
你（AI）用 bash 调它，读 stdout 的 JSON，不需要理解内部实现。

## 铁律

1. 所有调用输出 JSON 到 stdout，日志在 stderr。**只解析 stdout**。
2. 返回 `{ok, data, error, meta, ms}`；`ok=false` 时读 `error`，退出码 1。
3. 优先用 `--params-file` 传参数（Windows 上 shell 引号会破坏 JSON）。
4. 参数不确定时先 `forge schema <plugin>`，别猜。
5. 规则类任务先 `forge skill <plugin>` 读该插件的完整说明书。

## 通用形态

```bash
forge run <plugin> --params-file p.json     # 单次执行
forge run <plugin> -p '{"k":"v"}'           # 内联（简单参数）
forge <plugin> [sub] --params-file p.json   # 子命令直达
```

## 先探能力

```bash
forge list --json                 # 有哪些插件（含 enabled 状态）
forge schema <plugin>             # 参数定义（JSON Schema）
forge skill <plugin>              # 完整说明书（Markdown）
forge info <plugin>               # 详情：子命令 / 权限 / 目录
forge doctor                      # 环境自检（chromium 是否就绪）
```

需要按场景查配方时，读仓库里的 `docs/DATA-COOKBOOK.md`（按「我要什么」组织，
含陌生页面侦察、列表抓取、登录站、批量、管线、监控、失败对照）。

## 17 个内置插件（`forge init` 后即可用）

| 插件 | 用途 | 关键参数 |
| --- | --- | --- |
| `webpage` | 任意网页按规则抽字段 | `url`, `rule`, `root`, `waitFor` |
| `blog-list` | 列表页批量抓条目（可翻页） | `url`, `limit`, `pages`, `item`, `title` |
| `search-aggregate` | HN/Wiki/GitHub/Bing 多源去重 | `query`, `sources`, `limit` |
| `hn-search` | HN 单源搜索 | `query`, `tags`, `limit` |
| `rss` | RSS/Atom 解析（单/多 feed） | `url` 或 `urls[]`, `limit` |
| `github-repo` | 仓库信息/Issue/搜索/README | `repo`, `action`, `query` |
| `forum` | 论坛登录→板块→列表→详情 | `base`, `action`, `board`, `topic` |
| `weather` | 天气（Open-Meteo 免密钥） | `city` 或 `lat`+`lon`, `days` |
| `http-api` | 通用 HTTP/JSON 封装 | `endpoint`, `method`, `query`, `body`, `jsonpath` |
| `screenshot` | 网页截图（整页/元素/base64） | `url`, `selector`, `fullPage`, `output` |
| `pdf` | 网页转 PDF | `url`, `format`, `landscape`, `margin` |
| `page-meta` | 页面画像（OG/Twitter/JSON-LD） | `url`, `includeJsonLd` |
| `sitemap` | 站点地图解析与 URL 发现 | `url`, `limit`, `since`, `prefix` |
| `out` | 结果 → CSV/Markdown/列表/TSV | `data`/`file`, `format`, `columns` |
| `json-query` | 本地 JSON 查询（JSONPath+投影+排序） | `file`/`json`, `path`, `fields`, `sortBy` |
| `pdf-text` | PDF 文本提取（按页） | `file`/`url`, `pages`, `maxPages` |
| `crawl` | 站点爬取（入口 + 深度/限页/robots） | `url`, `maxDepth`, `maxPages`, `urlPattern` |

**典型组合**：抓完数据要贴文档 →
```bash
forge run search-aggregate -p '{"query":"X","limit":5}' > r.json
forge run out -p '{"file":"r.json","format":"markdown"}'
```

## 9 个模板（需 `forge template install <name>`）

| 模板 | 用途 |
| --- | --- |
| `exchange-rate` | 汇率（ECB 数据）`from`/`to`/`amount` |
| `translate` | 翻译（Google + MyMemory 双源）`text`/`from`/`to` |
| `wiki-summary` | 维基摘要 `title`/`lang`/`sentences` |
| `news-digest` | 多源新闻聚合+关键词过滤 `keyword`/`limit` |
| `price-compare` | 比价骨架（站点配置驱动）`query`/`sites`/`demos` |
| `github-trending` | GitHub 趋势榜 `language`/`since`/`limit` |
| `demo-hn` | HN 头条（声明式聚合示例） |
| `demo-forum-pack` | 论坛登录流（声明式 flow 示例） |
| `demo-weather-service` | 公开服务包装示例 |

先 `forge template list` 看本地、`forge template remote` 看远端索引、`forge template install <name>` 装。

## 任务映射

**要某页的字段**
```bash
# 1) 先看页面有什么
forge run page-meta --params-file <(echo '{"url":"TARGET"}')
# 2) 用默认字段抓
forge run webpage --params-file <(echo '{"url":"TARGET"}')
# 3) 字段不够 → 写规则再抓
forge rule webpage site --set 'fields:
  - {name: 标题, selector: "h1"}
  - {name: 价格, selector: ".price", type: number}'
forge run webpage --params-file <(echo '{"url":"TARGET","rule":"site"}')
```

**多源搜一个词**
```bash
forge run search-aggregate --params-file <(echo '{"query":"X","sources":"hn,wiki,github","limit":10}')
```

**抓一个站的最新内容**
```bash
forge run sitemap --params-file <(echo '{"url":"https://site.com","since":"2026-11-01","limit":50}')
forge run rss --params-file <(echo '{"url":"https://site.com/feed"}')
```

**论坛/需要登录的站**
```bash
forge run forum --params-file <(echo '{"base":"https://forum.example.com","action":"login"}')
forge run forum --params-file <(echo '{"base":"https://forum.example.com","action":"list","board":"/b/x"}')
```
登录态落 cookie，后续调用自动复用。

**存证 / 归档**
```bash
forge run screenshot --params-file <(echo '{"url":"U","fullPage":true}')
forge run pdf --params-file <(echo '{"url":"U","format":"A4"}')
```

## 批量与管线

```bash
# 批量：任务文件（JSONL）
forge batch tasks.jsonl -c 4 -r 3 --stream

# 管线：上一步输出喂下一步
forge pipeline pl.yaml -p 'query=X'
forge pipeline pl.yaml --dry-run   # 先看计划
```

管线模板：
```yaml
name: search-then-read
onError: continue
input: { query: rust }
steps:
  - id: search
    plugin: search-aggregate
    params: { query: "${input.query}", limit: 5 }
  - id: detail
    plugin: webpage
    forEach: "${steps.search.data.results}"
    limit: 3
    pick: "title"
    params: { url: "${item.url}" }
output: { total: "${steps.search.data.total}", pages: "${steps.detail.items}" }
```

## 失败处置（照做，别猜）

| 现象 | 处置 |
| --- | --- |
| `error` 含 `playwright` / `Chromium` | 网页类不可用 → 换 `http-api` / `rss` 直取，或提示用户跑 `npx playwright install chromium` |
| `GitHub 403 rate limit` | 需 token：`forge config --vault init --password P`; `forge github-repo set-token --params '{"token":"ghp_x"}'`（需先 unlock） |
| `规则文件未找到` | `forge rule <plugin> <name> --set <yaml>` 先写 |
| `插件已禁用` | `forge enable <plugin>` |
| `插件未安装` | `forge init`（装内置）或 `forge install <dir>` |
| `未在 ... 发现 sitemap` | 换 `rss`、或让用户给具体 sitemap 地址 |
| schema 不符 | `forge schema <plugin>` 对照参数名与类型 |

## 验证过的事实

- 浏览器进程池复用：首次 ~3-7s，后续 ~0.7s（同进程）
- `search-aggregate` 三源并发，按标题去重，合并来源集合
- `screenshot`/`pdf` 落 `~/.forgeapi/data/<plugin>/`，返回绝对路径
- `sitemap` 支持 `<sitemapindex>` 递归展开与 `.gz`
- 所有插件调用写日志，`forge log --plugin X --error` 可查历史

## 不做什么

- 不猜插件参数：先 `schema`
- 不忽略 `ok=false` 继续往下算
- 不把 stderr 当结果解析