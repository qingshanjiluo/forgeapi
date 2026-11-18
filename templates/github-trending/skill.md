# github-trending v0.1.0

> GitHub 趋势榜：按语言/时间窗口取热门仓库（搜索 API 排序）。

## 调用

```bash
forge template install github-trending
forge run github-trending --params '{"language":"rust","since":"weekly","limit":10}'
forge run github-trending --params '{"since":"daily","limit":20}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `language` | string | 否 | 语言过滤（`language:` 限定符的值） |
| `since` | string | 否 | `daily` / `weekly` / `monthly`，默认 weekly |
| `limit` | integer | 否 | 条数，默认 15 |

## 查询构造

```
q = stars:>50 pushed:>YYYY-MM-DD [language:xxx]
sort = stars, order = desc
```

`since` 换算天数：daily=1、weekly=7、monthly=30。

## 输出

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "仓库": "owner/repo",
        "描述": "…",
        "星标": 1234,
        "Fork": 56,
        "语言": "Rust",
        "链接": "https://github.com/owner/repo",
        "更新": "2026-11-16T10:00:00Z",
        "来源": "trending"
      }
    ],
    "total": 10,
    "sources": [{ "name": "trending", "count": 10 }]
  }
}
```

## 注意

- 未认证限 10 次/分钟搜索；配置 token 后 30 次/分钟：
  `forge github-repo set-token --params '{"token":"ghp_xxx"}'`
  （凭据按插件隔离，如需给本插件用，把 token 写到本插件命名空间：
  `forge config --vault set --plugin github-trending --key GITHUB_TOKEN --value ghp_xxx --password PASS`）
- 这是"按星标+近期活跃"的近似趋势，不是 GitHub 官方 trending 页的逐日增量。