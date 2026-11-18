# ForgeAPI 总 Skill（给 AI 的入口文档）

> 你（AI）可以调用本地 `forge` CLI 来获取网页、公开服务、第三方来源的数据。
> 每次调用输出 JSON 到 stdout；日志在 stderr，可忽略。

## 通用调用形态

```bash
forge run <plugin> --params '<JSON>'
```

返回：

```json
{ "ok": true, "data": <结果>, "error": null, "meta": null, "ms": 1234 }
```

- `ok=false` 时看 `error`，退出码为 1
- 参数缺省用插件 `schema` 里的 `default`
- 也可用 `k=v,k2=v2` 简写：`forge run weather --params 'city=上海,days=3'`

## 先探能力

```bash
forge list --json                     # 有哪些插件
forge schema <plugin>                 # 参数定义（程序化解析）
forge skill <plugin>                  # 完整说明书（Markdown）
forge info <plugin>                   # 详情：子命令/权限/目录
```

## 内置插件速查

| 插件 | 用途 | 关键参数 |
| --- | --- | --- |
| `webpage` | 任意网页按规则抽字段 | `url`, `rule`, `root`, `waitFor` |
| `blog-list` | 列表页批量抓条目（可翻页） | `url`, `limit`, `pages`, `item`, `title` |
| `search-aggregate` | HN/Wiki/GitHub/Bing 多源聚合 | `query`, `sources`, `limit` |
| `hn-search` | HN 单源搜索 | `query`, `tags`, `limit` |
| `rss` | RSS/Atom 解析（单/多 feed） | `url` 或 `urls[]`, `limit` |
| `github-repo` | 仓库信息/Issue/搜索/README | `repo`, `action`, `query` |
| `forum` | 论坛登录→板块→列表→详情 | `base`, `action`, `board`, `topic` |
| `weather` | 天气查询与预报 | `city` 或 `lat`+`lon`, `days` |
| `http-api` | 通用 HTTP/JSON 封装 | `endpoint`, `method`, `query`, `body`, `jsonpath` |

## 典型任务映射

**"查一下这个网页上的商品价格"**
```bash
forge run webpage --params '{"url":"https://shop.example/item/1","rule":"product"}'
# 若无规则，先写规则
forge rule webpage product --set 'fields:
  - {name: 标题, selector: "h1"}
  - {name: 价格, selector: ".price", type: number}'
```

**"搜一下 X，多个来源都要"**
```bash
forge run search-aggregate --params '{"query":"X","sources":"hn,wiki,github","limit":10}'
```

**"看看这个论坛板块有什么帖子"**
```bash
forge run forum --params '{"base":"https://forum.example.com","action":"list","board":"/b/general"}'
```

**"这个 GitHub 项目是干什么的"**
```bash
forge run github-repo --params '{"repo":"owner/name","action":"info"}'
forge run github-repo --params '{"repo":"owner/name","action":"readme"}'
```

**"订阅源最新几条"**
```bash
forge run rss --params '{"url":"https://news.ycombinator.com/rss","limit":10}'
```

**"这个 API 拿数据"**
```bash
forge run http-api --params '{"endpoint":"https://api.x.com/list","jsonpath":"$.data.items"}'
```

## 失败处置

| 现象 | 处置 |
| --- | --- |
| `error` 含 `playwright` / `Chromium` | 网页类不可用，改用 `http-api` 或 `rss` 直取 |
| `GitHub 403 rate limit` | 需要 TOKEN：`forge github-repo set-token` |
| `规则文件未找到` | 用 `forge rule <plugin> <name> --set <yaml>` 先写规则 |
| `插件已禁用` | `forge enable <plugin>` |
| 参数 schema 不符 | `forge schema <plugin>` 对照 |

## 组合套路

1. **先抽列表，再逐条抽详情**
   `blog-list` 拿 `items[].url` → 循环 `webpage` 取详情。
2. **多源交叉验证**
   `search-aggregate` 拿到去重后的候选 → 挑 URL 用 `webpage` 精读。
3. **登录后才能看的页面**
   `forum` 的 `action=login` 一次 → cookie 落盘 → 后续 `blog-list` / `webpage` 复用同一插件 context。
   （跨插件不共享 cookie，需要同 context 请在插件内实现。）

## 写新插件

见 `docs/PLUGIN-AUTHORING.md`。三步：
1. 建目录写 `index.mjs`（代码型）或 `plugin.json`（声明式）
2. `forge install ./dir`
3. `forge skill <name> --write ./dir/skill.md` 生成说明书