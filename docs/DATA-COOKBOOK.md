# 数据获取手册

按「我要什么」查，照着敲。每条都实测过。

---

## 一、拿到一个陌生页面

**目标：搞清楚这页有什么，再决定怎么抓。**

```bash
forge run page-meta -p '{"url":"https://TARGET"}'
```

输出包含：`title` / `description` / `og.*` / `twitter.*` / `jsonLd[]` /
`headings[]` / `counts{links,internal,external,images}` / `feeds[]` / `hreflang[]` / `firstParagraph`。

**怎么用这份画像**：

| 看到什么 | 下一步 |
| --- | --- |
| `jsonLd` 里有 `Product` / `Article` | 直接从 JSON-LD 取字段，比解析 DOM 稳 |
| `feeds` 非空 | 改抓 RSS：`forge run rss -p '{"url":"<feed>"}'` |
| `counts.links` 很多 | 可能是列表页 → 用 `blog-list` |
| `headings` 扁平、无 `h1` | 结构差，用 `firstParagraph` + 正则兜底 |
| `hreflang` 有多语言 | 挑一个语言版本作为抓取入口 |

---

## 二、抓单页字段

### 2.1 先用默认规则试

```bash
forge run webpage -p '{"url":"https://TARGET"}'
# 返回 title / h1 / description / canonical / links[]
```

### 2.2 要自定义字段 → 写规则

```bash
forge rule webpage site --set 'fields:
  - {name: 标题, selector: "h1"}
  - {name: 价格, selector: ".price", type: number}
  - {name: 库存, selector: ".stock", type: text, optional: true}
  - {name: 图片, selector: ".gallery img", type: list, limit: 10, fields: [
      {name: 地址, selector: "", type: attr, attr: "src"}
    ]}'
forge run webpage -p '{"url":"https://TARGET","rule":"site"}'
```

### 2.3 选择器四选一

| 写法 | 例子 |
| --- | --- |
| CSS | `.product-title` / `div[data-id=5]` |
| XPath | `//div[@class="price"]/text()` |
| 正则 | `re:￥([\d,.]+)` |
| 相对空选择器 | `""` = 当前节点自身（list 子字段常用） |

### 2.4 动态渲染（JS 生成的内容）

```bash
forge run webpage -p '{"url":"https://TARGET","rule":"site","waitFor":".price"}'
```

`waitFor` 等到元素出现再提取。还不行就加 `blog-list` 的 `scroll` 触发懒加载。

---

## 三、抓列表页

```bash
# 默认通用选择器
forge run blog-list -p '{"url":"https://TARGET/list","limit":20}'

# 精确指定（HN 首页为例）
forge run blog-list --params-file p.json
# p.json: {"url":"https://news.ycombinator.com","limit":10,
#          "item":".athing","title":".titleline a","link":".titleline a"}

# 翻页
forge run blog-list -p '{"url":"https://TARGET/list","pages":3,"pageParam":"page"}'

# 懒加载列表
forge run blog-list -p '{"url":"https://TARGET/list","scroll":3}'
```

返回 `items[]`：`title` / `url` / `summary` / `time` / `page`。

---

## 四、多源搜索

```bash
# 三源并发（HN + Wikipedia + GitHub）
forge run search-aggregate -p '{"query":"rust async","sources":"hn,wiki,github","limit":10}'

# 加 Bing 网页来源
forge run search-aggregate -p '{"query":"X","sources":"hn,wiki,github,bing","limit":5}'
```

返回按 `score` 降序，`来源` 字段标出来源集合（去重后合并）。

---

## 五、RSS / Atom

```bash
forge run rss -p '{"url":"https://news.ycombinator.com/rss","limit":10}'

# 多 feed 合并，按时间倒序
forge run rss -p '{"urls":["https://a/rss","https://b/atom.xml"],"limit":5,"sort":true}'
```

自动区分 RSS 2.0（`<item>`）与 Atom（`<entry>`），单 feed 失败不影响其它。

---

## 六、GitHub

```bash
forge run github-repo -p '{"repo":"microsoft/vscode","action":"info"}'
forge run github-repo -p '{"repo":"microsoft/vscode","action":"issues","state":"open","limit":10}'
forge run github-repo -p '{"repo":"x","action":"search","query":"language:rust cli"}'
forge run github-repo -p '{"repo":"microsoft/vscode","action":"readme"}'
forge run github-repo -p '{"repo":"microsoft/vscode","action":"releases","limit":3}'
forge run github-repo -p '{"repo":"microsoft/vscode","action":"tree","path":"HEAD"}'
```

**限流**：未认证 60 次/小时。要提额先配 token：

```bash
forge config --vault init --password P
forge config --vault unlock --password P
forge github-repo set-token -p '{"token":"ghp_xxx"}'
# 之后每次调用插件会自动读凭据
```

---

## 七、需要登录的站

```bash
# 1) 存凭据（一次性）
forge config --vault init --password P
forge config --vault set --plugin forum --key USERNAME --value u --password P
forge config --vault set --plugin forum --key PASSWORD --value p --password P

# 2) 登录（登录态落 cookie，后续自动复用）
forge run forum -p '{"base":"https://forum.example.com","action":"login"}'

# 3) 抓数据
forge run forum -p '{"base":"https://forum.example.com","action":"boards"}'
forge run forum -p '{"base":"https://forum.example.com","action":"list","board":"/b/general"}'
forge run forum -p '{"base":"https://forum.example.com","action":"detail","topic":"/t/123"}'
```

**选择器不匹配时**（不同论坛程序）：

```bash
forge cfg forum --set '{"selectors":{"loginPath":"/ucp.php?mode=login","userField":"#username","passField":"#password","submit":"input[type=submit]","loginOk":".user-profile","topicItem":".topic-list .topic","postItem":".post"}}'
```

---

## 八、公开服务

```bash
forge run weather -p '{"city":"上海","days":3}'
forge run weather geocode -p '{"city":"Kyoto","count":3}'

forge template install exchange-rate
forge run exchange-rate -p '{"from":"USD","to":"CNY"}'
forge run exchange-rate -p '{"from":"EUR","to":"JPY","amount":100}'

forge template install translate
forge run translate -p '{"text":"Hello world","to":"zh-CN"}'

forge template install wiki-summary
forge run wiki-summary -p '{"title":"图灵机","sentences":3}'
```

---

## 九、存证 / 归档

```bash
# 整页截图
forge run screenshot -p '{"url":"https://TARGET"}'

# 只截元素
forge run screenshot -p '{"url":"https://TARGET","selector":"main"}'

# 截图但不落盘，直接拿 base64 给下游（比如让 AI 看图）
forge run screenshot -p '{"url":"https://TARGET","output":"base64","type":"jpeg","quality":60}'

# 挡住弹窗再截
forge run screenshot -p '{"url":"https://TARGET","hideSelectors":[".cookie-banner","#modal"]}'

# 网页转 PDF（A4 + 页脚页码）
forge run pdf --params-file p.json
# p.json:
# {"url":"https://TARGET","format":"A4","printBackground":true,
#  "displayHeaderFooter":true,
#  "footerTemplate":"<div style=\"font-size:9px;width:100%;text-align:center\"><span class=pageNumber></span>/<span class=totalPages></span></div>"}
```

产物路径：`~/.forgeapi/data/screenshot/shots/` 与 `~/.forgeapi/data/pdf/pdfs/`。

---

## 十、全站 URL 发现

```bash
# 给根地址，自动找 sitemap（robots.txt → /sitemap.xml → /sitemap_index.xml → ...）
forge run sitemap -p '{"url":"https://TARGET","limit":100}'

# 只最近更新的
forge run sitemap -p '{"url":"https://TARGET","since":"2026-11-01","limit":50}'

# 只某个栏目
forge run sitemap -p '{"url":"https://TARGET/sitemap.xml","prefix":"https://TARGET/blog/"}'

# 正则过滤
forge run sitemap -p '{"url":"https://TARGET/sitemap.xml","pattern":"/20(25|26)/"}'
```

拿到 URL 列表后批量抓：

```bash
forge run sitemap -p '{"url":"https://TARGET","limit":50}' \
  | jq -r '.data.urls[].loc' > urls.txt
```

---

## 十一、通用 HTTP / JSON

任何有 JSON 接口但你没写插件的场景：

```bash
forge run http-api -p '{"endpoint":"https://api.x.com/list"}'
forge run http-api -p '{"endpoint":"https://api.x.com/list","jsonpath":"$.data.items"}'
forge run http-api -p '{"endpoint":"https://api.x.com/create","method":"POST","body":{"name":"x"},"headers":{"authorization":"Bearer ${cred:TOKEN}"}}'
```

自动识别包装键：`data` / `results` / `items` / `list` / `hits` / `records` / `rows`。

---

## 十二、批量抓

```bash
# tasks.jsonl
cat > tasks.jsonl <<'EOF'
{"id":"a","plugin":"weather","params":{"city":"上海"}}
{"id":"b","plugin":"exchange-rate","params":{"from":"USD","to":"CNY"}}
EOF

forge batch tasks.jsonl -c 4 -r 3 --stream
forge batch tasks.jsonl --out results.jsonl
```

`-c` 并发 / `-r` 重试（指数退避）/ `--rate` 每秒上限 / `--timeout` 单任务超时。

---

## 十三、串成管线

**场景：搜索结果 → 逐条精读 → 汇总**

```yaml
name: search-then-read
onError: continue
input: { query: rust }
steps:
  - id: search
    plugin: search-aggregate
    params: { query: "${input.query}", limit: 5, sources: "hn,wiki" }
  - id: detail
    plugin: webpage
    forEach: "${steps.search.data.results}"
    limit: 3
    concurrency: 2
    onError: continue
    pick: "title"
    params: { url: "${item.url}" }
output: { total: "${steps.search.data.total}", pages: "${steps.detail.items}" }
```

```bash
forge pipeline pl.yaml -p 'query=rust async'
```

**场景：站点地图 → 批量精读**

```yaml
name: site-digest
steps:
  - id: urls
    plugin: sitemap
    params: { url: "https://TARGET", since: "2026-11-01", limit: 20 }
  - id: pages
    plugin: page-meta
    forEach: "${steps.urls.data.urls}"
    limit: 20
    concurrency: 3
    onError: continue
    params: { url: "${item.loc}" }
output:
  count: "${steps.pages.count}"
  titles: "${steps.pages.items[*]}"
```

**场景：多源数据组合成一个报告**

```yaml
name: daily-brief
steps:
  - id: rate
    plugin: exchange-rate
    params: { from: USD, to: CNY }
  - id: weather
    plugin: weather
    params: { city: 上海, days: 2 }
  - id: news
    plugin: news-digest
    params: { limit: 10, total: 10 }
output:
  usd_cny: "${steps.rate.data.results[0].rates.CNY}"
  temp: "${steps.weather.data.当前.温度}"
  headlines: "${steps.news.data.results}"
```

---

## 十四、监控变化

```bash
# 首次建基线
forge watch hn-search demo -p '{"query":"rust","limit":5}'

# 后续对比
forge watch hn-search demo -p '{"query":"rust","limit":10}'
# 对比 demo：5 → 10 条
# 新增 5，删除 0，变更 0，未变 5

# 改内容时（比如价格）只比某个字段
forge watch price-compare p1 -p '{"query":"键盘","demos":true}' --key title --fields price

# 定时跑
forge schedule add hn-search demo --name watch-rust --every 600 -p '{"query":"rust","limit":10}'
forge schedule daemon
```

---

## 十四点二、全站爬取

从入口爬 N 层，拿回每页标题 / 摘要 / 链接。

```bash
# 抓 2 层，最多 20 页
forge run crawl -p '{"url":"https://example.com","maxDepth":2,"maxPages":20}'

# 只抓 /blog/ 下的，加礼貌间隔
forge run crawl -p '{"url":"https://example.com","maxDepth":3,"urlPattern":"/blog/","delay":300,"concurrency":3}'

# SPA（JS 渲染）→ 用浏览器
forge run crawl -p '{"url":"https://spa.example","maxDepth":1,"render":true,"maxPages":10}'

# 只要特定字段，不要全文
forge run crawl -p '{"url":"...","maxDepth":1,"includeText":false,"fields":[{"name":"标题","selector":"h1"}]}'
```

输出 `pages[]` 按深度升序，含 `url` / `depth` / `title` / `textLength` / `links[]` / `text`。
`skipped` 里能看到因 robots / 限域 / 正则被跳过的数量。

**与其它插件的分工**：`sitemap` 只出 URL 清单 → `crawl` 爬 N 层带内容 → `webpage` 单页精提 → `batch` 批量跑。

## 十四点三、表单提交 / 交互

搜索框、筛选器、需要点同意条才出内容的页面。

```bash
# 站内搜索（不指定 submit 时按 Enter）
forge run form --params-file f.json
# f.json: {"url":"https://zh.wikipedia.org/wiki/Wikipedia:首页",
#          "fields":[{"selector":"#searchInput,input[name=search]","value":"上海"}],
#          "waitFor":"#firstHeading",
#          "extract":[{"name":"标题","selector":"#firstHeading"}]}

# 有提交按钮
forge run form -p '{"url":"https://site/search","fields":[{"selector":"input[name=q]","value":"rust"}],"submit":"button.search-btn","waitFor":".results"}'

# 先点同意条
forge run form -p '{"url":"...","clicks":["#accept-cookies"],"fields":[...],"submit":"..."}'

# 直接 POST 接口（无浏览器，快）
forge run form -p '{"url":"https://api.site/login","method":"http","fields":[{"selector":"user","value":"u"},{"selector":"pass","value":"p"}]}'
```

**要点**：选择器写多选项更稳（`"#searchInput, input[name=search]"`）；
提交按钮找不到就去掉 `submit` 走 Enter；正文摘要取"最长的 3 个段落"避开菜单噪声。

## 十四点四、WebSocket 数据流

行情、推送、进度这类实时数据只走 WS，页面里看不到。

```bash
# 收 5 帧
forge run ws -p '{"url":"wss://stream.example/feed","messages":5}'

# 先发订阅再收
forge run ws --params-file w.json
# w.json: {"url":"wss://...","subscribe":{"action":"subscribe","channel":"prices"},
#          "messages":10,"duration":15000,"idleMs":5000}

# 带鉴权 / 关键词过滤
forge run ws -p '{"url":"wss://...","headers":{"authorization":"Bearer ${cred:TOKEN}"},"filter":"BTC","messages":3,"duration":30000}'
```

三种结束条件谁先到算谁：收满 `messages` / `duration` 到时 / `idleMs` 无新帧。
输出 `frames[]` 带 `at` 时间戳，可算帧间隔。

**订阅格式**：浏览器 DevTools → Network → WS → 看客户端发了什么帧，照抄进 `subscribe`。

## 十四点五、从远端装模板

模板库有 9 个包发布在 GitHub Release，换台机器也能一键装。

```bash
forge template remote                    # 看远端索引（9 个，带真实 URL）
forge template remote weather            # 按关键词筛

# 直接给 URL 安装（跨机可用）
forge template add \
  https://github.com/qingshanjiluo/forgeapi/releases/download/templates-v1/exchange-rate.tgz

forge run exchange-rate -p '{"from":"EUR","to":"JPY"}'
# → rates.JPY = 174.85
```

自己发布模板：

```bash
forge template export my-plugin           # 导出到本地模板库
cd ~/.forgeapi/templates/my-plugin && tar -czf ~/my-plugin.tgz .
gh release upload templates-v1 ~/my-plugin.tgz   # 传到任意 Release
# 然后在 registry.json 里加一条指向该 URL
```

索引来源优先级：`FORGE_REGISTRY` 环境变量 → `~/.forgeapi/templates/sources.json` → 随包 `templates/registry.json`。

## 十五、结果格式化（贴文档 / Excel）

抓到数据后要贴进文档、表格或聊天窗口。

```bash
# 直接转 Markdown 表格
forge run hn-search -p '{"query":"rust","limit":5}' > r.json
forge run out -p '{"file":"r.json","format":"markdown"}'
# → data.text 是可直接粘贴的表格

# CSV（进 Excel）
forge run out -p '{"file":"r.json","format":"csv","separator":","}'

# 只保留要的列 + 改表头
forge run out --params-file o.json
# o.json: {"file":"r.json","format":"csv",
#          "columns":["标题","链接","热度"],"headers":["Title","URL","Score"]}

# 纯文本列表（聊天窗口）
forge run out -p '{"file":"r.json","format":"list","limit":3}'
```

## 十六、本地 JSON 加工

上一步的结果落盘后做二次处理，不联网。

```bash
# 取路径
forge run json-query -p '{"file":"r.json","path":"$.data.results"}'

# 排序 + 限量 + 选字段
forge run json-query --params-file q.json
# q.json: {"file":"r.json","path":"$.data.results",
#          "fields":["title","url","score"],"sortBy":"score","order":"desc","limit":5}

# 谓词过滤
forge run json-query -p '{"file":"r.json","path":"$.items[?(@.price>100)]"}'

# 递归找键
forge run json-query -p '{"file":"big.json","path":"$..title"}'

# 去重
forge run json-query -p '{"file":"r.json","path":"$.results","uniqueBy":"url"}'
```

## 十七、读 PDF

```bash
# 本地文件
forge run pdf-text -p '{"file":"/path/to/doc.pdf"}'

# 远程
forge run pdf-text -p '{"url":"https://arxiv.org/pdf/xxxx.pdf","pages":"1-3"}'

# 只要首页摘要
forge run pdf-text -p '{"file":"paper.pdf","pages":"1","maxPages":1}'
```

首次装本插件会自动装凭据 `pdfjs-dist`；缺依赖时给出可执行提示。
扫描件（图片型 PDF）提取不到文本，需先 OCR。

## 十五、给 AI 用

```bash
# MCP
forge mcp                       # 配置到 Claude Code / Cursor 即可
# { "mcpServers": { "forgeapi": { "command": "forge", "args": ["mcp"] } } }

# 或者让 AI 直接读文档
forge skill <plugin>            # 单插件说明书
forge schema <plugin>           # 参数 Schema
```

AI 侧会先 `resources/read forge://plugin/<name>/skill` 再调 `tools/call`，参数不会猜错。

---

## 常见失败对照

| 报错 | 原因 | 处置 |
| --- | --- | --- |
| `Chromium 启动失败` | 没装浏览器 | `npx playwright install chromium` |
| `插件已禁用` | 被 disable | `forge enable <name>` |
| `插件未安装` | 没装或模板未装 | `forge init` 或 `forge template install <name>` |
| `GitHub 403` | 未认证限流 | `forge github-repo set-token` |
| `规则文件未找到` | 规则未写 | `forge rule <plugin> <name> --set ...` |
| `未在 ... 发现 sitemap` | 站点无 sitemap | 换 `rss`，或让用户给具体地址 |
| `page.goto: Timeout` | 目标慢 / 被墙 | 加 `waitFor` 或 `timeout`；检查代理 |
| `选择器无命中` | DOM 与预期不符 | 先 `page-meta` / `webpage` 看真实结构 |
| `input JSON 非法` | 引号被 shell 吃了 | 改用 `--params-file` |

---

## 参数速查

```bash
-p '{"k":"v"}'                  内联 JSON
-p 'k=v,k2=v2'                  k=v 简写
--params-file p.json            文件（Windows 推荐）
--stream                        NDJSON 流式
--json                          纯 JSON（机器读）
-v                              详细日志
```