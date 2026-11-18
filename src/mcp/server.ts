/**
 * ForgeAPI MCP 服务端 —— 零依赖 JSON-RPC 2.0 over stdio
 *
 * 让 Claude Code / Cursor / 任意 MCP 客户端把每个 forge 插件当成工具调用：
 *   tools/list  → 每个启用插件一个 tool（inputSchema = 插件 schema）
 *   tools/call  → name=<plugin>（或 <plugin>:<sub>），arguments=参数
 *
 * 走 stdout 写 JSON-RPC 消息，stderr 写诊断日志（不污染协议流）。
 */
import type { WorkspacePaths, ForgePlugin, RegistryEntry } from '../core/types.js';
import { ForgeEngine } from '../core/engine.js';
import { Registry, readSkill, readRules } from '../core/registry.js';
import { CallLog } from '../core/calllog.js';
import { Logger } from '../core/log.js';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { VERSION } from '../core/version.js';
import { generateSkill } from '../core/skillgen.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'forgeapi', version: VERSION };

interface RpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType: string;
}

interface McpPrompt {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
}

export interface McpOptions {
  paths: WorkspacePaths;
  log?: (msg: string) => void;
  /** 只暴露指定插件（缺省全部启用） */
  only?: string[];
  /** 是否暴露子命令为独立工具 */
  exposeCommands?: boolean;
}

export class ForgeMcpServer {
  private engine: ForgeEngine;
  private callLog: CallLog;
  private logger: Logger;
  private tools: ToolDef[] = [];
  private toolIndex = new Map<string, { plugin: string; command?: string }>();
  private resources: McpResource[] = [];
  private resourceTemplates: McpResourceTemplate[] = [];
  private prompts: McpPrompt[] = [];
  private opts: McpOptions;

  constructor(opts: McpOptions) {
    this.opts = opts;
    this.engine = new ForgeEngine(opts.paths);
    this.callLog = new CallLog(opts.paths);
    this.logger = new Logger({ quiet: true });
  }

  /** 扫描插件，构建资源表（skill.md / 规则 / 配置样本） */
  async buildResources(): Promise<McpResource[]> {
    const reg = new Registry(this.opts.paths);
    reg.reload();
    const resources: McpResource[] = [];
    const only = this.opts.only && this.opts.only.length ? new Set(this.opts.only) : null;

    for (const entry of reg.enabled()) {
      if (only && !only.has(entry.name)) continue;
      const plugin = entry.name;

      // 磁盘上有 skill.md 或有 schema（可即时生成）都算有文档
      const hasSkill = Boolean(readSkill(entry.dir));
      let hasSchema = fs.existsSync(path.join(entry.dir, 'plugin.json'));
      if (!hasSchema) {
        try {
          const p = await this.engine.load(plugin);
          hasSchema = Boolean(p.schema);
        } catch { /* 加载失败就不列 */ }
      }
      if (hasSkill || hasSchema) {
        resources.push({
          uri: `forge://plugin/${plugin}/skill`,
          name: `${plugin} · skill`,
          description: `插件 ${plugin} 的使用说明书（参数、示例、注意事项）`,
          mimeType: 'text/markdown',
        });
      }
      if (fs.existsSync(path.join(entry.dir, 'plugin.json'))) {
        resources.push({
          uri: `forge://plugin/${plugin}/manifest`,
          name: `${plugin} · plugin.json`,
          description: `插件 ${plugin} 的声明式定义`,
          mimeType: 'application/json',
        });
      }
      const rules = readRules(entry.dir);
      for (const ruleName of Object.keys(rules)) {
        resources.push({
          uri: `forge://plugin/${plugin}/rules/${ruleName}`,
          name: `${plugin} · 规则 ${ruleName}`,
          description: `插件 ${plugin} 的提取规则 ${ruleName}`,
          mimeType: 'application/yaml',
        });
      }
    }

    this.resources = resources;
    this.resourceTemplates = [
      {
        uriTemplate: 'forge://plugin/{plugin}/skill',
        name: '插件 Skill 文档',
        description: '每个插件的 skill.md（Markdown）',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'forge://plugin/{plugin}/rules/{rule}',
        name: '插件提取规则',
        description: '插件 data/rules 下的 YAML 规则',
        mimeType: 'application/yaml',
      },
    ];
    return resources;
  }

  /** 读资源内容 */
  async readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string } | null> {
    const m = /^forge:\/\/plugin\/([^/]+)\/(skill|manifest)$/.exec(uri);
    if (m) {
      const [, plugin, kind] = m;
      const entry = new Registry(this.opts.paths).get(plugin);
      if (!entry) return null;

      if (kind === 'skill') {
        // 优先磁盘上的 skill.md；没有则用 schema 即时生成
        const onDisk = readSkill(entry.dir);
        if (onDisk) return { uri, mimeType: 'text/markdown', text: onDisk };
        try {
          const p = await this.engine.load(plugin);
          const md = generateSkill(p, { rules: readRules(entry.dir) });
          return { uri, mimeType: 'text/markdown', text: md };
        } catch {
          return null;
        }
      }

      const f = path.join(entry.dir, 'plugin.json');
      if (!fs.existsSync(f)) return null;
      return { uri, mimeType: 'application/json', text: fs.readFileSync(f, 'utf8') };
    }

    const r = /^forge:\/\/plugin\/([^/]+)\/rules\/(.+)$/.exec(uri);
    if (r) {
      const [, plugin, ruleName] = r;
      const entry = new Registry(this.opts.paths).get(plugin);
      if (!entry) return null;
      const rules = readRules(entry.dir);
      const rule = rules[ruleName];
      if (!rule) return null;
      return { uri, mimeType: 'application/yaml', text: yaml.dump(rule) };
    }

    return null;
  }

  /** 常用工作流模板 */
  buildPrompts(): McpPrompt[] {
    this.prompts = [
      {
        name: 'webpage_extract',
        description: '从指定网页按 CSS/XPath 规则抽取结构化字段',
        arguments: [
          { name: 'url', description: '目标网页地址', required: true },
          { name: 'fields', description: '想要的字段（逗号分隔，如 标题,价格）', required: false },
        ],
      },
      {
        name: 'search_multi',
        description: '多来源（HN/Wikipedia/GitHub）搜索并合并去重',
        arguments: [
          { name: 'query', description: '搜索关键词', required: true },
          { name: 'limit', description: '每来源条数', required: false },
        ],
      },
      {
        name: 'news_brief',
        description: '抓取多源新闻，按关键词过滤后按时序出简报',
        arguments: [
          { name: 'keyword', description: '过滤关键词（可选）', required: false },
          { name: 'limit', description: '总条数', required: false },
        ],
      },
      {
        name: 'data_service',
        description: '调用公开服务（天气/汇率/翻译/维基）取结构化结果',
        arguments: [
          { name: 'service', description: 'weather | exchange-rate | translate | wiki-summary', required: true },
          { name: 'params', description: '该服务的参数 JSON', required: true },
        ],
      },
    ];
    return this.prompts;
  }

  /** 渲染 prompt */
  getPrompt(name: string, args: Record<string, string>): object | null {
    const tool = (n: string) => `forge_${n}`;
    const call = (n: string, params: Record<string, unknown>) =>
      `调用 \`${tool(n)}\`，参数 ${JSON.stringify(params)}，读取返回 JSON 的 data 字段。`;

    switch (name) {
      case 'webpage_extract': {
        const url = args.url || '<URL>';
        const fields = args.fields || '标题,摘要,链接';
        return {
          description: `抽取 ${url} 的字段：${fields}`,
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: [
                `目标网页：${url}`,
                `需要字段：${fields}`,
                '',
                '步骤：',
                `1. 先 \`resources/read\` 读 forge://plugin/webpage/skill 了解规则写法。`,
                `2. ${call('webpage', { url })}`,
                '3. 若默认字段不够，用 forge_rule 写入自定义 YAML 规则再带 rule 参数重跑。',
                '4. 把结果整理成表格；缺失字段标 null，不要编造。',
              ].join('\n'),
            },
          }],
        };
      }

      case 'search_multi': {
        const q = args.query || '<QUERY>';
        const limit = args.limit || '10';
        return {
          description: `多来源搜索：${q}`,
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: [
                `查询：${q}，每来源 ${limit} 条。`,
                call('search-aggregate', { query: q, sources: 'hn,wiki,github', limit: Number(limit) }),
                '按 score 降序整理；合并来源标记出来源集合；对同一结果不同来源的摘要做择优。',
              ].join('\n'),
            },
          }],
        };
      }

      case 'news_brief': {
        const kw = args.keyword ? `关键词「${args.keyword}」` : '全部';
        const limit = args.limit || '10';
        return {
          description: `新闻简报（${kw}）`,
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: [
                `抓取 ${kw} 的新闻，总量 ${limit}。`,
                call('news-digest', { ...(args.keyword ? { keyword: args.keyword } : {}), limit: 15, total: Number(limit) }),
                '按时间倒序输出为简报：每条一行「时间 | 来源 | 标题 | 链接」。',
              ].join('\n'),
            },
          }],
        };
      }

      case 'data_service': {
        const svc = args.service || 'weather';
        return {
          description: `公开服务调用：${svc}`,
          messages: [{
            role: 'user',
            content: {
              type: 'text',
              text: [
                `服务：${svc}`,
                `参数：${args.params || '{}'}`,
                call(svc, JSON.parse(args.params || '{}')),
                `若该服务报错，先 resources/read forge://plugin/${svc}/skill 核对参数。`,
              ].join('\n'),
            },
          }],
        };
      }

      default:
        return null;
    }
  }

  /** 扫描插件，构建工具表 */
  async buildTools(): Promise<ToolDef[]> {
    const reg = new Registry(this.opts.paths);
    reg.reload();
    const tools: ToolDef[] = [];
    this.toolIndex.clear();
    const only = this.opts.only && this.opts.only.length ? new Set(this.opts.only) : null;
    const exposeCommands = this.opts.exposeCommands !== false;

    for (const entry of reg.enabled()) {
      if (only && !only.has(entry.name)) continue;
      let plugin: ForgePlugin;
      try {
        plugin = await this.engine.load(entry.name);
      } catch (e) {
        this.opts.log?.(`跳过插件 ${entry.name}: ${(e as Error).message}`);
        continue;
      }
      const desc = buildDescription(plugin);
      const toolName = sanitizeToolName(entry.name);
      tools.push({ name: toolName, description: desc, inputSchema: normalizeSchema(plugin.schema) });
      this.toolIndex.set(toolName, { plugin: entry.name });

      if (exposeCommands && plugin.commands?.length) {
        for (const c of plugin.commands) {
          const subName = sanitizeToolName(`${entry.name}__${c.name}`);
          tools.push({
            name: subName,
            description: `${c.description || c.name}（插件 ${entry.name} 的子命令）`,
            inputSchema: normalizeSchema(c.schema || plugin.schema),
          });
          this.toolIndex.set(subName, { plugin: entry.name, command: c.name });
        }
      }
    }
    this.tools = tools;
    return tools;
  }

  /** 处理一条 JSON-RPC 消息，返回响应（通知返回 null） */
  async handle(msg: RpcRequest): Promise<object | null> {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    const ok = (result: unknown) => ({ jsonrpc: '2.0' as const, id, result });
    const err = (code: number, message: string, data?: unknown) => ({
      jsonrpc: '2.0' as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) },
    });

    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: true },
              resources: { listChanged: false, subscribe: false },
              prompts: { listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions: [
              'ForgeAPI 把网页与公开服务封装成工具。',
              'tools/list 看可用工具（每个工具= 一个 forge 插件）；tools/call 直接执行。',
              'resources/list 可读每个插件的 skill.md（URI: forge://plugin/<name>/skill）与规则。',
              'prompts/list 有常用工作流模板（搜索、网页提取、论坛抓取…）。',
              '返回值为 JSON 文本；ok=false 时 error 字段说明原因。',
            ].join(' '),
          });

        case 'notifications/initialized':
        case 'initialized':
          return null;

        case 'ping':
          return ok({});

        case 'tools/list': {
          if (!this.tools.length) await this.buildTools();
          return ok({ tools: this.tools });
        }

        case 'tools/call': {
          const name = String(params?.name || '');
          const args = (params?.arguments || {}) as Record<string, unknown>;
          // 客户端可能跳过 tools/list 直接调用 → 惰性构建工具索引
          if (!this.toolIndex.size) await this.buildTools();
          const target = this.toolIndex.get(name);
          if (!target) {
            // 允许直接按插件原名调用
            const direct = sanitizeToolName(name);
            const t2 = this.toolIndex.get(direct);
            if (!t2) return err(-32602, `未知工具: ${name}（先 tools/list）`);
            return ok(await this.callTool(direct, t2, args));
          }
          return ok(await this.callTool(name, target, args));
        }

        case 'resources/list': {
          if (!this.resources.length) await this.buildResources();
          return ok({ resources: this.resources });
        }

        case 'resources/templates/list': {
          if (!this.resources.length) await this.buildResources();
          return ok({ resourceTemplates: this.resourceTemplates });
        }

        case 'resources/read': {
          const uri = String(params?.uri || '');
          const content = await this.readResource(uri);
          if (!content) return err(-32602, `未知资源: ${uri}（先 resources/list）`);
          return ok({ contents: [content] });
        }

        case 'prompts/list': {
          if (!this.prompts.length) this.buildPrompts();
          return ok({ prompts: this.prompts });
        }

        case 'prompts/get': {
          const name = String(params?.name || '');
          const args = (params?.arguments || {}) as Record<string, string>;
          const msg = this.getPrompt(name, args);
          if (!msg) return err(-32602, `未知 prompt: ${name}（先 prompts/list）`);
          return ok(msg);
        }

        case 'shutdown':
          return ok({});

        default:
          if (isNotification) return null;
          return err(-32601, `未实现的方法: ${method}`);
      }
    } catch (e) {
      const m = (e as Error).message;
      this.opts.log?.(`处理 ${method} 失败: ${m}`);
      return isNotification ? null : err(-32603, m);
    }
  }

  private async callTool(name: string, target: { plugin: string; command?: string }, args: Record<string, unknown>) {
    const t0 = Date.now();
    const out = await this.engine.run(target.plugin, {
      params: args,
      command: target.command,
      logger: this.logger,
      reuseBrowser: true, // 常驻服务：复用 Chromium
    });
    this.callLog.append(this.callLog.newEntry({
      plugin: target.plugin,
      command: target.command,
      params: args,
      ok: out.ok,
      ms: out.ms,
      summary: out.ok ? summarizeData(out.data) : (out.error || '').slice(0, 200),
      error: out.error?.slice(0, 2000),
      exitCode: out.ok ? 0 : 1,
    }));

    const payload = out.ok
      ? { ok: true, data: out.data ?? null, meta: out.meta ?? null, ms: out.ms }
      : { ok: false, error: out.error ?? '未知错误', ms: out.ms };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: !out.ok,
      _meta: { plugin: target.plugin, command: target.command, ms: Date.now() - t0 },
    };
  }

  /** stdio 主循环 */
  async serveStdio(): Promise<void> {
    await this.buildTools();
    this.opts.log?.(`MCP ready: ${this.tools.length} tools`);

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let buffered = '';

    const write = (obj: object) => {
      process.stdout.write(JSON.stringify(obj) + '\n');
    };

    // 逐行解析（兼容 LSP 风格 Content-Length 与纯行分隔）
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith('Content-Length:')) return; // LSP 头，忽略
      if (trimmed.toLowerCase().startsWith('content-type:')) return;

      let msg: RpcRequest;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        buffered += trimmed;
        try { msg = JSON.parse(buffered); buffered = ''; } catch { return; }
      }

      void this.handle(msg).then((res) => { if (res) write(res); }).catch((e) => {
        write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } });
      });
    });

    await new Promise<void>((resolve) => {
      rl.on('close', () => resolve());
      process.on('SIGINT', () => resolve());
      process.on('SIGTERM', () => resolve());
    });
  }
}

function sanitizeToolName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function normalizeSchema(schema: any): unknown {
  const s = schema && typeof schema === 'object' ? schema : {};
  return {
    type: 'object',
    properties: (s.properties && typeof s.properties === 'object') ? s.properties : {},
    ...(Array.isArray(s.required) && s.required.length ? { required: s.required } : {}),
    additionalProperties: false,
  };
}

function buildDescription(p: ForgePlugin): string {
  const parts = [p.description || p.name];
  if (p.commands?.length) parts.push(`子命令: ${p.commands.map((c) => c.name).join(', ')}`);
  const perms = (p.permissions || []).filter((x) => x !== 'net');
  if (perms.length) parts.push(`权限: ${perms.join(', ')}`);
  return parts.join(' | ').slice(0, 900);
}

function summarizeData(d: unknown): string {
  if (Array.isArray(d)) return `array(${d.length})`;
  if (d && typeof d === 'object') {
    const k = Object.keys(d as object);
    return `object{${k.slice(0, 6).join(',')}${k.length > 6 ? '…' : ''}}`;
  }
  return String(d).slice(0, 100);
}