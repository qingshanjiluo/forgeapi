# price-compare v0.1.0

> 比价：按站点配置抓取同一商品价格，归一化为统一结构并排序。

## 调用

```bash
forge template install price-compare

# 1) 先看结构与排序逻辑（不联网）
forge run price-compare --params '{"query":"机械键盘","demos":true}'

# 2) 真实抓取：给站点配置
forge run price-compare --params '{"query":"机械键盘","sites":[
  {"name":"shopA","url":"https://shopA.example/search?q=${query}","priceSel":".price","titleSel":".title","currency":"CNY"},
  {"name":"shopB","url":"https://shopB.example/s?k=${query}","priceSel":".a-price","titleSel":"h2","currency":"CNY"}
]}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 商品关键词（标题校验 + `${query}` 占位替换） |
| `sites` | array | 否 | `[{name,url,priceSel,titleSel?,currency?,waitFor?,timeout?}]` |
| `demos` | boolean | 否 | 用内置样例验证结构与排序，不联网 |
| `limit` | integer | 否 | 每站点最多条数，默认 5 |

## 输出

```json
{
  "ok": true,
  "data": {
    "query": "机械键盘",
    "results": [
      { "site": "shopB", "title": "机械键盘 87键", "price": 189, "currency": "CNY", "url": "https://…" },
      { "site": "shopA", "title": "机械键盘 标准版", "price": 199, "currency": "CNY", "url": "https://…" }
    ],
    "lowest": { "site": "shopB", "price": 189 },
    "highLow": { "low": 189, "high": 199 },
    "total": 2,
    "priced": 2,
    "mode": "live"
  }
}
```

## 归一化规则

- 价格串取第一个数字（去千分位逗号），支持 `￥1,299.00` / `$19.99` / `1 299 ₽`
- 币种识别顺序：`site.currency` > 符号/后缀（￥¥ $ € £）> `null`
- 无价格的条目（缺货/解析失败）排在最后，`price: null`
- 抓取失败记 `error` 字段，不中断其它站点

## 注意

- 需要 Chromium：`npx playwright install chromium`
- 价格选择器随站点结构变化，先 `forge run webpage` 探一下真实 DOM 再填
- 页面为懒加载时加 `waitFor`