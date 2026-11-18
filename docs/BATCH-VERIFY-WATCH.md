# 批量 / 校验 / 监控

## 批量任务（`forge batch`）

### 任务文件

JSON 数组：

```json
[
  { "id": "w1", "plugin": "weather", "params": { "lat": 31.23, "lon": 121.47, "days": 1 } },
  { "id": "r1", "plugin": "exchange-rate", "params": { "from": "USD", "to": "CNY" } },
  { "id": "g1", "plugin": "weather", "command": "geocode", "params": { "city": "Kyoto" } }
]
```

JSONL（每行一个，`#` 开头为注释，空行跳过）：

```jsonl
# 天气批量
{"id":"w1","plugin":"weather","params":{"lat":31.23,"lon":121.47}}
{"id":"w2","plugin":"weather","params":{"lat":39.90,"lon":116.40}}
```

字段：`plugin`（必填）、`command`（子命令）、`params`（对象）、`id`（标签，回显用）。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-c, --concurrency` | 3 | 并发任务数 |
| `-r, --retry` | 1 | 每个任务最多尝试次数（含首次） |
| `--retry-delay` | 400 | 重试基础退避毫秒（指数增长：400 → 800 → 1600…） |
| `--rate` | 0 | 每秒最多启动任务数（0 = 不限）；并发下依然生效 |
| `--timeout` | 无 | 单任务超时毫秒 |
| `--out <file>` | 无 | 结果追加写入 JSONL |
| `--stream` | 关 | NDJSON 逐条输出 |
| `--json` | 关 | 整批结果一次性 JSON |

### 输出

默认（人类可读）：

```
批量完成：4 个任务，成功 3，失败 1
weather              ok=1 fail=0
exchange-rate        ok=1 fail=0

失败明细：
  #3 no-such-plugin(bad): 插件未安装: no-such-plugin
```

`--json`：

```json
{
  "ok": false,
  "summary": {
    "total": 4, "ok": 3, "fail": 1, "ms": 3210,
    "byPlugin": { "weather": { "ok": 1, "fail": 0 }, "no-such-plugin": { "ok": 0, "fail": 1 } },
    "failures": [{ "index": 3, "plugin": "no-such-plugin", "id": "bad", "error": "插件未安装: no-such-plugin" }]
  },
  "results": [ /* 逐条：index/task/ok/data|error/ms/attempts */ ]
}
```

`--stream`（NDJSON，适合长任务实时处理）：

```jsonl
{"type":"batch-start","total":4,"concurrency":3,"at":"..."}
{"type":"progress","state":"start","index":0,"total":4,"plugin":"weather","id":"w1"}
{"type":"progress","state":"ok","index":0,...}
{"type":"result","index":0,"plugin":"weather","id":"w1","ok":true,"ms":812,"attempts":1,"data":{...}}
{"type":"batch-end","total":4,"ok":3,"fail":1,...}
```

`progress.state`：`start` / `ok` / `fail` / `retry`。

### 语义保证

- 结果顺序 = 任务文件顺序（按 index 回填，不按完成先后）
- 失败任务在摘要里给出 index / plugin / id / error
- 每个任务同样写调用日志（`forge log` 可查）
- 批量结束统一关闭浏览器池

## 完整性校验（`forge verify`）

安装插件时自动计算目录内容哈希（相对路径 + 文件内容的 sha256 聚合），
连同逐文件摘要一起写入 `plugins.json`：

```json
{
  "name": "weather",
  "integrity": "43201aa1291899ed8e…",
  "integrityFiles": [{ "file": "index.mjs", "sha256": "…" }],
  "integrityAt": "2026-11-18T05:20:00.000Z"
}
```

### 用法

```bash
forge verify                # 校验全部
forge verify weather        # 单个
forge verify --json         # 机器可读
forge verify weather --fix  # 有意改动后，把当前状态写为新基线
```

输出：

```
[OK]   weather  43201aa12918…

[FAIL] weather  内容与基线不一致
       基线 43201aa12918…  实际 df6b05d139a9…
       - index.mjs（内容变更）
       若为有意改动：forge verify <name> --fix
```

变更类型：`内容变更` / `新增` / `缺失`。

### 边界

- 跳过 `node_modules`、`.git`、`.cache`、`dist`、`package-lock.json` — 这些是运行期产物，不应影响基线
- **不是密码学签名**：无密钥，只能发现"相对安装时的静默改动"，不能证明来源可信
- 基线随安装刷新；用 `--fix` 手动刷新

## 结果监控（`forge watch`）

同一目标多次抓取，对比差异。

```bash
forge watch hn-search demo -p 'query=rust,limit=3'   # 首跑建基线
forge watch hn-search demo -p 'query=rust,limit=5'   # 二跑出差异
forge watch hn-search demo --reset                    # 清快照
```

输出：

```
对比 demo：3 → 5 条
新增 2，删除 0，变更 0，未变 3

新增：
  + Announcing Rust 1.0
  + CityBound – An open source city simulation game in Rust
```

### 对齐键

优先级：`--key` 指定 > `url` > `link` > `链接` > `id` > `guid` > `title` > `标题` > `name` > 结构哈希。

结构哈希兜底：对象键排序后 JSON 序列化，因此**键顺序不同不算变更**。

```bash
forge watch price-compare p1 -p '{"query":"键盘","demos":true}' --key title --fields price
```

### 快照

`~/.forgeapi/data/<plugin>/snapshots/<name>.json`，内容 `{ at, items }`。
每个 `<plugin, name>` 组合一份，互不干扰。

### 输出（`--json`）

```json
{
  "ok": true,
  "baseline": false,
  "diff": {
    "key": "auto",
    "added": [ /* 新出现的条目 */ ],
    "removed": [ /* 消失的条目 */ ],
    "changed": [ { "key": "https://…", "before": {...}, "after": {...}, "fields": ["price"] } ],
    "unchanged": 12,
    "counts": { "before": 15, "after": 17 }
  },
  "snapshot": "…/snapshots/demo.json"
}
```

## 组合用法

**定时监控（外部 cron / 计划任务）**：

```bash
# 每小时抓一次，有变化就发通知
forge watch news-digest feed --json | jq -e '.diff.added | length > 0' && notify-send "有新内容"
```

**批量抓取 + 完整性校验（CI）**：

```bash
forge verify --json | jq -e '[.items[] | select(.ok == false)] | length == 0' || exit 1
forge batch tasks.jsonl -c 8 --out results.jsonl
```