# wiki-summary v0.1.0

> 维基摘要：按标题取词条摘要 + 基本信息（中/英文维基可选）。

## 调用

```bash
forge template install wiki-summary
forge run wiki-summary --params '{"title":"图灵机"}'
forge run wiki-summary --params '{"title":"Alan Turing","lang":"en","sentences":2}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 词条标题（精确匹配，可用重定向名） |
| `lang` | string | 否 | 语言代码：`zh` / `en` / `ja` …，默认 zh |
| `sentences` | integer | 否 | 摘要截取句数，默认 3 |

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "title": "图灵机",
        "description": "图灵机是…（前 3 句）",
        "url": "https://zh.wikipedia.org/wiki/图灵机",
        "thumbnail": "https://…jpg",
        "lang": "zh",
        "type": "standard"
      }
    ],
    "total": 1,
    "sources": [{ "name": "wiki", "count": 1 }]
  }
}
```

## 注意

- 走 Wikipedia REST `page/summary` 端点，免密钥。
- 词条不存在时报 `HTTP 404`，先用 `rss`/`search-aggregate` 确认真实标题。
- `type` 为 `disambiguation` 表示消歧义页，摘要价值低。