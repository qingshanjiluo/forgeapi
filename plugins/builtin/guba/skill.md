# guba v0.2.0

> 股票论坛封装：东财股吧（主）+ 淘股吧（等价通道），`auto` 自动切换。

## 两条通道（2026-11-21 实测）

| | 东财股吧 `guba` | 淘股吧 `tgb` |
| --- | --- | --- |
| 入口 | `guba.eastmoney.com/list,<code>.html` | `taoguba.com.cn/quotes/<code>` |
| 裸 fetch | ECONNRESET（代理拒）→ 走渲染 | 同左 |
| 渲染 | 首轮 200 / 370KB；**随后「身份核实」验证码** | 200 / 稳定 / **无验证码** |
| 帖子链接 | `/news/<code>,<id>.html` | `/a/<base62>`（短链） |
| 行情 | 无 | **有**（价格/涨跌/昨收今开/高低/量额/换手/市值） |
| 帖子正文 | 可抓（`includeBody`） | 详情页 302 登录，仅列表+摘要可读 |

`source` 默认 `auto`：先东财，被风控则自动切淘股吧（失败原因记在 stderr warn）。

## 调用

```bash
# 默认 auto（东财失败自动切淘股吧）
forge run guba -p "symbol=600519,limit=8"

# 只要淘股吧（稳，还带行情）
forge run guba -p "symbol=600519,source=tgb,limit=10"

# 东财全部/热门/资讯/推荐页签
forge run guba -p "symbol=600519,tab=hot,limit=20"

# 东财逐帖抓正文（需东财未风控）
forge run guba -p "symbol=600519,source=guba,limit=5,includeBody=true,maxBodyChars=3000"
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `symbol` | string | 是 | — | `600519` / `sh600519` |
| `source` | string | 否 | auto | `guba` / `tgb` / `auto` |
| `tab` | string | 否 | all | 东财：`all`/`hot`/`news`/`recommend` |
| `limit` | integer | 否 | 20 | 抓几条 |
| `includeBody` | boolean | 否 | false | 东财逐帖正文（淘股吧需登录，不可用） |
| `maxBodyChars` | integer | 否 | 3000 | 正文截断 |
| `maxTry` | integer | 否 | 3 | 东财验证码/空列表重试次数 |
| `settle` | integer | 否 | 3500 | 页面稳定等待毫秒 |
| `waitFor` | string | 否 | `.list_ul li, table` | 东财等待选择器 |
| `skipStockBar` | boolean | 否 | true | 东财跳过「热门股吧」排行榜 |
| `symbolFilter` | boolean | 否 | true | 东财只保留本代码 |

## 输出

淘股吧通道（`source: "taoguba"`，含行情块）：

```json
{
  "ok": true,
  "data": {
    "source": "taoguba",
    "symbol": "sh600519",
    "url": "https://www.taoguba.com.cn/quotes/sh600519",
    "quote": { "price": "1485.75", "changePct": "+1.75%", "prevClose": "1460.21",
               "open": "1450.89", "high": "1489.09", "low": "1423.90",
               "volume": "6.72万手", "amount": "97.96亿", "turnover": "0.54%",
               "marketCap": "18573.09亿", "time": "2026-11-20 16:29:47" },
    "count": 5,
    "posts": [
      { "title": "9%分享满坤科技大盘大跌挣10%爽吧…",
        "url": "https://www.tgb.cn/a/2wSEKXTJZ40",
        "postId": "2wSEKXTJZ40", "author": "安心猿", "time": "18:53" }
    ],
    "note": "淘股吧帖子详情页需登录，本插件只取个股页可读的列表与摘要"
  }
}
```

东财通道（风控时 `ok:false` + 如实报错）：

```json
{ "ok": false, "error": "抓取失败：页面返回「访问验证」验证码…本插件不做打码。重试 3 次仍未通过。" }
```

`auto` 模式下东财失败会 warn 后切淘股吧，最终仍 `ok:true`。

## 东财走不通的路（记档，别再试）

- `gbapi.eastmoney.com` Articlelist：JSONP 可达但 `re:[]`，`articlelistcode` 试
  `600519`/`sh600519`/`1.600519`/`0.600519` × 3 个 base 共 12 组全空
- 页面内 `fetch(gbapi)`：`TypeError: Failed to fetch`（跨域拒）
- 裸 fetch `guba.eastmoney.com`：ECONNRESET
- 淘股吧 `/Article/Articlelist`、`/new/index`、`/forum`：404 或空壳

## 行为设计

1. **验证码识别**：title/body 命中 `身份核实|访问验证|安全验证|人机验证|captcha|按住滑块` → challenge
2. **东财重试**：关弹层 → 等 `waitFor` → 稳定 `settle` → 轻滚 → 抽锚点；空则关 page 重开，`maxTry` 次
3. **空结果不静默**：零帖子返回 `ok:false` + anchors/title 证据
4. **auto 兜底**：东财失败记录 warn，切淘股吧（无验证码，且多给一个 `quote` 行情块）

## 等价路径（跨站）

| 需求 | 用什么 |
| --- | --- |
| 行情/价格 | `quote`（腾讯 fetch 直达，最快最稳） |
| 个股讨论（东财被拦时） | `guba source=tgb` |
| 个股新闻 | `websearch engines=google`（Google News RSS）或 `rss` |
| 论坛通用会话（登录/板块/详情） | `forum` |

## 注意

- 频繁打东财会加速风控；`schedule` 建议小时级
- 淘股吧详情页需登录（`includeBody` 不可用），列表+行情+摘要可读
- 本插件不做打码：验证码出现就如实报错返回，不静默、不假装成功
- 行情字符串含单位（`6.72万手`/`97.96亿`），要数值自己 `F.num()` 转

## 组合

```bash
# 论坛情绪 + 行情对照
forge run guba -p "symbol=600519,source=tgb,limit=10" > f.json
forge run quote -p "symbols=600519" > q.json
forge run transform -p '{"data":[...],"expr":{"讨论热度":"it.count"}}'
```