/**
 * argv 前置重写：把 `forge <plugin> [sub] ...` 归一成 `forge run <plugin> [sub] ...`
 * 避免 commander 嵌套子命令的选项解析歧义。
 */
import { Registry } from '../core/registry.js';
import type { WorkspacePaths } from '../core/types.js';

const RESERVED = new Set([
  'run', 'list', 'info', 'install', 'remove', 'enable', 'disable',
  'schema', 'skill', 'log', 'config', 'cfg', 'rule', 'template',
  'plugins', 'init', 'serve', 'doctor', 'help', '--help', '-h', '-V', '--version',
]);

export interface RewriteResult {
  argv: string[];
  rewritten: boolean;
  plugin?: string;
  command?: string;
}

export function rewriteArgv(raw: string[], paths: WorkspacePaths): RewriteResult {
  const argv = [...raw];
  // argv[0]=node argv[1]=script argv[2]=第一个用户词
  if (argv.length < 3) return { argv, rewritten: false };
  const first = argv[2];
  if (first.startsWith('-')) return { argv, rewritten: false };
  if (RESERVED.has(first)) return { argv, rewritten: false };

  const reg = new Registry(paths);
  const entry = reg.get(first);
  if (!entry) return { argv, rewritten: false };

  const rest = argv.slice(3);
  // 若下一个词不是选项，视为子命令
  const maybeSub = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;

  if (!maybeSub) {
    return {
      argv: [argv[0], argv[1], 'run', first, ...rest],
      rewritten: true,
      plugin: first,
    };
  }

  return {
    argv: [argv[0], argv[1], 'run', first, maybeSub, ...rest.slice(1)],
    rewritten: true,
    plugin: first,
    command: maybeSub,
  };
}