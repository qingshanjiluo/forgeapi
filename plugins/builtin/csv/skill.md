# csv v0.1.0

> CSV / TSV 读取 → JSON：本地文件或 URL，自动识别分隔符，可选类型推断。

## 用途

`out` 负责 JSON → CSV，`csv` 负责反方向：把表格读成结构化数据喂给下游。
零依赖，手写 RFC 4180 解析（引号、双写引号、字段内换行、CRLF）。

## 调用

```bash
# 本地文件（自动识别分隔符）
forge run csv -p '{"file":"./data.csv"}'

# 远程 CSV
forge run csv -p '{"url":"https://example.com/data.csv","limit":100}'

# 强制指定分隔符 + 不推断类型（全部保留字符串）
forge run csv -p '{"file":"./data.tsv","delimiter":"tab","inferTypes":false}'

# 无表头，自己给列名
forge run csv -p '{"file":"./raw.csv","header":false,"columns":["时间","价格","成交量"]}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | string | — | 本地路径（与 url 二选一） |
| `url` | string | — | 远程地址 |
| `delimiter` | string | auto | `auto` / `comma` / `tab` / `semicolon` / `pipe`，也可直接给字符 |
| `header` | boolean | true | 首行是否表头 |
| `columns` | array | — | 自定义列名（`header: false` 时用） |
| `inferTypes` | boolean | true | 推断数字 / 布尔 / null |
| `limit` | integer | 不限 | 最多返回几行 |
| `skipEmpty` | boolean | true | 跳过全空行 |
| `encoding` | string | utf8 | `utf8` / `latin1` |

## 输出

```json
{
  "ok": true,
  "data": [
    { "name": "机械键盘, 87键", "price": "1,299", "note": "好用的", "active": true },
    { "name": "显示器", "price": 899, "note": "多次询价\n未有回复", "active": false },
    { "name": "鼠标", "price": null, "note": "普通", "active": null }
  ],
  "meta": {
    "source": "./data.csv",
    "delimiter": ",",
    "columns": ["name", "price", "note", "active"],
    "total": 3,
    "returned": 3
  }
}
```

## 解析规则（RFC 4180）

| 情况 | 处理 |
| --- | --- |
| `"含逗号, 的字段"` | 保留内部逗号 |
| `"含""引号"""` | 双写还原成 `"` |
| 字段内换行 | 保留（不切行） |
| CRLF / LF | 都能识别 |
| BOM | 自动剥除 |
| 列数不足 | 补 `null` |
| 列数超出 | 截断（以表头为准） |

## 类型推断

`inferTypes: true`（默认）时：

| 原文 | 结果 |
| --- | --- |
| `123` / `-45` | number（安全整数） |
| `1.5` | number |
| `true` / `false` | boolean |
| `null` / `nil` / `none` | null |
| 空串 | null |
| `1,299` | **保留字符串**（含逗号，不猜千分位） |

要完全保留原文就设 `inferTypes: false`。

## 与 out 的组合

```bash
# 读 CSV → 加工 → 输出成别的格式
forge run csv -p '{"file":"in.csv"}' > rows.json
forge run json-query -p '{"file":"rows.json","path":"$","sortBy":"price","order":"desc","limit":10}' > top.json
forge run out -p '{"file":"top.json","format":"markdown"}'
```

## 注意

- 不支持 `.xlsx` / `.xls`（需要专门库）；先另存为 CSV
- 超大文件（几十万行）会全部读入内存；配 `limit` 或先切分
- `delimiter: auto` 只看首行，若首行字段里逗号很多可能误判 → 显式指定