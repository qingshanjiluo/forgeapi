# news-digest v0.1.0

> 新闻摘要聚合：多 RSS/Atom 源头条合并、关键词过滤、按时间排序去重。

## 调用

```bash
forge template install news-digest
forge run news-digest --params '{}'
forge run news-digest --params '{"keyword":"AI","limit":20,"total":10}'
forge run news-digest --params '{"feeds":"https://feeds.bbci.co.uk/news/rss.xml,https://news.ycombinator.com/rss"}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `feeds` | string | 否 | 逗号分隔 RSS 地址；缺省 HN / The Verge / BBC World |
| `keyword` | string | 否 | 关键词过滤（标题+摘要，忽略大小写） |
| `limit` | integer | 否 | 每源抓取条数，默认 15 |
| `total` | integer | 否 | 输出总条数上限，默认 30 |

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "title": "…",
        "url": "https://…",
        "summary": "…",
        "published": "Mon, 17 Nov 2026 14:00:00 GMT",
        "feed": "Hacker News"
      }
    ],
    "total": 10,
    "matched": 24,
    "fetched": 45,
    "sources": [
      { "name": "Hacker News", "count": 15 },
      { "name": "The Verge", "count": 15 },
      { "name": "BBC World", "count": 15 }
    ]
  }
}
```

## 注意

- 单源失败不中断，错误记在 `sources[].error`。
- 去重按标题目录化；同题异源只保留先出现的一条。
- `matched` 仅在给了 keyword 时出现，表示过滤前命中数。