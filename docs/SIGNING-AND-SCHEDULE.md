# 签名与调度

## 插件签名（Ed25519）

### 三种校验手段的分工

| 手段 | 密钥 | 能证明什么 | 跨机 |
| --- | --- | --- | --- |
| `forge doctor` | 无 | 环境可跑 | — |
| `forge verify` | 无 | 内容与安装时基线一致（防同机静默改动） | 否 |
| `forge trust verify` | Ed25519 | 内容由某私钥持有者签发（证来源） | 是 |

`verify` 管"有没有被本地改过"，`trust verify` 管"是不是他签的"。

### 生成密钥

```bash
forge keygen --signer "石井"
# {
#   "ok": true, "created": true,
#   "keyId": "08da914861f9436e",
#   "privateKey": ".../keys/forge-ed25519.key",
#   "publicKey": ".../keys/forge-ed25519.pub"
# }
```

- 私钥 0600 权限，publicKey 可分发
- `keyId` = `sha256(SPKI DER)` 前 16 位 hex
- 已有密钥时不覆盖（`--force` 才换）

### 签名

```bash
forge sign weather            # 单个
forge sign                    # 全部插件
forge sign --list             # 只看状态
forge sign --export-pub ./pub.pem   # 顺带导出公钥
forge sign weather --key ./other.key   # 指定私钥
```

产物 `<pluginDir>/FORGE.SIG`：

```json
{
  "version": 1,
  "algorithm": "ed25519",
  "digest": "43201aa1291899ed8e2e549c8d99bd3b341628cc659d9042801985afadb41a26",
  "signature": "base64…",
  "keyId": "08da914861f9436e",
  "signer": "石井",
  "at": "2026-11-18T06:05:00.000Z"
}
```

**关键设计**：`FORGE.SIG` 自身不参与内容哈希计算 — 否则签完名再算哈希就会变，永远无法自校验。

### 验签

```bash
forge trust verify              # 全部插件
forge trust verify weather      # 单个
```

四种结果：

| state | 含义 | 处置 |
| --- | --- | --- |
| `signed` | 摘要匹配 + 签名有效 | 通过 |
| `digest-mismatch` | 内容被改（签名是旧的） | 重新安装 / 找签发者 |
| `signed-invalid` | keyId 不匹配或签名伪造 | 拒用 |
| `unsigned` | 没有 FORGE.SIG | 来源不明 |

实测输出：

```
$ forge trust verify weather
signed            weather

# 改一个字节后
$ forge trust verify weather
digest-mismatch   weather  内容与签名时的摘要不符（插件被改动）

# 用别人的私钥重签后
$ forge trust verify weather
signed-invalid    weather  公钥指纹不匹配（签名 keyId=cbe0e75e632b75e4，提供=08da914861f9436e）
```

### 分发与验证（跨机）

签发方：

```bash
forge keygen --signer "publisher"
forge sign my-plugin
forge sign --export-pub ./publisher.pub
# 把 my-plugin 目录 + publisher.pub 一起发出去
```

使用方：

```bash
forge trust import ./publisher.pub     # 按 keyId 归档
forge trust list                       # 确认已导入
forge install ./my-plugin --yes
forge trust verify my-plugin           # 用可信公钥验签
```

### 边界

- 无私钥即无法签名；私钥泄露等于身份被盗
- 公钥信任是**首次导入决定**（TOFU），没有 CA 体系
- `sign` 会覆盖旧签名；同一插件多次签名只保留最后一次

## 内置调度

### 命令

```bash
forge schedule list                    # 看全部
forge schedule add <plugin> --name n --every 3600 -p '...'
forge schedule add <plugin> --name n --cron "0 9 * * 1-5" -p '...'
forge schedule add --kind batch --name b1 --cron "*/30 * * * *" --file tasks.jsonl
forge schedule add <plugin> --kind watch --name w1 --every 600 -p '...' --key url
forge schedule run <name>              # 立即执行一次
forge schedule enable|disable <name>
forge schedule remove <name>
forge schedule daemon                  # 常驻
forge schedule daemon --once           # 单轮（外部 cron 调用方式）
```

### 三种调度类型

| kind | args | 说明 |
| --- | --- | --- |
| `run` | `{ plugin, params }` | 单插件执行 |
| `batch` | `{ file }` | 批量任务文件 |
| `watch` | `{ plugin, params, key? }` | 抓取 + 与快照对比 |

### 时间语义

- `--every <秒>`：固定间隔，从**上次执行完**开始算（不堆积）
- `--cron "<分 时 日 月 周>"`：本地时区五字段
  - 支持 `*`、单值、区间 `1-5`、步长 `*/15`、`1-30/5`、列表 `1,15,30`
  - 日与周都受限时取**或**（标准 cron 语义），否则取**且**

```bash
forge schedule add weather --name hourly --cron "0 * * * *" -p 'city=上海'
forge schedule add news-digest --name morning --cron "0 8 * * *" -p '{}'
forge schedule add exchange-rate --name workday --cron "30 9 * * 1-5" -p 'from=USD,to=CNY'
```

### 存储

`~/.forgeapi/schedules.json`：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "uuid", "name": "hourly", "kind": "run",
      "args": { "plugin": "weather", "params": { "city": "上海" } },
      "everySec": 3600, "enabled": true,
      "createdAt": "...", "runs": 3, "failures": 0,
      "lastRun": "...", "lastStatus": "ok", "lastSummary": "object{地点,当前,预报}",
      "nextRun": "..."
    }
  ]
}
```

### daemon

```bash
forge schedule daemon                    # 默认 15s 轮询
forge schedule daemon --interval 30000   # 30s
forge schedule daemon --once             # 只跑一轮
```

行为：
- 每轮找出 `nextRun <= now` 且启用的条目，依次执行
- 执行后更新 `runs` / `failures` / `lastStatus` / `lastSummary` / `nextRun`
- `SIGINT` / `SIGTERM` 优雅退出（当前批次跑完后停）
- 每次执行同样写调用日志（`forge log` 可查）

常驻化（Windows 计划任务 / systemd / pm2 均可）：

```bash
# 方式 1：外部计划任务每分钟调一次（无状态，最稳）
forge schedule daemon --once

# 方式 2：常驻进程
forge schedule daemon --interval 15000
```

### 边界

- `--every` 最小 10 秒（避免写满日志）
- 调度条目无并发控制：daemon 单实例运行；多实例会重复执行
- 执行失败不自动禁用，`failures` 计数持续累加，便于外部监控告警