# sitemap v0.1.0

> 站点地图解析与 URL 发现：sitemap.xml / sitemap index / gzip / 纯文本。

## 调用

```bash
# 直接给 sitemap 地址
forge run sitemap --params '{"url":"https://example.com/sitemap.xml","limit":50}'

# 给站点根地址，自动发现（robots.txt → /sitemap.xml → /sitemap_index.xml → /sitemap.txt）
forge run sitemap --params '{"url":"https://example.com","limit":100}'

# 只要最近 7 天更新的
forge run sitemap --params-file p.json
# {"url":"https://example.com","since":"2026-11-10","limit":50}

# 只取某个栏目 + 正则过滤
forge run sitemap --params '{"url":"https://example.com/sitemap.xml","prefix":"https://example.com/blog/","pattern":"/2026/"}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | sitemap 地址，或站点根 |
| `discover` | boolean | true | 给根地址时自动发现 |
| `followIndex` | boolean | true | 展开 sitemap index 的子图 |
| `maxSitemaps` | integer | 10 | 最多展开几个子图 |
| `limit` | integer | 200 | 最多返回多少条 |
| `since` | string | — | `lastmod >=` 该日期（YYYY-MM-DD 或 ISO） |
| `prefix` | string | — | URL 前缀过滤 |
| `pattern` | string | — | URL 正则过滤 |
| `concurrency` | integer | 3 | 展开子图并发数 |

## 输出

```json
{
  "ok": true,
  "data": {
    "start": "https://example.com",
    "discovered": ["https://example.com/sitemap.xml"],
    "sitemaps": [
      { "url": "https://example.com/sitemap.xml", "type": "index", "count": 0 },
      { "url": "https://example.com/sitemap-1.xml", "type": "urlset", "count": 120 }
    ],
    "urls": [
      {
        "loc": "https://example.com/post/1",
        "lastmod": "2026-11-17T10:00:00Z",
        "changefreq": "weekly",
        "priority": "0.8"
      }
    ],
    "total": 320,
    "returned": 200,
    "filters": { "since": "2026-11-10", "prefix": null, "pattern": null },
    "tried": ["https://example.com/robots.txt"]
  }
}
```

## 格式支持

| 格式 | 识别方式 |
| --- | --- |
| `<urlset>` | 标准 sitemap |
| `<sitemapindex>` | 索引，递归展开子图（受 `maxSitemaps` 限制） |
| `.gz` 或 gzip 魔数 | 自动 gunzip |
| 纯文本 | 每行一个 http(s) URL |

## 发现顺序

1. `robots.txt` 里的 `Sitemap:` 行（优先，可能有多个）
2. `/sitemap.xml`
3. `/sitemap_index.xml`
4. `/sitemap-index.xml`
5. `/sitemap.txt`

## 注意

- 结果是按 `lastmod` 倒序（有时在前）
- 无 `lastmod` 的条目在 `since` 过滤下会被剔除
- 大型站点 sitemap 可能几千条，务必配合 `limit`
- 只解析 sitemap，不抓页面内容；拿到 URL 后用 `webpage` / `batch` 继续

## 组合用法

```bash
# 发现 URL → 批量抓取
forge run sitemap --params '{"url":"https://example.com","limit":20}' \
  | jq -r '.data.urls[].loc' > urls.txt

# 或写进 pipeline，一步到位
```