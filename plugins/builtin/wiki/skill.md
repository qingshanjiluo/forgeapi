# wiki v0.1.0

> 维基百科：search 检索 / summary 摘要 / sections 章节 / full 正文，多语种，官方 API。

## 实测（2026-11-20）

| 模式 | 端点 | 结果 |
| --- | --- | --- |
| `summary` | REST `/page/summary/<title>` | 200 / 465ms / 含 Q 号与多语言跳转 |
| `search` | `action=query&list=search` | 200 / 637ms / 3 条含 snippet + wordcount |
| `sections` | `action=parse&prop=sections` | 200 / 573ms / 6 个章节含 anchor |
| `full` | `prop=extracts` | 200，正文纯文本 |

## 调用

```bash
# 摘要（默认 3 句）
forge run wiki -p "action=summary,title=贵州茅台"

# 全文摘录（不切句）
forge run wiki -p "action=summary,title=贵州茅台,sentences=0"

# 站内检索
forge run wiki -p "action=search,query=贵州茅台,limit=5"

# 目录章节（含 anchor，可拼 URL 锚点）
forge run wiki -p "action=sections,title=茅台酒"

# 正文（6000 字内）
forge run wiki -p "action=full,title=茅台酒,charLimit=6000"

# 英文维基
forge run wiki -p "action=summary,title=Kweichow Moutai,lang=en"

# 带 wiki 标记的原文（引用[1]等）
forge run wiki -p "action=full,title=茅台酒,explain=true"
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `action` | string | 否 | summary | `search` / `summary` / `sections` / `full` |
| `title` | string | 看 action | — | 词条标题（search 用 `query`） |
| `query` | string | search 必填 | — | 搜索词 |
| `lang` | string | 否 | zh | `zh` / `en` / `ja` / `fr`… |
| `limit` | integer | 否 | 10 | search 条数 |
| `sentences` | integer | 否 | 3 | summary 句数（0=全文） |
| `charLimit` | integer | 否 | 6000 | full 字符上限（≤12000） |
| `explain` | boolean | 否 | false | full 是否保留 wiki 标记 |

## 输出

**summary**

```json
{
  "ok": true,
  "data": {
    "title": "贵州茅台",
    "description": null,
    "extract": "贵州茅台酒股份有限公司，1999年，由……八家公司共同发起。",
    "lang": "zh",
    "url": "https://zh.wikipedia.org/wiki/%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0",
    "thumbnail": null,
    "langlinks": [],
    "wikibaseItem": "Q1518607",
    "type": "standard"
  },
  "ms": 509
}
```

**search**

```json
{ "data": { "total": 3, "results": [
  { "title": "贵州茅台", "url": "…", "snippet": "……", "wordcount": 647, "timestamp": "2026-10-13T04:48:38Z" }
] } }
```

**sections**

```json
{ "data": { "count": 6, "sections": [
  { "index": "3", "toclevel": 1, "level": "2", "line": "股价历史", "anchor": "股价历史" }
] } }
```

**full**：`{ pageid, title, lang, chars, extract, url }`

## 与模板 wiki-summary 的区别

| | 模板 `wiki-summary` | 内置 `wiki` |
| --- | --- | --- |
| 形态 | 声明式 aggregate 源 | 代码型四模式 |
| 模式 | 仅摘要 | search / summary / sections / full |
| 多语 | zh/en/ja | 任意语言 + 搜索可用任意 lang |

## 组合

```bash
# 搜索 → 取摘要 → 章节目录（一条链）
forge run wiki -p "action=search,query=上海地铁,limit=1" > s.json
forge run wiki -p "action=sections,title=上海地铁" > sec.json

# 百度百科 + 维基对照
forge run baike -p "key=上海" > a.json
forge run wiki -p "action=summary,title=上海" > b.json
```

## 注意

- 404 = 词条不存在（错误里带 lang 提示）
- API 免密钥，`origin=*` 允许跨域（服务端调用不受限）
- 频率：维基软限约 200 req/s（本工具单次调用 1-2 个请求，无需处理）