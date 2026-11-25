---
name: forgeapi
description: 用本地 forge CLI 把网页、公开服务、第三方来源变成结构化数据。抓网页字段、多源搜索聚合（含 DDG/Bing/Google News 多引擎 websearch）、RSS、GitHub、论坛会话、维基百科与百度百科词条、行情快照与股吧讨论（quote/guba）、天气汇率翻译、截图/PDF/元信息、sitemap 与全站爬取、表单提交、WebSocket 采集、CSV 读取与表达式计算，并串成管线时使用。关键词：forge、抓取、聚合、爬取、网页提取、搜索、百科、行情、股价、股吧、论坛、数据管线、截图、PDF、sitemap、ws、csv。
---

# ForgeAPI 执行手册

本地 CLI `forge` 把「没有 API 的东西」和「散落各处的 API」封装成统一 JSON 接口。
你（AI）用 bash 调它，读 stdout 的 JSON，不需要理解内部实现。

## 铁律

1. 所有调用输出 JSON 到 stdout，日志在 stderr。**只解析 stdout**。
2. 返回 `{ok, data, error, meta, ms}`；`ok=false` 时读 `error`，退出码 1。
3. 优先用 `--params-file` 传参数（Windows 上 shell 引号会破坏 JSON）。
4. `-p k=v,k2=v2` 只在「逗号后紧跟 `key=`」处切分，**值里的逗号安全**（0.15.0 修复）。
5. 参数不确定先 `forge schema <plugin>`；规则类任务先 `forge skill <plugin>`。
6. **失败如实上报**：插件被风控/验证码拦时返回 `ok:false` + 原因，绝不静默返回空数组。

## 先探能力

```bash
forge list --json                 # 26 个插件（含 enabled）
forge schema <plugin>             # JSON Schema
forge skill <plugin>              # 完整说明书
forge doctor                      # 环境自检（chromium 就绪？）
```

场景配方查 `docs/DATA-COOKBOOK.md`（按「我要什么」组织，17 类）。

## 按场景选插件

| 场景 | 插件 | 关键参数 |
| --- | --- | --- |
| 抓一页字段 | `webpage` / `page-meta` | `url`, `rule`, `root` |
| 列表批量（可翻页） | `blog-list` | `url`, `limit`, `pages` |
| 从入口爬 N 层 | `crawl` | `url`, `maxDepth`, `maxPages`, `urlPattern`, `render` |
| 搜索（多引擎） | `websearch` | `query`, `engines`(ddg,bing,google,sogou) |
| 垂直源聚合 | `search-aggregate` / `hn-search` | `query`, `sources` |
| 维基百科 | `wiki` | `action`(search/summary/sections/full), `title`, `lang` |
| 百度百科 | `baike` | `key`, `render`(正文) |
| 行情快照 | `quote` | `symbols`(600519,00700,AAPL), `source` |
| 股票论坛 | `guba` | `symbol`, `source`(guba/tgb/auto), `tab` |
| 论坛登录流程 | `forum` | `base`, `action`(login/list/topic) |
| 表单/搜索框提交 | `form` | `url`, `fields`, `submit`, `waitFor` |
| RSS | `rss` | `url` 或 `urls[]` |
| 通用 HTTP | `http-api` | `endpoint`, `method`, `jsonpath` |
| 天气/汇率/翻译 | `weather` / 模板 | `city` / `from`,`to` / `text` |
| 站点地图 | `sitemap` | `url`, `since`, `prefix` |
| 截图/PDF | `screenshot` / `pdf` | `url`, `fullPage`, `format` |
| WebSocket 流 | `ws` | `url`, `subscribe`, `messages`, `filter` |
| CSV 读入 | `csv` | `file`/`url`, `delimiter` |
| 读 PDF 文本 | `pdf-text` | `file`/`url`, `pages` |
| 算字段 | `transform` | `data`, `expr`(用 `it.` 与 `F.`) |
| 出表格 | `out` | `data`, `format`(markdown/csv/tsv) |
| 过滤/排序 JSON | `json-query` | `path`, `fields`, `sortBy` |

## 高频命令

```bash
# 抓
forge run webpage --params-file p.json
forge run crawl -p "url=https://site.com,maxDepth=2,maxPages=20"
forge run wiki -p "action=summary,title=贵州茅台"
forge run baike -p "key=拼多多"
forge run websearch -p "query=贵州茅台 股价,engines=google,ddg,limit=3"

# 行情与论坛（guba 的 source=auto：东财被风控自动切淘股吧）
forge run quote -p "symbols=600519,300750,00700"
forge run guba -p "symbol=600519,limit=8"

# 算 + 出表
forge run transform --params-file t.json   # expr 如 "F.round(it.price/7.2,2)"
forge run out -p "format=markdown"
```

## 批量与管线

```bash
forge batch tasks.jsonl -c 4 -r 3 --stream
forge pipeline pl.yaml --dry-run     # 先看计划
forge pipeline pl.yaml -p 'query=X'
```

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
| `ECONNRESET`（新浪/东财/雪球直连） | 代理拒 → 该插件已内置渲染兜底；仍失败则换 `quote source=tencent` 或 `websearch` |
| `身份核实`/`访问验证`（东财股吧滑块） | 风控间歇，**不做打码** → `guba source=tgb` 换淘股吧，或隔几小时重试 |
| Google web 返回拦截页 | 已自动走 `news.google.com/rss/search` 等价通道，无需处理 |
| `Target page, context or browser has been closed` | 浏览器池 idle 已修（0.15.0），升级即可；临时 `FORGE_BROWSER_IDLE_MS=0` 关掉回收 |
| `playwright` / `Chromium` 缺失 | `npx playwright install chromium` |
| `GitHub 403 rate limit` | `forge config --vault init --password P` 后 `forge github-repo set-token` |
| `插件未安装` | `forge init --no-install`（装内置、跳过依赖） |
| `规则文件未找到` | `forge rule <plugin> <name> --set <yaml>` |

## 实测事实（2026-11，本机）

- 26 插件 / 9 模板 / 28 CLI 命令 / 10 页签 Web 控制台 / MCP 三件套
- 自验 143、单测 154、ci-smoke 17、语法门禁 25/25（`npm run check:plugins`）
- `quote` 腾讯源 fetch 直达 589ms；`baike` openapi 1.4s 出 13 字段；`wiki` 465~637ms
- `websearch` 相关度：DDG 100% / Google News 100% / Bing RSS 89% / 搜狗 89%
- `guba` 淘股吧通道 21s（东财风控重试后 auto 切换），返回行情块 + 讨论流
- 浏览器池首次 ~3-7s、后续 ~0.7s；idle 60s 自动回收（有活跃任务时只顺延）
- 走不通的路已记档：东财 `gbapi` Articlelist 12 组 JSONP 全空、雪球撞滑块、
  淘股吧详情页 302 登录（列表+行情+摘要可读）

## 自启动与安装

```bash
npm pack && npm i -g ./forgeapi-<ver>.tgz   # 全局装，得到 forge 命令
npx forgeapi install-startup                 # Windows 开机自启 forge serve
```

详见 `docs/ARCHITECTURE.md` 与 `README.md`。

## 不做什么

- 不猜插件参数：先 `schema`
- 不忽略 `ok=false` 继续往下算
- 不把 stderr 当结果解析
- 不对风控/验证码静默降级成空数据
