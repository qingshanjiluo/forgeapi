# 插件开发指南

## 插件形态与入口优先级

引擎按以下顺序探测插件目录：

| 优先级 | 文件 | 类型 |
| --- | --- | --- |
| 1 | `plugin.json` / `plugin.yaml` / `plugin.yml` / `forge.json` / `forge.yaml` | 声明式 |
| 2 | `index.mjs` / `index.js` / `main.mjs` / `main.js` | 代码型（ESM） |
| 3 | `dist/index.js` | 代码型（编译产物） |
| 4 | `index.ts` / `main.ts` | 代码型（Node ≥22.6 原生 type-stripping） |

`.ts` 入口依赖 Node 内置的类型擦除，无需预编译——适合快速迭代；
类型复杂（enum / namespace / 装饰器）时改用 `tsc` 编译到 `dist/index.js`。

## 最小代码型插件

目录：`my-plugin/`

**plugin-meta 可省略**，元信息直接写在 `index.mjs` 里：

```js
export default {
  name: 'my-plugin',
  version: '0.1.0',
  description: '一句话说清它做什么',
  permissions: ['net'],
  schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: '查询词' },
      limit: { type: 'integer', description: '条数', default: 10 },
    },
    required: ['q'],
  },
  async execute(params, ctx) {
    ctx.progress('开始查询');
    const r = await fetch(`https://api.example.com/search?q=${encodeURIComponent(params.q)}&n=${params.limit ?? 10}`);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, data: await r.json() };
  },
};
```

安装：

```bash
forge install ./my-plugin
forge run my-plugin --params '{"q":"test"}'
forge skill my-plugin --write ./my-plugin/skill.md
```

## ctx API

| 成员 | 说明 |
| --- | --- |
| `ctx.plugin` | 插件名 |
| `ctx.dataDir` | 本插件私有数据目录（自动创建） |
| `ctx.paths` | 工作区路径集合 |
| `ctx.getCredential(key)` | 读本插件凭据；库锁定/无键返回 undefined |
| `ctx.setCredential(key, val)` | 写凭据（需已解锁） |
| `ctx.log(level, msg, extra?)` | level: info/warn/error/debug |
| `ctx.progress(msg)` | 进度（CLI stderr / Web 调试面板实时显示） |
| `ctx.browser` | Playwright 封装，见下 |
| `ctx.config` | 全局配置只读副本 |

## browser API

```js
const page = await ctx.browser.page();          // 惰性启动 Chromium
await page.goto('https://x', { waitUntil: 'domcontentloaded' });

// 完整会话
const out = await ctx.browser.runSteps([
  { action: 'goto', url: 'https://x/login' },
  { action: 'fill', selector: '#u', value: 'user' },
  { action: 'click', selector: 'button[type=submit]' },
  { action: 'waitFor', selector: '.dash' },
  { action: 'extract', key: 'items', fields: [{ name: 't', selector: 'h2' }] },
], { extraVar: 1 });

// 单页提取
const data = await ctx.browser.fetchExtract('https://x', [
  { name: '标题', selector: 'h1' },
  { name: '价格', selector: '.price', type: 'number' },
]);

// cookie
await ctx.browser.saveCookies();        // 默认 data/<plugin>/cookies.json
await ctx.browser.loadCookies();
await ctx.browser.close();              // 引擎会自动调用
```

## 子命令

插件可注册子命令，CLI 形态：`forge run <plugin> <子命令>` 或 `forge <plugin> <子命令>`。

```js
commands: [
  {
    name: 'detail',
    description: '取详情',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async handler(params, ctx) {
      return { ok: true, data: { id: params.id } };
    },
  },
]
```

## 声明式插件速查

### 单页提取

```json
{
  "name": "p", "version": "0.1.0", "description": "d",
  "type": "extract",
  "schema": { "type": "object", "properties": { "url": {"type":"string"} }, "required": ["url"] },
  "url": "${url}",
  "fields": [
    { "name": "标题", "selector": "h1" },
    { "name": "价格", "selector": ".price", "type": "number" },
    { "name": "节点", "selector": ".item", "type": "list", "fields": [{ "name": "文", "selector": ".t" }] }
  ]
}
```

### 聚合

```json
{
  "name": "agg", "version": "0.1.0", "description": "d",
  "type": "aggregate",
  "sources": [
    { "name": "a", "type": "api", "url": "https://a/api", "params": {"q": "${query}"}, "jsonpath": "$.items", "optional": true },
    { "name": "b", "type": "webpage", "url": "https://b/s?q=${query}", "rule": "list-rule" },
    { "name": "c", "type": "code", "code": "return [{title:'本地' + params.query}];" }
  ],
  "merge": { "strategy": "dedupe_by_title", "fields": ["title","url"], "limit": 30 },
  "output": { "fields": ["title","url","来源"] }
}
```

来源类型：`api` / `json` / `webpage` / `code`。
`code` 来源在 `new Function('params','ctx', ...)` 内执行，返回数组或包装对象。

### 会话流

```json
{
  "name": "flow1", "version": "0.1.0", "description": "d",
  "type": "flow",
  "steps": [
    { "action": "goto", "url": "${base}/login" },
    { "action": "fill", "selector": "#u", "value": "${cred:USERNAME}" },
    { "action": "fill", "selector": "#p", "value": "${cred:PASSWORD}" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "waitFor", "selector": ".user-menu" },
    { "action": "cookie-save" },
    { "action": "goto", "url": "${base}" },
    { "action": "extract", "key": "topics", "fields": [{ "name": "t", "selector": ".topic-title" }] }
  ]
}
```

## 编写 Skill 文档

`skill.md` 是给 AI 看的，必须包含：
1. 一句话用途
2. 可复制的调用命令
3. 参数表（名 / 类型 / 必填 / 说明 / 默认）
4. 输出 JSON 示例
5. 注意事项（登录要求、限频、选择器依赖）

`forge skill <plugin>` 会自动从 `schema` 生成参数表与 JSON Schema 段落；
手写 `skill.md` 优先（声明式插件会读取它）。

## 规则文件

放 `data/<plugin>/rules/*.yaml`，用 `forge rule <plugin> <name> --file x.yaml` 写入。

```yaml
root: ".grid"          # 可选容器
fields:
  - name: 标题
    selector: "h1"
    type: text
  - name: 价格
    selector: ".price"
    type: number
  - name: 链接
    selector: "//a[@rel='next']"
    kind: xpath
    type: url
```

## 调试

```bash
forge run my-plugin -p '{...}' -v        # 详细日志
forge serve                              # Web 调试面板有实时 progress
forge log -n 20 --plugin my-plugin       # 历史调用
forge cfg my-plugin                      # 私有配置
```

## 提交发布

```bash
tar -czf my-plugin.tgz my-plugin/
forge install ./my-plugin.tgz -y
forge template export my-plugin          # 进本地模板库
```