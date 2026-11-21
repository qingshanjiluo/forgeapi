# websearch v0.1.0

> 多引擎网页搜索：Bing RSS / DuckDuckGo / Google 新闻 / 搜狗并发，按标题去重。

## 实测（2026-11-20，本机网络）

| 引擎 | 通道 | 状态 | 相关度 |
| --- | --- | --- | --- |
| `ddg` | `html.duckduckgo.com/html` | 200（间歇 202 挑战，重试+lite 兜底） | **100%** |
| `bing` | `bing.com/search?format=rss` | 200 / 343ms | 89-90% |
| `google` | **`news.google.com/rss/search`** | 200 / 34 条 | **100%**（命中 4/4） |
| `sogou` | `sogou.com/web` | 间歇反爬 | 89% |
| ~~google web~~ | `google.com/search` | **被拦**（h3=0 拦截页 / unusual traffic） | — |
| ~~bing html~~ | `li.b_algo` 解析 | 结构已变（0 命中），弃用 | — |

Google web 搜索本机不可用，改走 **Google News RSS**（同一 Google 数据的新闻切片，中文源好）。
DuckDuckGo 202 挑战页自动重试 3 次（html + lite 端点轮换）。

## 调用

```bash
# 默认 ddg + bing
forge run websearch -p "query=贵州茅台 股吧,limit=5"

# 指定引擎（注意 -p 的逗号只在 key= 前切，值里逗号安全）
forge run websearch -p "query=Tesla stock price,engines=google,ddg,limit=3"

# 全开
forge run websearch --params-file s.json
# {"query":"上海 新能源","engines":"ddg,bing,google,sogou","limit":10}
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `query` | string | 是 | — | 查询词 |
| `engines` | string | 否 | `ddg,bing` | `ddg,bing,google,sogou` |
| `limit` | integer | 否 | 10 | 每引擎条数 |
| `dedupe` | boolean | 否 | true | 按标题去重 |
| `lang` | string | 否 | zh-CN | 语言提示 |

## 输出

```json
{
  "ok": true,
  "data": {
    "query": "贵州茅台 股价",
    "total": 6,
    "results": [
      { "title": "贵州茅台 (600519)_最新价格_行情_走势图—东方财富网",
        "url": "https://quote.eastmoney.com/sh600519.html",
        "snippet": "提供贵州茅台 (600519)股票的行情走势……",
        "来源": "ddg", "源序": 1, "来源集合": ["ddg"] },
      { "title": "贵州茅台“酒价向下、股价向上”… - Sohu",
        "url": "https://news.google.com/rss/articles/CBMi…", "来源": "google" }
    ],
    "engines": [
      { "name": "google", "count": 3 },
      { "name": "ddg", "count": 3, "error": null }
    ]
  },
  "ms": 930
}
```

- 单引擎失败不拖垮整体（`error` 记在该引擎行）
- 全部失败才 `ok:false`，错误里逐引擎原因
- 跨引擎去重后 `来源` 是逗号拼接的多源标记

## 与 search-aggregate 的区别

| | `search-aggregate` | `websearch` |
| --- | --- | --- |
| 源 | hn / wiki / github / bing(HTML) | ddg / bing(RSS) / google(news) / sogou |
| 定位 | 垂直源（开发者/百科） | 通用网页搜索引擎 |
| 稳定性 | hn/wiki/github API 稳定 | bing RSS + ddg 重试兜底 |

要垂直结果用 `search-aggregate`，要网页搜索结果用 `websearch`，两者可 pipeline 一起用。

## 注意

- `bing` RSS 的 `mkt=zh-CN` 已内置；英文查询自动切换不用管
- DDG 被 202 时自动重试 3 次（约 2s 内），仍失败会把该源标 `error` 不影响其它
- `google` 是新闻源：结果带 `pubDate`，URL 是 news.google.com 跳转链
- 搜狗对高频请求反爬，建议最后加（`engines=ddg,bing,sogou`）

## 组合

```bash
# 搜索 → 抓首条正文 → 提元信息
forge run websearch -p "query=600519 研报,engines=ddg,limit=3" > s.json
forge run json-query -p '{"file":"s.json","path":"$.data.results[0].url"}' > u.json
forge run webpage -p '{"url":"<u>","selectors":{"title":"h1"}}'
```