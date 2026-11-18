/**
 * ForgeAPI 核心类型定义
 * 统一插件契约 / 规则 / 会话步骤 / 日志结构
 */

export type Permission =
  | 'net'        // 网络访问
  | 'browser'    // 无头浏览器
  | 'fs-read'    // 读取工作区文件
  | 'fs-write'   // 写入工作区文件
  | 'credential' // 读取插件自己的凭据
  | 'exec';      // 启动子进程

export interface JSONSchemaProp {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JSONSchemaProp;
  properties?: Record<string, JSONSchemaProp>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  format?: string;
  example?: unknown;
}

export interface JSONSchema extends JSONSchemaProp {
  type: 'object';
  properties: Record<string, JSONSchemaProp>;
  required?: string[];
}

export interface CommandDef {
  /** 子命令名，例如 extract / list / post */
  name: string;
  description: string;
  /** 该子命令自己的参数 schema（缺省用插件 schema） */
  schema?: JSONSchema;
  /** 执行入口，接收合并后的参数 */
  handler: (params: Record<string, any>, ctx: PluginContext) => Promise<PluginResult>;
}

export interface PluginResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface PluginContext {
  /** 插件名 */
  plugin: string;
  /** 工作区路径 */
  paths: WorkspacePaths;
  /** 该插件的私有数据目录（配置 / cookie / 凭据） */
  dataDir: string;
  /** 读取插件私有凭据；未解锁时抛错 */
  getCredential: (key: string) => string | undefined;
  /** 写入插件私有凭据 */
  setCredential: (key: string, value: string) => void;
  /** 追加日志 */
  log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string, extra?: unknown) => void;
  /** 无头浏览器句柄（惰性启动，插件需要时调用） */
  browser: import('./browser.js').BrowserApi;
  /** 全局配置读取 */
  config: Readonly<ForgeConfig>;
  /** 进度回调（Web 控制台实时输出） */
  progress: (msg: string) => void;
}

export interface ForgePlugin {
  name: string;
  version: string;
  description: string;
  schema: JSONSchema;
  skill?: string;
  permissions?: Permission[];
  commands?: CommandDef[];
  execute?: (params: Record<string, any>, ctx: PluginContext) => Promise<PluginResult>;
}

/* ---------------- 提取规则 ---------------- */

export type SelectorKind = 'css' | 'xpath' | 'jsonpath' | 'regex';

export interface FieldRule {
  name: string;
  selector?: string;
  kind?: SelectorKind;      // 缺省按 selector 语法自动识别
  type?: 'text' | 'html' | 'attr' | 'list' | 'number' | 'bool' | 'url';
  attr?: string;            // type=attr 时取哪个属性
  fields?: FieldRule[];     // type=list 时的子字段
  transform?: 'trim' | 'lower' | 'upper' | 'number' | 'json' | 'none';
  /** 正则捕获组序号，kind=regex 时生效 */
  group?: number;
  /** 缺失时是否跳过该条 */
  optional?: boolean;
  /** list 最多取几条 */
  limit?: number;
}

export interface ExtractRule {
  name?: string;
  url?: string;
  fields: FieldRule[];
  /** 提取根节点，缺省为 document */
  root?: string;
  rootKind?: SelectorKind;
}

/* ---------------- 会话步骤 ---------------- */

export type StepAction =
  | 'goto'
  | 'fill'
  | 'type'
  | 'click'
  | 'press'
  | 'wait'
  | 'waitFor'
  | 'scroll'
  | 'eval'
  | 'extract'
  | 'screenshot'
  | 'cookie-save'
  | 'cookie-load'
  | 'sleep';

export interface SessionStep {
  action: StepAction;
  url?: string;
  selector?: string;
  value?: string;
  /** value 里可用 ${VAR} 引用参数 / 凭据 */
  rule?: string | ExtractRule;
  fields?: FieldRule[];
  timeout?: number;
  delay?: number;
  ms?: number;
  script?: string;
  times?: number;
  path?: string;
  name?: string;
  /** extract 步骤把结果并入输出的哪个键 */
  key?: string;
  /** 输出是否保留该步截图 */
  fullPage?: boolean;
}

/* ---------------- 聚合 ---------------- */

export interface SourceDef {
  name: string;
  type: 'api' | 'webpage' | 'code' | 'json';
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  /** type=webpage 时的提取规则 */
  rule?: string | ExtractRule;
  /** type=json 时的 JSONPath 根 */
  jsonpath?: string;
  /** type=code 时执行的内联 JS 表达式（在沙箱函数内） */
  code?: string;
  /** 结果映射到统一字段 */
  map?: Record<string, string>;
  timeout?: number;
  optional?: boolean;
}

export interface MergeDef {
  strategy: 'concat' | 'dedupe_by_title' | 'dedupe_by_key' | 'first_nonempty';
  key?: string;
  fields?: string[];
  limit?: number;
  sortBy?: string;
}

export interface DeclarativePlugin {
  name: string;
  version: string;
  description: string;
  type: 'extract' | 'aggregate' | 'flow';
  permissions?: Permission[];
  schema?: JSONSchema;
  skill?: string;
  browser?: { headless?: boolean; timeout?: number; userAgent?: string; locale?: string; viewport?: { width: number; height: number } };
  /** type=extract */
  url?: string;
  rule?: string;
  fields?: FieldRule[];
  /** type=flow */
  steps?: SessionStep[];
  /** type=aggregate */
  sources?: SourceDef[];
  merge?: MergeDef;
  /** 输出整形：把字段改名/裁剪 */
  output?: { fields?: string[]; keyMap?: Record<string, string>; raw?: boolean };
}

/* ---------------- 工作区 ---------------- */

export interface WorkspacePaths {
  root: string;
  plugins: string;
  templates: string;
  logs: string;
  data: string;
  credentials: string;
  config: string;
  registry: string;
}

export interface ForgeConfig {
  browser: { headless: boolean; timeout: number; userAgent?: string; locale: string; viewport: { width: number; height: number } };
  log: { enabled: boolean; keepDays: number };
  server: { host: string; port: number };
  security: { requireMasterPassword: boolean };
  defaultSources: string[];
}

export interface LogEntry {
  id: string;
  ts: string;
  plugin: string;
  command?: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
  summary: string;
  error?: string;
  exitCode: number;
}

export interface RegistryEntry {
  name: string;
  version: string;
  dir: string;
  file: string;
  enabled: boolean;
  permissions: Permission[];
  description: string;
  installedAt: string;
  source?: string;
  /** 安装时的目录内容哈希（内容基线） */
  integrity?: string;
  /** 基线里的每文件摘要，用于定位变更 */
  integrityFiles?: { file: string; sha256: string }[];
  /** 基线写入时间 */
  integrityAt?: string;
  /** Ed25519 签名记录（sign 时写入） */
  signature?: {
    digest: string;
    signature: string;
    keyId: string;
    signer?: string;
    at: string;
  };
}
