import type { ForgePlugin, JSONSchema, JSONSchemaProp } from './types.js';

/** 从插件生成 Skill 文档（Markdown）——AI 直接可读 */
export function generateSkill(plugin: ForgePlugin, extra?: { rules?: Record<string, unknown> }): string {
  const lines: string[] = [];
  lines.push(`# ${plugin.name} v${plugin.version}`);
  lines.push('');
  lines.push(`> ${plugin.description || '（无描述）'}`);
  lines.push('');
  lines.push('## 用途');
  lines.push('');
  lines.push(plugin.skill?.trim() || `${plugin.name} 是 ForgeAPI 插件，按下方参数调用。`);
  lines.push('');
  lines.push('## 调用方式');
  lines.push('');
  lines.push('```bash');
  lines.push(`forge run ${plugin.name} --params '<JSON>'`);
  if (plugin.commands?.length) {
    for (const c of plugin.commands) {
      lines.push(`forge ${plugin.name} ${c.name} --params '<JSON>'   # ${c.description}`);
    }
  }
  lines.push('```');
  lines.push('');
  lines.push('## 参数');
  lines.push('');
  lines.push(schemaTable(plugin.schema));
  lines.push('');
  lines.push('## 参数 Schema（JSON）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(plugin.schema, null, 2));
  lines.push('```');

  if (plugin.commands?.length) {
    lines.push('');
    lines.push('## 子命令');
    lines.push('');
    for (const c of plugin.commands) {
      lines.push(`### ${plugin.name} ${c.name}`);
      lines.push('');
      lines.push(c.description);
      lines.push('');
      if (c.schema) {
        lines.push(schemaTable(c.schema));
        lines.push('');
      }
    }
  }

  if (plugin.permissions?.length) {
    lines.push('');
    lines.push('## 权限');
    lines.push('');
    for (const p of plugin.permissions) lines.push(`- ${p}：${PERM_DESC[p] || p}`);
  }

  if (extra?.rules && Object.keys(extra.rules).length) {
    lines.push('');
    lines.push('## 附带规则');
    lines.push('');
    for (const [name, r] of Object.entries(extra.rules)) {
      lines.push(`### ${name}`);
      lines.push('');
      lines.push('```yaml');
      lines.push(toYamlLite(r));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('');
  lines.push('## 输出');
  lines.push('');
  lines.push('stdout 输出 JSON：`{ ok, data, error?, meta?, ms }`。失败时 `ok=false` 且 `error` 有信息，退出码非 0。');
  lines.push('');
  return lines.join('\n');
}

const PERM_DESC: Record<string, string> = {
  net: '发起 HTTP 请求',
  browser: '启动无头浏览器',
  'fs-read': '读取本地文件',
  'fs-write': '写入本地文件',
  credential: '读取本插件凭据',
  exec: '启动子进程',
};

function schemaTable(schema: JSONSchema): string {
  const props = schema.properties || {};
  const req = new Set(schema.required || []);
  const rows: string[] = ['| 参数 | 类型 | 必填 | 说明 |', '| --- | --- | --- | --- |'];
  for (const [k, v] of Object.entries(props)) {
    rows.push(`| \`${k}\` | ${typeName(v)} | ${req.has(k) ? '是' : '否'} | ${(v.description || '').replace(/\|/g, '\\|')}${v.default !== undefined ? ` 默认: \`${JSON.stringify(v.default)}\`` : ''} |`);
  }
  if (rows.length === 2) rows.push('| （无参数） | - | - | - |');
  return rows.join('\n');
}

function typeName(p: JSONSchemaProp): string {
  if (!p.type) return 'any';
  if (p.type === 'array') return `array<${p.items ? typeName(p.items) : 'any'}>`;
  if (p.type === 'object' && p.properties) return 'object';
  if (p.enum) return `enum(${p.enum.map((e) => JSON.stringify(e)).join('|')})`;
  return p.type;
}

function toYamlLite(v: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return /[:#\n]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((x) => (typeof x === 'object' && x !== null
      ? `\n${pad}- ${toYamlLite(x, indent + 2).trimStart()}`
      : `${pad}- ${toYamlLite(x, indent + 2)}`)).join('\n');
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  return entries.map(([k, val]) => {
    if (val && typeof val === 'object') {
      return `${pad}${k}:\n${toYamlLite(val, indent + 2)}`;
    }
    return `${pad}${k}: ${toYamlLite(val, indent + 2)}`;
  }).join('\n');
}
