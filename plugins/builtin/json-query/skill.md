# json-query v0.1.0

> 本地 JSON 查询：JSONPath 取值 + 字段投影 + 排序 + 去重 + 过滤（不联网）。

## 用途

上一步的输出落盘后做二次加工，再交给下游。全程本地，不发网络请求。

## 调用

```bash
# 取某个路径
forge run json-query -p '{"file":"r.json","path":"$.data.results"}'

# 投影 + 排序 + 限量
forge run json-query --params-file q.json
# q.json: {"file":"r.json","path":"$.data.results",
#          "fields":["title","url","score"],"sortBy":"score","order":"desc","limit":5}

# 过滤（JSONPath 谓词）
forge run json-query -p '{"file":"r.json","path":"$.items[?(@.price>100)]"}'

# 递归找所有同名键
forge run json-query -p '{"file":"big.json","path":"$..title"}'

# 去重
forge run json-query -p '{"file":"r.json","path":"$.results","uniqueBy":"url"}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | string | — | JSON 文件路径 |
| `json` | any | — | 直接给数据（与 file 二选一） |
| `path` | string | `$` | JSONPath |
| `fields` | array | 全部 | 保留的字段（点路径） |
| `filter` | string | — | `@.price>100` 形式 |
| `sortBy` | string | — | 排序字段 |
| `order` | string | asc | `asc` / `desc` |
| `uniqueBy` | string | — | 按该字段去重 |
| `limit` | integer | 不限 | 最多返回几条 |
| `flatten` | boolean | false | 只有 1 条时展开为对象 |

## JSONPath 支持

| 语法 | 含义 |
| --- | --- |
| `$.a.b` | 逐层取键 |
| `$.list[0]` / `[-1]` | 数组索引 / 负索引 |
| `$.list[*]` | 数组全部元素 |
| `$.a[1:3]` | 切片 |
| `$..title` | 递归找所有 `title` |
| `$.items[?(@.price>100)]` | 谓词过滤（`==` `!=` `>` `<` `>=` `<=`） |
| `$['a-b']` | 带特殊字符的键 |

## 输出

```json
{
  "ok": true,
  "data": [{ "title": "A", "score": 10 }],
  "meta": { "count": 1, "path": "$.results" }
}
```

## 注意

- `filter` 与 `path` 里的谓词等价，两者都给会叠加
- 排序时 `undefined` / `null` 排到末尾
- `uniqueBy` 不指定时按整条 JSON 去重