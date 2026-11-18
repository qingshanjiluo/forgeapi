# http-api v0.1.0

> 公开 HTTP/JSON API 封装：配置 URL、方法、头、参数映射，统一输出。

## 调用

```bash
forge run http-api --params '{"endpoint":"https://api.github.com/users/octocat"}'
forge run http-api --params '{"endpoint":"https://api.example.com/search","query":{"q":"rust","limit":5},"jsonpath":"$.data.items"}'
forge run http-api --params '{"endpoint":"https://api.example.com/create","method":"POST","body":{"name":"x"},"headers":{"authorization":"Bearer ${cred:TOKEN}"}}'
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `endpoint` | string | 是 | API 地址，可含 `${param}` 占位 |
| `method` | string | 否 | GET/POST/PUT/DELETE，默认 GET |
| `query` | object | 否 | 查询参数，自动拼到 URL |
| `body` | object | 否 | 请求体（非 GET 时 JSON 序列化） |
| `headers` | object | 否 | 自定义请求头，支持 `${cred:KEY}` / `${env:NAME}` |
| `jsonpath` | string | 否 | 取数组的 JSONPath，如 `$.data.items` |
| `fields` | array | 否 | 输出字段名（未实现时为全量） |

## 输出

统一为 `{ ok, data: { results, total, sources } }`；非数组响应包装为单条。

## 注意

- 响应非 JSON 时按文本返回。
- 自动识别常见包装键：`data` / `results` / `items` / `list` / `hits` / `records` / `rows`。