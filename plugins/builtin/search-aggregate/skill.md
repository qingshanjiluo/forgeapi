# search-aggregate v0.1.0

> 多来源搜索聚合：HN / Wikipedia / GitHub / Bing 并发检索，按标题去重合并。

## 调用

```bash
forge run search-aggregate --params '{"query":"AI 绘画","sources":"hn,wiki,github","limit":10}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 查询关键词 |
| `sources` | string | 否 | 逗号分隔：`hn` / `wiki` / `github` / `bing`，默认 `hn,wiki,github` |
| `limit` | integer | 否 | 每个来源条数，默认 10 |
| `dedupe` | boolean | 否 | 按标题去重，默认 true |

## 输出

```json
{
  "ok": true,
  "data": {
    "query": "AI 绘画",
    "results": [
      {
        "title": "...",
        "url": "https://...",
        "snippet": "...",
        "score": 320,
        "来源": "hn,github"
      }
    ],
    "total": 24,
    "sources": [
      { "name": "hn", "count": 10 },
      { "name": "wiki", "count": 8 },
      { "name": "github", "count": 10 }
    ]
  }
}
```

## 注意

- 全部来源免密钥；GitHub 未认证限 10 次/分钟搜索。
- `bing` 来源为页面解析，结构随 Bing 改版变化，失败时降级为其余来源（不中断整体）。
- 去重键为标题目录化，合并时保留首个非空摘要并合并来源集合。