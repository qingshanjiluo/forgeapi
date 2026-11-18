# hn-search v0.1.0

> Hacker News 搜索：Algolia API 封装，按关键词检索标题/链接/热度。

## 调用

```bash
forge run hn-search --params '{"query":"rust async","limit":10}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 搜索关键词 |
| `tags` | string | 否 | HN 标签：`story`(默认) / `comment` / `show_hn` / `ask_hn` |
| `limit` | integer | 否 | 条数，默认 20 |

## 输出

```json
{
  "ok": true,
  "data": {
    "query": "rust async",
    "total": 10,
    "results": [
      { "标题": "...", "链接": "https://...", "热度": 320, "作者": "foo", "评论数": 88, "来源": "hackernews" }
    ],
    "sources": [{ "name": "hackernews", "count": 10 }]
  }
}
```

## 注意

- 无需密钥，Algolia 公共实例限流约 10000 请求/小时。
- `tags` 支持组合写法：`(story,show_hn)`。
