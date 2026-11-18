# demo-weather-service v0.1.0

> 模板演示：把公开服务包成统一接口（Open-Meteo 当前天气 + 预报）。

## 调用

```bash
forge template install demo-weather-service
forge run demo-weather-service --params '{"lat":31.23,"lon":121.47,"days":3}'
```

## 输出（原样透出，raw 模式）

```json
{
  "ok": true,
  "data": {
    "query": null,
    "results": [{ "latitude": 31.2, "longitude": 121.5, "current": {...}, "daily": {...} }],
    "total": 1,
    "sources": [{ "name": "open-meteo", "count": 1 }]
  }
}
```

## 改造点

- 换服务：改 `sources[0].url` 与 `params`
- 要结构化字段：加 `output.fields` + `merge.keyMap`，或改 `type: extract` 用规则
- 加缓存：在插件 `dataDir` 写 JSON（需 `fs-write` 权限）