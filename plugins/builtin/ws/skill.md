# ws v0.1.0

> WebSocket 采集：连接 → 可选订阅 → 收 N 帧 / 等 M 毫秒 → 输出。

## 用途

大量实时数据只走 WebSocket：行情、推送、聊天、任务进度、协作光标。
`http-api` 拿不到这些，`webpage` 也拿不到（页面里看不到 WS 帧）。`ws` 补这条通道。

依赖 Node 22+ 内置 `WebSocket`（undici），零外部依赖。

## 调用

```bash
# 连上收 5 帧
forge run ws -p '{"url":"wss://stream.example/feed","messages":5}'

# 先发订阅，再收 10 帧
forge run ws --params-file w.json
# w.json: {"url":"wss://stream.example/feed",
#          "subscribe":{"action":"subscribe","channel":"prices"},
#          "messages":10,"duration":15000}

# 带鉴权头
forge run ws --params-file a.json
# a.json: {"url":"wss://...","headers":{"authorization":"Bearer ${cred:TOKEN}"},"messages":3}

# 只保留含某关键词的帧
forge run ws -p '{"url":"wss://...","filter":"BTC","messages":3,"duration":30000}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | `ws://` 或 `wss://` |
| `headers` | object | — | 握手请求头（鉴权），支持 `${cred:KEY}` |
| `subscribe` | any | — | 连上后发送的消息（对象自动 JSON 序列化；数组则依次发） |
| `messages` | integer | 10 | 收多少帧结束 |
| `duration` | integer | 15000 | 最长等待毫秒 |
| `idleMs` | integer | 5000 | 连续多久无新帧就提前结束 |
| `parseJson` | boolean | true | JSON 帧解析为对象 |
| `maxFrameChars` | integer | 4000 | 单帧保留上限 |
| `filter` | string | — | 只保留包含该子串的帧 |
| `binarySkip` | boolean | true | 跳过二进制帧 |

## 输出

```json
{
  "ok": true,
  "data": {
    "url": "ws://127.0.0.1:8123",
    "connected": true,
    "reason": "count",
    "frames": [
      { "type": "text", "value": { "seq": 1, "price": 101 }, "at": "2026-11-18T20:54:23.775Z" }
    ],
    "count": 4,
    "close": null
  },
  "meta": { "want": 4, "duration": 10000, "idleMs": 4000, "filtered": false }
}
```

`reason` 取值：`count`（收够帧）/ `duration`（到时）/ `idle`（无新帧）/ `close`（对端关闭）/ `error`。

## 三种结束条件（哪个先到算哪个）

1. `messages` 帧收满
2. `duration` 到时
3. `idleMs` 内无新帧

三个都给时，谁先满足谁结束 —— 这样既有上限又不会因为流不稳一直挂着。

## 注意

- 需要 Node 22+（内置 WebSocket）；老版本报「无内置 WebSocket」
- 二进制帧默认跳过（`binarySkip: false` 只记字节数，不落地）
- 帧按顺序存 `frames[]`，带 `at` 时间戳便于算间隔
- 订阅格式随服务而定，先用浏览器 DevTools → Network → WS 看客户端发了什么
- 鉴权有的走 header、有的走首帧、有的走 URL query，三种都要试

## 不适用

- 需要长期常驻收流的场景：`ws` 是"采集 N 帧就退出"，常驻请用 `schedule` 定时跑或自己写守护
- 需要主动发多轮请求的服务（如 RPC 式）：`subscribe` 只发初始消息，后续交互需自定义插件