# translate v0.1.0

> 翻译：Google translate 免费端点 + MyMemory 双源兜底。

## 调用

```bash
forge template install translate
forge run translate --params '{"text":"Hello world","to":"zh-CN"}'
forge run translate --params '{"text":"今天天气很好","from":"zh-CN","to":"en"}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待翻译文本 |
| `from` | string | 否 | 源语言，`auto` 自动检测，默认 auto |
| `to` | string | 否 | 目标语言，默认 `zh-CN` |

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      { "source": "google", "text": "你好世界", "languages": { "from": "en", "to": "zh-CN" } }
    ],
    "total": 1,
    "sources": [
      { "name": "google", "count": 1 },
      { "name": "mymemory", "count": 1 }
    ]
  }
}
```

## 注意

- 双源策略：Google 失败时自动落到 MyMemory（`first_nonempty` 取首个成功结果）。
- 免费端点有速率限制与长度上限（约 5000 字符/次），批量请自行分片。
- `source` 字段标识实际生效的来源。