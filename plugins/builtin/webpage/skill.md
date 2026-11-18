# webpage v0.1.0

> 单页提取：打开任意网页，按 CSS/XPath/正则规则抽取结构化字段。

## 用途

传入 `url`，插件用无头浏览器打开页面，按内置规则或自定义规则文件抽取字段，返回 JSON。
适合把一个"只有人眼能看"的页面变成 AI 能读的结构化数据。

## 调用方式

```bash
forge run webpage --params '{"url":"https://example.com"}'
forge webpage extract --url "https://example.com" --rule product
```

## 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 目标网页地址 |
| `rule` | string | 否 | 规则名（`~/.forgeapi/data/webpage/rules/<name>.yaml`） |
| `root` | string | 否 | 提取根节点选择器 |
| `waitFor` | string | 否 | 等待该选择器出现后再提取 |

## 默认输出字段

```json
{
  "title": "页面标题",
  "h1": "主标题",
  "description": "meta description",
  "canonical": "规范链接",
  "links": [{ "text": "锚文本", "href": "https://..." }]
}
```

## 自定义规则

写入 `~/.forgeapi/data/webpage/rules/product.yaml`：

```yaml
fields:
  - name: 标题
    selector: "h1.product-title"
    type: text
  - name: 价格
    selector: ".price"
    type: number
  - name: 评论
    selector: ".review-item"
    type: list
    limit: 20
    fields:
      - name: 用户
        selector: ".user-name"
      - name: 内容
        selector: ".review-content"
```

调用：`forge run webpage --params '{"url":"...","rule":"product"}'`

## 注意事项

- 需要 Playwright Chromium：`npx playwright install chromium`
- 动态渲染页面用 `waitFor` 等待关键节点
- 频率限制由目标站点决定，批量抓取请自行控制并发
