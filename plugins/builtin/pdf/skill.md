# pdf v0.1.0

> 网页转 PDF：页面尺寸/边距/页眉页脚/打印背景/页码范围。

## 调用

```bash
forge run pdf --params '{"url":"https://example.com"}'

# A4 横向 + 页脚页码
forge run pdf --params-file p.json
# p.json: {"url":"...","format":"A3","landscape":true,"displayHeaderFooter":true,
#          "footerTemplate":"<div style=\"font-size:10px;width:100%;text-align:center\">
#            <span class=pageNumber></span>/<span class=totalPages></span></div>"}
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 目标网页 |
| `format` | string | A4 | A4/A3/A5/Letter/Legal/Tabloid |
| `landscape` | boolean | false | 横向 |
| `margin` | object | 10/10/8/8 mm | `{top,bottom,left,right}` |
| `printBackground` | boolean | true | 打印背景色/图 |
| `scale` | number | 1 | 缩放 0.1-2 |
| `headerTemplate` / `footerTemplate` | string | — | 页眉/页脚 HTML |
| `displayHeaderFooter` | boolean | false | 启用页眉页脚 |
| `pageRanges` | string | — | 如 `"1-3,5"` |
| `waitFor` | string | — | 等选择器出现再打印 |
| `delay` | integer | 0 | 额外等待毫秒 |
| `path` | string | 自动 | 输出路径 |

## 页眉页脚可用变量

`<span class="date">`、`<span class="title">`、`<span class="url">`、
`<span class="pageNumber">`、`<span class="totalPages">`

必须内联样式（PDF 页面不加载外部 CSS）。

## 输出

```json
{
  "ok": true,
  "data": {
    "file": ".../data/pdf/pdfs/example.com-1700000000000.pdf",
    "bytes": 45678,
    "url": "https://example.com",
    "title": "Example Domain",
    "format": "A4",
    "landscape": false
  }
}
```

## 注意

- 走 headless Chromium 的 `page.pdf()`，仅无头模式可用
- 默认落 `~/.forgeapi/data/pdf/pdfs/`
- 打印前自动切 `media: print`，页面若用 `@media print` 隐藏元素会生效
- 有长连接的页面 `networkidle` 可能超时，插件会自动回退 `domcontentloaded`
- 固定导航条在每页顶部重复时，用 `margin.top` 加高或页面自身 print 样式处理