# form v0.1.0

> 通用表单提交与交互：填字段 → 提交 → 等结果 → 按规则提取。

## 用途

`crawl` 只做 GET，`forum` 只覆盖论坛固定流程。`form` 是通用的"填表 → 提交 → 取结果"：

- 站内搜索（搜索结果只在提交后出现）
- 查询面板 / 筛选器
- 需要点同意条 / 展开按钮才出内容的页面
- 直接 POST 表单接口（`method: "http"`，无浏览器，快）

## 调用

```bash
# 站内搜索（不指定 submit 时按 Enter 提交）
forge run form --params-file f.json
# f.json: {"url":"https://zh.wikipedia.org/wiki/Wikipedia:首页",
#          "fields":[{"selector":"#searchInput","value":"上海"}],
#          "waitFor":"#firstHeading",
#          "extract":[{"name":"标题","selector":"#firstHeading"}],
#          "text":true}

# 有明确提交按钮
forge run form -p '{"url":"https://site/search","fields":[{"selector":"input[name=q]","value":"rust"}],"submit":"button.search-btn","waitFor":".results"}'

# 先点同意条再填
forge run form --params-file g.json
# g.json: {"url":"...","clicks":["#accept-cookies"],"fields":[...],"submit":"..."}

# 直接 POST 接口（无浏览器）
forge run form -p '{"url":"https://api.site/login","method":"http","fields":[{"selector":"user","value":"u"},{"selector":"pass","value":"p"}]}'
```

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 必填 | 表单页 / 接口地址 |
| `fields` | array | — | `[{selector, value}]`，value 支持 `${cred:KEY}` |
| `clicks` | array | — | 提交前依次点击的选择器（同意条、展开按钮） |
| `submit` | string | 按 Enter | 提交按钮选择器 |
| `waitFor` | string | — | 提交后等待的选择器（结果出现） |
| `delay` | integer | 1000 | 提交后额外等待毫秒 |
| `extract` | array | — | 结果提取 `[{name, selector, type?, attr?, limit?}]` |
| `takeText` | boolean | true | 返回正文摘要（取最长的 3 个段落） |
| `maxChars` | integer | 2000 | 摘要最大字符 |
| `saveCookies` | boolean | false | 提交后保存 cookie（后续调用复用） |
| `screenshot` | boolean | false | 结果页截图存盘 |
| `method` | string | browser | `http` 直接 POST（无 JS，快） |
| `httpEnctype` | string | form | `form`（x-www-form-urlencoded）/ `json` |

## 输出

```json
{
  "ok": true,
  "data": {
    "url": "https://zh.wikipedia.org/wiki/上海市",
    "title": "上海市 - 维基百科，自由的百科全书",
    "htmlLength": 1800083,
    "extracted": { "标题": "上海市[编辑]" },
    "text": "1956年以前，中央政府认为上海地处国防前线…"
  },
  "meta": { "fields": 1, "clicks": 0 }
}
```

`method: "http"` 时输出 `{ status, url, body }`。

## 字段填充的自动识别

| 元素类型 | 行为 |
| --- | --- |
| `input[type=checkbox/radio]` | `check()` |
| `<select>` | `selectOption()` |
| 其它 | `fill()` |

## 注意

- 选择器写成多选项更稳：`"#searchInput, input[name=search]"`（不同皮肤不同 id）
- 提交按钮找不到时去掉 `submit` 走 Enter
- 需要 JS 才能出结果时不要用 `method: "http"`（它拿不到渲染后的 DOM）
- 正文摘要取"最长的 3 个段落"，避开菜单/语言列表噪声
- 验证码 / 强反爬场景本插件无能为力（需要人工介入或换接口）

## 与其它插件的分工

| 场景 | 插件 |
| --- | --- |
| 只读页面（GET） | `webpage` / `crawl` |
| 论坛固定流程（登录/板块/帖子） | `forum` |
| 任意表单提交 / 交互 | **`form`** |
| 纯 API（无页面） | `http-api` |