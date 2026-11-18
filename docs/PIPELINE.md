# 工作流编排（pipeline）

把多个插件串成一条数据管线：上一步的输出可以直接当下一步的输入。

## 最小例子

`pl.yaml`：

```yaml
name: hello
steps:
  - id: rate
    plugin: exchange-rate
    params: { from: USD, to: CNY }
  - id: search
    plugin: hn-search
    params:
      query: "1 usd in cny is ${steps.rate.data.results[0].rates.CNY}"
      limit: 2
output:
  rate: "${steps.rate.data.results[0].rates.CNY}"
  hits: "${steps.search.data.total}"
```

```bash
forge pipeline pl.yaml
# {
#   "ok": true,
#   "output": { "rate": 6.6661, "hits": 2 },
#   "steps": [ { "id": "rate", ... }, { "id": "search", ... } ]
# }
```

## 变量

| 写法 | 含义 |
| --- | --- |
| `${input.x}` | 调用时传入的输入参数（`-p` / `--params-file`） |
| `${input.x.y[0]}` | 点路径 + 数组索引 |
| `${steps.<id>.data...}` | 某步骤的输出；步骤对象本身是 `{ id, plugin, ok, data, ms }` |
| `${steps.<id>.items[0].data}` | forEach 步骤的单轮结果 |
| `${item.x}` | forEach 当前元素 |
| `${index}` | forEach 当前序号（从 0） |
| `${env:NAME}` | 环境变量 |
| `${cred:KEY}` | 凭据库（pipeline 命名空间） |

**纯引用保留类型**：整串只有一个 `${...}` 时返回原值（对象/数组/数字原样传），
混在文本里则转成字符串（找不到时为空串，不会出现 `undefined` 字样）。

## 步骤字段

| 字段 | 说明 |
| --- | --- |
| `id` | 步骤名（变量引用用）；缺省 `step1`、`step2`… |
| `plugin` | 插件名（必填） |
| `command` | 子命令（可选） |
| `params` | 参数模板，支持变量 |
| `forEach` | 循环源：变量引用或数组；每轮注入 `${item}` / `${index}` |
| `limit` | forEach 最多处理几条 |
| `concurrency` | forEach 并发（默认 1，串行） |
| `onError` | 本步骤失败策略，覆盖 pipeline 级 |
| `pick` | 只保留 data 里的某个点路径（减小输出体积） |
| `when` | 条件：解析后为假则跳过该步骤 |

## 失败策略

| 值 | 行为 |
| --- | --- |
| `abort`（默认） | 立即中止，后续步骤不执行，整体 `ok: false` |
| `continue` | 记下失败，继续后续步骤，整体仍 `ok: true` |

步骤级 `onError` 覆盖 pipeline 级：

```yaml
onError: abort          # 默认严格
steps:
  - id: optional
    plugin: some-flaky-thing
    onError: continue   # 这一步失败不影响整体
```

forEach 里部分条目失败：该步骤 `ok: false` 并带 `error: "2/5 条失败"`，
但 `items` 里能拿到逐条结果（含成功的）。

## 条件与裁剪

```yaml
steps:
  - id: detail
    plugin: webpage
    when: "${input.deep}"        # deep=false 时整步跳过（skipped: true）
    forEach: "${steps.search.data.results}"
    limit: 3
    concurrency: 2
    pick: "title"                # data 只留 title 字段
    params:
      url: "${item.url}"
```

`pick` 是**相对 data** 的路径（webpage 的 data 是 `{title, h1, links}`，所以写 `title`）。
路径写错不会报错，返回 `undefined`（字段会从 JSON 里消失）。

## 输出

`output` 缺省是 `{ steps: { <id>: 步骤结果 } }`；

自定义则按模板解析：

```yaml
output:
  query: "${input.query}"
  total: "${steps.search.data.total}"
  pages: "${steps.detail.items}"
```

## 命令

```bash
forge pipeline pl.yaml                                # 完整 JSON
forge pipeline pl.yaml -p 'query=rust,limit=3'        # 传输入
forge pipeline pl.yaml --params-file p.json
forge pipeline pl.yaml --dry-run                      # 只打印计划不执行
forge pipeline pl.yaml --stream                       # NDJSON 进度
```

`--stream` 输出：

```jsonl
{"type":"pipeline-start","name":"search-then-read","steps":2}
{"type":"step","step":"search","state":"start"}
{"type":"step","step":"search","state":"ok"}
{"type":"step","step":"detail","state":"start","index":0,"total":3}
{"type":"step","step":"detail","state":"ok"}
{"type":"pipeline-end","ok":true,"ms":6841,"steps":[...]}
{"type":"output","value":{...}}
```

`state`：`start` / `ok` / `fail` / `skip`。

## 挂到调度

```bash
forge schedule add --kind pipeline --name daily --file pl.yaml --cron "0 8 * * *"
forge schedule add --kind pipeline --name hourly --file pl.yaml --every 3600 -p 'region=cn'
```

调度执行时 `-p` 的参数作为 pipeline 的 `input`。

## 边界

- 步骤串行：上一步完成后才进入下一步（forEach 内部可并发）
- 变量只能引用**已完成**步骤的输出（不支持前向引用）
- 未定义步骤的引用返回 `undefined`，不会报错 —— `--dry-run` 先对一遍
- 单次 pipeline 复用同一个浏览器池（受 `FORGE_BROWSER_IDLE_MS` 控制空闲回收）