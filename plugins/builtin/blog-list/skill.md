# blog-list v0.1.0

> 列表页批量提取：博客/新闻/搜索结果列表抽条目，支持选择器参数化与翻页。

## 调用

```bash
forge run blog-list --params '{"url":"https://example.com/blog","limit":20}'
forge run blog-list --params '{"url":"https://news.site/list","pages":3,"pageParam":"p","scroll":2}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 列表页地址 |
| `item` | string | 否 | 条目容器选择器，默认 `article, .post, .item, li` |
| `title` | string | 否 | 标题选择器（相对条目） |
| `link` | string | 否 | 链接选择器，默认 `a` |
| `summary` | string | 否 | 摘要选择器 |
| `time` | string | 否 | 时间选择器 |
| `limit` | integer | 否 | 最多条目，默认 30 |
| `pages` | integer | 否 | 翻页数，默认 1 |
| `pageParam` | string | 否 | 翻页参数名，默认 `page` |
| `waitFor` | string | 否 | 等待选择器 |
| `scroll` | integer | 否 | 滚动次数（懒加载），默认 0 |

## 输出

```json
{
  "ok": true,
  "data": {
    "source": "https://example.com/blog",
    "items": [
      { "title": "标题", "url": "https://...", "summary": "摘要", "time": "2026-11-01", "page": 1 }
    ],
    "total": 20
  }
}
```

## 注意

- 翻页按 `?<pageParam>=N` 递增；路径式翻页请改用多次 `url` 调用。
- 懒加载列表先给 `scroll` 次数，再提取。