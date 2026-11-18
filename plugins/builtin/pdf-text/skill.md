# pdf-text v0.1.0

> PDF 文本提取：本地文件或 URL，按页返回文本与元信息。

## 依赖

需要 `pdfjs-dist`（安装本插件时自动装）：

```bash
forge install plugins/builtin/pdf-text --yes    # 自动 npm install
# 或手动：
cd ~/.forgeapi/plugins/pdf-text && npm install
```

## 调用

```bash
# 本地文件
forge run pdf-text -p '{"file":"/path/to/doc.pdf"}'

# 远程 PDF
forge run pdf-text -p '{"url":"https://arxiv.org/pdf/xxxx.pdf","pages":"1-3"}'

# 只取摘要页
forge run pdf-text -p '{"file":"paper.pdf","pages":"1","maxPages":1}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file` | string | — | 本地 PDF 路径（与 url 二选一） |
| `url` | string | — | 远程 PDF 地址 |
| `pages` | string | 全部 | 页码范围，如 `"1-3,5"` |
| `maxPages` | integer | 50 | 最多解析多少页（防超大文件） |
| `joinPages` | boolean | true | 是否输出合并全文 |

## 输出

```json
{
  "ok": true,
  "data": {
    "source": "paper.pdf",
    "pages": 12,
    "parsed": 3,
    "pageList": [
      { "page": 1, "chars": 1842, "text": "..." },
      { "page": 2, "chars": 2103, "text": "..." }
    ],
    "text": "第1页文本\n\n第2页文本\n\n第3页文本",
    "chars": 6120
  },
  "meta": { "bytes": 284512 }
}
```

## 与 `pdf` 插件的关系

| 插件 | 方向 |
| --- | --- |
| `pdf` | 网页 → PDF（生成） |
| `pdf-text` | PDF → 文本（读取） |

两者互补，不冲突。

## 注意

- 扫描件（图片型 PDF）提取不到文本，需要先 OCR
- 按页返回便于定位引用；只想摘要时用 `pages: "1"`
- `maxPages` 默认 50，超大文档建议先看页数再决定范围
- 依赖缺失时会给出可直接执行的安装命令