# baike v0.1.0

> 百度百科词条：openapi 拿标题/摘要/信息框，`render` 模式渲染正文与目录。

## 调用

```bash
# 主通道（openapi，实测 200 / 1.4s / 13 字段）
forge run baike -p "key=贵州茅台"

# 只要信息框
forge run baike -p "key=拼多多,fieldsOnly=true"

# 渲染词条页取正文 + 目录（约 12s）
forge run baike -p "key=拼多多,render=true,includeSections=true"
```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `key` | string | 是 | — | 词条名 |
| `fieldsOnly` | boolean | 否 | false | 只要信息框字段 |
| `abstractChars` | integer | 否 | 600 | 摘要截断 |
| `render` | boolean | 否 | false | 渲染词条页（取正文/目录） |
| `waitFor` | string | 否 | `#lemmaContent` | render 等待选择器 |
| `includeSections` | boolean | 否 | true | render 返回目录章节名 |
| `maxTextChars` | integer | 否 | 4000 | render 正文截断 |

## 输出（openapi 通道）

```json
{
  "ok": true,
  "data": {
    "key": "贵州茅台",
    "title": "贵州茅台酒股份有限公司",
    "desc": "1999年在贵州省遵义市成立的高端白酒生产企业",
    "abstract": "贵州茅台酒股份有限公司（Kweichow Moutai Co., Ltd.）成立于1999年11月20日…",
    "fields": { "公司名称": "贵州茅台酒股份有限公司", "成立时间": "1999年11月20日", "员工数": "29264 人", "…": "…" },
    "fieldCount": 13,
    "url": "http://baike.baidu.com/view/1586333.htm",
    "lemmaId": 1586333
  },
  "meta": { "openapi": true, "rendered": false }
}
```

`fields` 的 value 已剥掉 `<sup>` 引用标记和 `<a>` 包装，只留纯文字。

## 通道说明（2026-11-20 实测）

| 通道 | 结果 |
| --- | --- |
| openapi `BaikeLemmaCardApi` | 200，JSON，含 title/desc/abstract/card（信息框） |
| `/item/<词条>` 裸 fetch | 403（百度安全验证） |
| `/item/<词条>` Playwright 渲染 | 200，1.1MB HTML，正文/目录可取 |

openapi 拿不到正文与目录 → 需要正文就 `render:true`。
openapi 返回空 card 时会自动补一次 render（词条名可能不精确）。

## 注意

- 词条名不精确时 openapi 会返回相近词条的 card，以 `key` 回显为准
- 百度对高频请求会挑战，`delay` 加大或串行调用
- `render:true` 占用浏览器池一个 page，约 12s

## 组合

```bash
# 百度百科 + 维基百科对照
forge run baike -p "key=拼多多" > a.json
forge run wiki -p "action=summary,title=拼多多" > b.json
forge run transform -p '{"data":[...], "expr":{"对比":"…"}}'
```