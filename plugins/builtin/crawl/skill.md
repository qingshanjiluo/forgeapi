# crawl v0.1.0

> 站点爬取：从入口出发按层抓取，去重 / 限域 / 限页 / 控并发。

## 用途

`sitemap` 只能发现 URL，`blog-list` 只能抓一层，`webpage` 只能抓单页。
`crawl` 补这条中间链：从入口开始爬 N 层，最后拿回每页的标题 / 摘要 / 链接。

## 调用

```bash
# 抓 2 层，最多 20 页（默认走 fetch，快）
forge run crawl -p '{"url":"https://example.com","maxDepth":2,"maxPages":20}'

# 只抓博客文章（URL 正则过滤）
forge run crawl --params-file c.json
# c.json: {"url":"https://example.com","maxDepth":3,"maxPages":50,
#          "urlPattern":"/blog/","concurrency":5,"delay":200}

# JS 站点（SPA）→ 用无头浏览器渲染
forge run crawl -p '{"url":"https://spa.example","maxDepth":1,"render":true,"maxPages":10}'

# 只要特定字段
forge run crawl --params-file d.json
# d.json: {"url":"...","maxDepth":1,
#          "fields":[{"name":"标题","selector":"h1"},{"name":"日期","selector":"time","type":"attr","attr":"datetime"}],
#          "includeText":false,"includeLinks":false}
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 入口 URL |
| `maxDepth` | integer | 1 | 最大深度（0 = 只抓入口） |
| `maxPages` | integer | 20 | 最多抓多少页 |
| `concurrency` | integer | 3 | 并发抓取数 |
| `sameOrigin` | boolean | true | 只抓同源链接 |
| `respectRobots` | boolean | true | 遵循 robots.txt 的 Disallow |
| `urlPattern` | string | — | 只抓匹配该正则的 URL |
| `includeText` | boolean | true | 返回正文摘要 |
| `maxChars` | integer | 2000 | 每页摘要最大字符 |
| `includeLinks` | boolean | true | 返回每页发现的链接（最多 50） |
| `render` | boolean | false | 用 Playwright 渲染（JS 站点） |
| `delay` | integer | 0 | 每页间隔毫秒（礼貌抓取） |
| `timeout` | integer | 20000 | 单页超时 |
| `fields` | array | — | 自定义字段规则 |

## 输出

```json
{
  "ok": true,
  "data": {
    "start": "https://example.com/",
    "origin": "https://example.com",
    "maxDepth": 2,
    "fetched": 12,
    "failed": 0,
    "queued": 84,
    "skipped": { "robots": 2, "pattern": 60, "origin": 10, "error": 0 },
    "pages": [
      {
        "url": "https://example.com/",
        "depth": 0,
        "title": "Example",
        "description": "…",
        "textLength": 3421,
        "text": "正文前 2000 字…",
        "linkCount": 18,
        "links": [{ "href": "https://example.com/about", "text": "About" }]
      }
    ]
  },
  "meta": { "render": false, "robotsRules": 3 }
}
```

`pages` 按 `depth` 升序。

## 抓取策略

| 场景 | 建议 |
| --- | --- |
| 静态站、量大 | `render: false`（默认）+ `concurrency: 5~10` |
| SPA / 内容 JS 渲染 | `render: true`，`concurrency: 2~3`（浏览器开销大） |
| 只关心某栏目 | `urlPattern: "/blog/"` |
| 礼貌抓取 | `delay: 200~1000` |
| 大站 | 先 `sitemap` 拿 URL 清单再 `batch`，比 crawl 更可控 |

## 注意

- `sameOrigin: false` 会爬出去，通常配合 `urlPattern` 限住
- `maxPages` 是硬上限：达到即停，已入队的链接记为 `skipped`
- 非 HTML（图片/PDF/JSON）会记 error，不影响其它页
- robots 规则是简化实现（前缀匹配），复杂规则请自行确认
- `render: true` 复用进程内浏览器池，首屏慢、后续快

## 与其它插件的分工

| 插件 | 层次 |
| --- | --- |
| `sitemap` | 只要 URL 清单（不抓内容） |
| `crawl` | 从入口爬 N 层，带内容摘要 |
| `blog-list` | 固定列表页 + 翻页 |
| `webpage` | 单页精提取（配规则） |
| `batch` | 已有 URL 清单时批量跑 |