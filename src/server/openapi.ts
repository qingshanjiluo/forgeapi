/**
 * OpenAPI 3.0 描述 —— 把 ForgeAPI 的 REST 接口与插件契约对外声明
 * 让非 AI 程序（脚本、其他服务）也能自动生成客户端
 */
import type { WorkspacePaths } from '../core/types.js';
import { Registry } from '../core/registry.js';
import { VERSION } from '../core/version.js';

export function buildOpenApi(paths: WorkspacePaths): Record<string, unknown> {
  const reg = new Registry(paths);
  reg.reload();

  const plugins = reg.all().map((e) => e.name);

  return {
    openapi: '3.0.3',
    info: {
      title: 'ForgeAPI',
      version: VERSION,
      description: '把网页与公开服务封装成接口。CLI 与 MCP 共用同一套插件注册表。',
    },
    servers: [{ url: 'http://127.0.0.1:7842', description: '本地控制台' }],
    tags: [
      { name: 'plugins', description: '插件管理' },
      { name: 'run', description: '执行' },
      { name: 'pipeline', description: '工作流编排' },
      { name: 'logs', description: '调用日志' },
      { name: 'config', description: '配置与凭据' },
      { name: 'templates', description: '模板库' },
    ],
    paths: {
      '/api/health': {
        get: {
          tags: ['config'], summary: '健康检查',
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } } },
        },
      },
      '/api/plugins': {
        get: {
          tags: ['plugins'], summary: '列出插件',
          responses: { '200': { description: '插件数组', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } } },
        },
      },
      '/api/plugins/{name}': {
        get: {
          tags: ['plugins'], summary: '插件详情（schema / skill / config / rules）',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' }, '404': { description: '未找到' } },
        },
        delete: {
          tags: ['plugins'], summary: '卸载插件',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/plugins/{name}/enable': {
        post: {
          tags: ['plugins'], summary: '启用插件',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/plugins/{name}/disable': {
        post: {
          tags: ['plugins'], summary: '禁用插件',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/plugins/{name}/schema': {
        get: {
          tags: ['plugins'], summary: '参数 Schema（JSON Schema）',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/plugins/{name}/skill': {
        get: {
          tags: ['plugins'], summary: 'Skill 文档（Markdown）',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'markdown', content: { 'text/markdown': { schema: { type: 'string' } } } } },
        },
      },
      '/api/plugins/{name}/config': {
        get: {
          tags: ['plugins'], summary: '读插件私有配置',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
        put: {
          tags: ['plugins'], summary: '写插件私有配置（合并）',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { config: { type: 'object' }, merge: { type: 'boolean' } } } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/plugins/{name}/rules': {
        get: {
          tags: ['plugins'], summary: '列出插件提取规则',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          responses: { '200': { description: 'ok' } },
        },
        post: {
          tags: ['plugins'], summary: '写入提取规则（YAML 校验）',
          parameters: [{ $ref: '#/components/parameters/PluginName' }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] } } } },
          responses: { '200': { description: 'ok' }, '400': { description: 'YAML 非法' } },
        },
      },
      '/api/plugins/install': {
        post: {
          tags: ['plugins'], summary: '安装插件（目录 / tgz / URL / 仓库）',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { source: { type: 'string' }, force: { type: 'boolean' } }, required: ['source'] } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/run': {
        post: {
          tags: ['run'], summary: '执行插件（或子命令），返回结果与实时日志',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    plugin: { type: 'string', enum: plugins },
                    command: { type: 'string' },
                    params: { type: 'object', additionalProperties: true },
                  },
                  required: ['plugin'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/RunResult' } } } },
          },
        },
      },
      '/api/pipeline': {
        post: {
          tags: ['pipeline'], summary: '执行工作流（inline def 或文件路径）',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', description: 'YAML/JSON 工作流文件路径' },
                    def: { type: 'object', description: 'inline 工作流定义（优先）' },
                    input: { type: 'object', additionalProperties: true, description: '输入参数' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'ok' }, '400': { description: '定义非法' } },
        },
      },
      '/api/pipeline/list': {
        get: {
          tags: ['pipeline'], summary: '列出工作区 pipelines 目录下的工作流',
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/logs': {
        get: {
          tags: ['logs'], summary: '调用日志',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 200 } },
            { name: 'plugin', in: 'query', schema: { type: 'string' } },
            { name: 'error', in: 'query', schema: { type: 'string', enum: ['1'] }, description: '只看失败' },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/config': {
        get: {
          tags: ['config'], summary: '读全局配置',
          responses: { '200': { description: 'ok' } },
        },
        put: {
          tags: ['config'], summary: '写全局配置（深合并）',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { patch: { type: 'object' } } } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/vault/keys': {
        get: {
          tags: ['config'], summary: '列出凭据键名（不返回值）',
          parameters: [{ name: 'plugin', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/templates': {
        get: {
          tags: ['templates'], summary: '模板列表 / 搜索',
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/templates/install': {
        post: {
          tags: ['templates'], summary: '安装模板',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/templates/export': {
        post: {
          tags: ['templates'], summary: '导出插件为模板',
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
      '/api/openapi.json': {
        get: {
          tags: ['config'], summary: '本描述文件',
          responses: { '200': { description: 'OpenAPI 3.0 文档' } },
        },
      },
    },
    components: {
      parameters: {
        PluginName: {
          name: 'name', in: 'path', required: true,
          schema: { type: 'string', enum: plugins.length ? plugins : undefined },
        },
      },
      schemas: {
        Envelope: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: {},
            error: { type: 'string', nullable: true },
          },
        },
        RunResult: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            data: { nullable: true },
            error: { type: 'string', nullable: true },
            meta: { type: 'object', nullable: true },
            ms: { type: 'integer' },
            logs: { type: 'array', items: { type: 'string' }, description: '实时进度' },
          },
        },
      },
    },
  };
}