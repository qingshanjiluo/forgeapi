# demo-hn v0.1.0

> 模板演示：Hacker News 头条列表（声明式 API 聚合 + 字段映射 + 去重）。

## 用途

演示一个"零代码插件"：只用 `plugin.json` 声明来源与合并策略，不写 JS。

## 调用

```bash
forge template install demo-hn
forge run demo-hn --params '{"limit":10}'
```

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      { "标题": "…", "链接": "https://…", "热度": 432, "评论数": 120, "作者": "pg", "来源": "top" }
    ],
    "total": 10,
    "sources": [{ "name": "top", "count": 10 }]
  }
}
```

## 改造点

- 换来源：改 `sources[0].url` 与 `jsonpath`
- 换字段：改 `merge.fields` 与 `merge.keyMap`
- 加来源：复制 `sources` 项，`merge.strategy` 用 `dedupe_by_title`