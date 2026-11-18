# transform v0.1.0

> 字段级表达式计算：对每条数据求值，生成换算 / 拼接 / 条件字段（不联网）。

## 用途

抓到的原始数据往往要算成业务需要的形态：

- `1299` → `180.42` 美元
- `name` + `price` → `机械键盘 (1299)`
- `price > 1000` → `高价`
- 加了序号 / 标准化 / 打标签

`pipeline` 只能搬运变量，不能计算 —— `transform` 补这一步。

## 调用

```bash
forge run transform --params-file t.json
# t.json:
# {
#   "data": [{ "name": "机械键盘", "price": 1299 }],
#   "expr": {
#     "price_usd": "F.round(it.price / 7.2, 2)",
#     "label": "it.name + ' (' + it.price + ')'",
#     "level": "it.price > 1000 ? '高价' : (it.price > 500 ? '中价' : '低价')",
#     "rank": "i + 1"
#   }
# }
```

输出：

```json
{ "name": "机械键盘", "price": 1299, "price_usd": 180.42, "label": "机械键盘 (1299)", "level": "高价", "rank": 1 }
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `expr` | object | 必填 | `{新字段: 表达式}` |
| `data` | any | — | 输入数据（与 file 二选一） |
| `file` | string | — | 读 JSON 文件 |
| `keepOriginals` | boolean | true | 保留原字段；false 只输出新字段 |
| `onError` | string | null | 单字段失败：`null` 置 null / `throw` 中止 / `skip` 跳过该字段 |
| `limit` | integer | 不限 | 最多处理几条 |

## 表达式上下文

| 变量 | 含义 |
| --- | --- |
| `it` | 当前条目 |
| `i` | 序号（从 0） |
| `all` | 全量数组 |
| `F` | 内置函数对象 |

## 内置函数（`F.xxx`）

| 分类 | 函数 |
| --- | --- |
| 数字 | `round(n, d)` `floor` `ceil` `abs` `num(v)`（从 "1,299" 提数） |
| 字符串 | `str` `lower` `upper` `trim` `len` `split` `join` `slice` `replace` `includes` `match(s, re)` |
| 取值 | `pick(obj, key, fallback)` `get(obj, 'a.b.c', fallback)` |
| 时间 | `now()` `date(v)` → `YYYY-MM-DD` |
| 判断 | `has(v)`（非 null/undefined/空串）`ifelse(cond, a, b)` |
| 数值映射 | `scale(n, inMin, inMax, outMin, outMax)` |

## 典型式子

```js
// 单位换算
"F.round(it.price / 7.2, 2)"

// 拆分复合字段
"F.split(it.title, ' - ')[0]"

// 从带货币符号的字符串提数
"F.num(it.price_text)"

// 条件打标
"it.stock === 0 ? '缺货' : (it.stock < 10 ? '紧张' : '充足')"

// 归一化到 0-100
"F.round(F.scale(it.score, 0, 10000, 0, 100), 1)"

// 拼 URL
"it.href.startsWith('http') ? it.href : 'https://site.com' + it.href"

// 日期截断
"F.date(it.published)"

// 取嵌套
"F.get(it, 'meta.author', '匿名')"
```

## 与其它插件的组合

```bash
# 抓 → 算 → 出表
forge run hn-search -p '{"query":"rust","limit":20}' > raw.json
forge run transform -p '{"file":"raw.json","expr":{"score_k":"F.round(it.points / 1000, 1)","热门":"it.points > 500 ? \"是\" : \"否\""}}' > calc.json
forge run out -p '{"file":"calc.json","format":"markdown"}'
```

pipeline 里也能用：

```yaml
steps:
  - id: raw
    plugin: hn-search
    params: { query: rust, limit: 10 }
  - id: calc
    plugin: transform
    params:
      data: "${steps.raw.data.results}"
      expr: { "score_k": "F.round(it.points / 1000, 1)" }
```

## 注意

- 表达式在自己的数据上执行（`new Function`），只用于可信输入
- 编译在开始前一次性完成，逐条求值只做调用，快
- 单字段出错按 `onError` 处理，错误明细在 `meta.errors`（最多 20 条）
- `keepOriginals: false` 时输出只含新字段（适合"只想要计算结果"）