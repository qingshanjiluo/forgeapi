# page-meta v0.1.0

> 页面元信息画像：OG / Twitter / JSON-LD / 标题层级 / 链接统计 / 多语言版本 / 订阅源发现。

## 用途

给一条 URL，返回"这页是什么"的完整画像——AI 不必再猜页面结构就能决定下一步。

## 调用

```bash
forge run page-meta --params '{"url":"https://example.com"}'
forge run page-meta --params '{"url":"https://github.com","includeJsonLd":false}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 目标网页 |
| `waitFor` | string | — | 等选择器出现再提取 |
| `includeJsonLd` | boolean | true | 包含 JSON-LD 结构数据 |
| `maxHeadings` | integer | 20 | 标题层级最多取几条 |

## 输出

```json
{
  "ok": true,
  "data": {
    "title": "Example Domain",
    "description": "…",
    "canonical": "https://example.com/",
    "robots": null,
    "lang": "en",
    "charset": "UTF-8",
    "og": { "title": "…", "type": "website", "url": "…", "image": "…" },
    "twitter": { "card": "summary", "site": "…" },
    "jsonLdCount": 2,
    "jsonLd": [ { "@type": "WebPage", "name": "…" } ],
    "headings": [
      { "level": 1, "text": "Example Domain" },
      { "level": 2, "text": "…" }
    ],
    "counts": { "links": 12, "internal": 3, "external": 9, "images": 4 },
    "feeds": [ { "href": "/rss.xml", "type": "application/rss+xml" } ],
    "hreflang": [ { "lang": "zh-CN", "href": "/zh/" } ],
    "favicon": "/favicon.ico",
    "firstParagraph": "…",
    "finalUrl": "https://example.com/"
  }
}
```

## 字段说明

| 字段 | 用途 |
| --- | --- |
| `og.*` / `twitter.*` | 分享卡片信息，常含良好摘要与配图 |
| `jsonLd` | schema.org 结构数据（Article / Product / Event / FAQ…），比 meta 更结构化 |
| `headings` | h1-h3 层级，判断页面主题与结构 |
| `counts` | 链接/图片统计，粗略判断页面体量 |
| `feeds` | RSS/Atom 发现，可直接喂给 `rss` 插件 |
| `hreflang` | 多语言版本，做国际化抓取时的入口 |

## 注意

- 无 h1 或多个 h1 会写 warn 日志（SEO 角度）
- JSON-LD 解析失败的单条会变成 `{ "_unparsed": "..." }`，不影响其它
- 需要 `npx playwright install chromium`