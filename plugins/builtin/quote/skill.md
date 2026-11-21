# quote v0.1.0

> 股票行情快照：腾讯 qt 主通道（fetch 直达），新浪/东财渲染兜底，A股/港股/美股。

## 实测（2026-11-20，本机网络）

| 通道 | 结果 |
| --- | --- |
| 腾讯 `qt.gtimg.cn` | **fetch 直达 200**（GBK，`~` 分隔 60+ 字段），589ms |
| 新浪 `hq.sinajs.cn` | fetch **ECONNRESET**（代理拒）→ 渲染兜底可达 |
| 东财 `push2.eastmoney.com` | fetch **ECONNRESET** → 页面上下文 fetch 200 |

## 调用

```bash
# 单只（自动补市场前缀：600519 → sh600519）
forge run quote -p "symbols=600519"

# 多只混合（A股 + 港股 + 美股）
forge run quote -p "symbols=600519,300750,00700,AAPL"

# 只要几个字段 + 按涨幅排序
forge run quote -p "symbols=600519,000001,300750,fields=name,price,changePct,sorted=true"

# 指数
forge run quote -p "symbols=000001"        # → sh000001 上证指数
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `symbols` | string | 是 | — | 逗号分隔代码 |
| `source` | string | 否 | tencent | `tencent` / `sina` / `auto` |
| `render` | boolean | 否 | true | 主源失败时浏览器兜底 |
| `fields` | array | 否 | — | 只返回这些字段 |
| `sorted` | boolean | 否 | false | 按涨幅降序 |

## 代码归一

| 输入 | 归一为 |
| --- | --- |
| `600519` / `000001` / `4xxxxx` `8xxxxx` | `sh600519` / `sz000001` / `bj…`（按首位判市场） |
| `00700` / `hk00700` | `rt_hk00700` |
| `AAPL` / `TSLA.us` | `usAAPL` |
| `sh600519` / `SZ300750` | 原样小写 |

## 输出

单只时返回首条 + `rows[]` 数组；多只只返回 `rows[]`。

```json
{
  "ok": true,
  "data": {
    "source": "tencent",
    "code": "sh600519",
    "name": "贵州茅台",
    "symbol": "600519",
    "price": 1460.21,
    "prevClose": 1442.66,
    "open": 1442.00,
    "high": 1464.99,
    "low": 1432.10,
    "volume": 42692,        // 手
    "amount": 619221,        // 万元
    "change": 17.55,
    "changePct": 1.22,
    "time": "20261119161455"
  },
  "meta": { "source": "tencent", "codes": ["sh600519"] }
}
```

`raw` 里是腾讯原始 `~` 分隔数组（60+ 字段，含换手率/市盈率/52周高低等，可自行取）。

## K 线（要历史行情时）

腾讯 K 线（web.ifzq.gtimg.cn）与 push2his 均在 fetch 层被拒，走 http-api 或渲染：

```bash
forge run http-api -p '{"url":"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,10,qfq"}'
```

## 注意

- 行情是快照（`time` 字段是最后成交时间，非交易时段为收盘时间）
- 腾讯限流宽松；批量超过 50 只建议分批
- `fields` 用于裁剪（腾讯 `raw` 很大，透传占体积）

## 组合

```bash
# 抓行情 → 算市值占比 → 出表
forge run quote -p "symbols=600519,000858,000568,fields=name,price,amount,sorted=true" > q.json
forge run transform -p '{"file":"q.json","data":..., "expr":{"成交额亿":"F.round(it.amount/10000,2)"}}'
forge run out -p '{"format":"markdown"}'
```