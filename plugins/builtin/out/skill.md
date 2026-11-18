# out v0.1.0

> 结果格式化：JSON → CSV / Markdown 表格 / 列表 / TSV。

## 用途

抓完数据要贴进文档、Excel 或聊天窗口时，一步转成可读格式，不用手工排版。

## 调用

```bash
# 直接把数据转换成 Markdown 表格
forge run out --params-file p.json
# p.json: {"data":[{"标题":"A","热度":10},{"标题":"B","热度":5}],"format":"markdown"}

# 读上一步落盘的结果
forge run hn-search -p 'query=rust,limit=5}' > r.json
forge run out --params-file q.json
# q.json: {"file":"r.json","format":"csv","columns":["标题","链接","热度"],"headers":["Title","URL","Score"]}

# 列表格式（聊天窗口用）
forge run out -p '{"file":"r.json","format":"list","limit":3}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | string | — | 读 JSON 文件（与 `data` 二选一） |
| `data` | any | — | 直接给数组或对象 |
| `format` | string | markdown | `csv` / `markdown` / `list` / `tsv` |
| `columns` | array | 自动 | 要输出的列（点路径，如 `来源.title`） |
| `headers` | array | 同 columns | 表头显示名（长度须与 columns 一致） |
| `limit` | integer | 100 | 最多输出多少行 |
| `separator` | string | `,` | CSV 分隔符 |
| `noHeader` | boolean | false | CSV 不带表头 |

## 输出

```json
{
  "ok": true,
  "data": {
    "format": "markdown",
    "rows": 2,
    "total": 2,
    "columns": ["标题", "热度"],
    "text": "| 标题 | 热度 |\n| --- | --- |\n| A | 10 |\n| B | 5 |"
  }
}
```

`text` 是可直接粘贴的成品。

## 自动识别

- 数据是数组 → 直接当行
- 数据是对象 → 找 `results` / `items` / `topics` / `boards` / `posts` / `entries` / `urls` / `data` 里的数组
- 都不匹配 → 包成单行

## 注意

- 嵌套对象单元格转成 JSON 字符串，数组用 `; ` 连接
- Markdown 里的 `|` 会被转义成 `\|`
- CSV 含分隔符/引号/换行时自动加引号并双写引号