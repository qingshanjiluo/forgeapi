# rss v0.1.0

> RSS/Atom 订阅解析：单/多 feed 拉取并归一化为统一条目结构。

## 调用

```bash
forge run rss --params '{"url":"https://news.ycombinator.com/rss","limit":10}'
forge run rss --params '{"urls":["https://a/rss","https://b/atom.xml"],"limit":5,"sort":true}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 否 | 单个 feed 地址 |
| `urls` | array | 否 | 多个 feed 地址 |
| `limit` | integer | 否 | 每个 feed 最多条数，默认 20 |
| `sort` | boolean | 否 | 按发布时间倒序，默认 true |

## 输出

```json
{
  "ok": true,
  "data": {
    "feeds": [
      { "source": "https://news.ycombinator.com/rss", "title": "Hacker News", "format": "rss", "count": 10 }
    ],
    "items": [
      {
        "title": "…",
        "link": "https://…",
        "summary": "…",
        "published": "Mon, 17 Nov 2026 07:00:00 +0000",
        "author": "…",
        "id": "…",
        "categories": ["tech"],
        "来源feed": "Hacker News"
      }
    ],
    "total": 10
  }
}
```

## 注意

- 自动区分 RSS 2.0 与 Atom（`<item>` vs `<entry>`）。
- 单个 feed 失败不中断，错误记在该 feed 的 `error` 字段。