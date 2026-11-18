# 架构说明

## 分层

```
CLI (src/cli)              命令解析、参数合并、日志落盘、退出码
  ├─ bootstrap.ts           init：内置插件安装 + 模板播种
  └─ index.ts               commander 命令表

核心 (src/core)
  ├─ types.ts               契约：ForgePlugin / DeclarativePlugin / SessionStep / MergeDef
  ├─ workspace.ts           路径解析、配置读写、原子写
  ├─ registry.ts            插件注册表 + 目录探测（manifest/入口/skill/rules）
  ├─ installer.ts           安装（目录/tgz/清单/URL/仓库）、卸载、权限确认、依赖自动装、基线哈希
  ├─ engine.ts              加载插件 + 上下文注入 + 声明式执行（extract/aggregate/flow）
  ├─ browser.ts             Playwright 封装：惰性启动、会话步骤、提取、cookie
  ├─ browserpool.ts         Chromium 进程池（进程内复用、代理绕过 loopback、空闲回收）
  ├─ extract.ts             选择器引擎：CSS/JSONPath/正则 + 变量插值
  ├─ aggregate.ts           合并策略：concat / dedupe_by_title / dedupe_by_key / first_nonempty
  ├─ concurrency.ts         mapLimit（限并发保持顺序）+ ResultCache（LRU+TTL）
  ├─ scheduler.ts           批量任务调度（并发/重试/限速/超时/落盘）
  ├─ pipeline.ts            工作流编排（变量引用、forEach、when、pick、onError）
  ├─ schedule.ts            cron 解析 + 调度条目（every/cron，run/batch/watch/pipeline）
  ├─ signing.ts             Ed25519 签名与验签、可信公钥链
  ├─ integrity.ts           目录内容哈希、完整性校验、基线锁定
  ├─ diff.ts                结果差异（对齐键识别、快照读写）
  ├─ credentials.ts         AES-256-GCM 凭据库（scrypt 派生）
  ├─ calllog.ts             JSONL 调用日志（按天分文件，可裁剪）
  ├─ skillgen.ts            插件 → Skill Markdown
  ├─ templates.ts           模板库（本地 index + 远端 registry + builtin: 解析）
  ├─ version.ts             版本号单一来源（读 package.json）
  └─ log.ts                 分级日志（stderr）

MCP (src/mcp)
  ├─ server.ts              JSON-RPC 2.0：tools / resources / prompts
  └─ index.ts               stdio 入口

Web (src/server)
  ├─ index.ts               http 服务 + REST 路由 + 静态资源
  ├─ webassets.ts           内嵌前端资源生成（index.html/app.js/style.css）
  └─ ../web/                运行时落地的前端

测试 (src/test)
  extract / aggregate / core 三组 node:test
```

## 关键决策

**1. 声明式优先，代码兜底**
模板与常见站点用 `plugin.json` 描述，零代码；需要任意逻辑时写 `index.mjs`。
两者共用 `ForgePlugin` 契约，引擎只认 `execute`。

**2. 浏览器惰性启动 + 每插件一 context**
插件不调用 `ctx.browser` 就不启动 Chromium；同一插件多次调用复用 context，
cookie 落 `data/<plugin>/cookies.json`，下次自动加载。

**3. 提取双通道**
- HTML 字符串通道：cheerio，支持 CSS / 正则 / 属性 / 列表
- 页面 DOM 通道：字段树含 XPath 时在 `page.evaluate` 内跑，支持 CSS + XPath + 相对选择器

**4. 插件隔离**
`dataDir` 每插件独立；凭据按 `plugin:key` 命名空间加密存储，
`getCredential` 只能读本插件键。

**5. 输出稳定**
stdout 只有结果 JSON（`{ok,data,error,meta,ms}`），日志全部走 stderr，
方便 AI/管道直接 `jq` 消费。

## 执行流（run）

```
forge run X -p '{...}'
  → CLI 合并参数（--params JSON 或 k=v）
  → engine.run：
      registry.reload()      # 复核启用状态（缓存不绕过 disable）
      load(X)                # 代码型 import；声明式包装成 ForgePlugin
      makeContext(X)         # dataDir / vault / browser / logger / progress
      execute or command 命中
      finally browser.close()
  → 结果写 stdout + CallLog 追加一行
```

## 声明式执行分支

| type | 行为 |
| --- | --- |
| `extract` | 解析 `params.rule > def.rule > def.fields`，浏览器打开 URL 后按字段树抽取 |
| `flow` | 按 `steps[]` 顺序执行，`extract` 步骤结果并入输出键 |
| `aggregate` | 并发/顺序拉取 `sources[]`（api/webpage/code/json），按 `merge` 合并 |

来源失败策略：`optional` 不影响整体成功，错误记进 `sources[].error`。

## 安全模型

- 凭据：AES-256-GCM + scrypt(N=16384,r=8,p=1)，verifier 校验主密码，支持 lock/unlock
- 权限：安装期声明 + 交互确认（`--yes` 跳过），运行时不做系统级沙箱
- 日志：参数与错误截断存储（summary 200 字符 / error 2000 字符）
- Web：默认仅监听 127.0.0.1，CORS 全开用于本地 GUI 调试