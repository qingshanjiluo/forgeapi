# screenshot v0.1.0

> 网页截图：整页/视口/元素，PNG/JPEG，可存文件或返回 base64。

## 调用

```bash
# 整页截图（默认）
forge run screenshot --params '{"url":"https://example.com"}'

# 只截某个元素
forge run screenshot --params '{"url":"https://example.com","selector":"main"}'

# 视口截图 + JPEG
forge run screenshot --params '{"url":"https://example.com","fullPage":false,"type":"jpeg","quality":70}'

# 返回 base64（给下游 AI 看图，不落盘）
forge run screenshot --params '{"url":"https://example.com","output":"base64"}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 目标网页 |
| `fullPage` | boolean | true | 整页（含滚动区）；元素截图时忽略 |
| `selector` | string | — | 只截该元素 |
| `width` / `height` | integer | 1440×900 | 视口尺寸 |
| `type` | string | png | `png` / `jpeg` |
| `quality` | integer | 80 | JPEG 质量 1-100 |
| `output` | string | file | `file`（存盘）/ `base64` |
| `path` | string | 自动 | 自定义输出路径 |
| `waitFor` | string | — | 等选择器出现再截 |
| `delay` | integer | 0 | 额外等待毫秒（动画/懒加载） |
| `hideSelectors` | array | — | 截图前隐藏（弹窗/广告/浮层） |

## 输出

```json
{
  "ok": true,
  "data": {
    "url": "https://example.com",
    "title": "Example Domain",
    "bytes": 23456,
    "type": "png",
    "scope": "整页",
    "finalUrl": "https://example.com/",
    "file": ".../data/screenshot/shots/example.com-1700000000000.png"
  }
}
```

`output: base64` 时返回 `base64` 字段而非 `file`。

## 注意

- 文件默认落 `~/.forgeapi/data/screenshot/shots/`
- 整页截图对超长页面可能很大，配合 `width` 限制视口避免超大图
- 有懒加载时先给 `delay`（如 1500）或 `waitFor`
- 弹窗/同意条用 `hideSelectors: [".cookie-banner", "#modal"]` 压掉