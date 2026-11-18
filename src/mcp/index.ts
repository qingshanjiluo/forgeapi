#!/usr/bin/env node
/**
 * forge mcp —— MCP 服务端入口（stdio 传输）
 * 用法：
 *   forge mcp                     # 暴露全部启用插件
 *   forge mcp --only weather,rss # 只暴露指定插件
 *   forge mcp --flat              # 不把子命令暴露成独立工具
 */
import { resolvePaths, ensureDirs } from '../core/workspace.js';
import { ForgeMcpServer } from './server.js';
import { rewriteArgv } from '../cli/argvrewrite.js';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
};
const has = (name: string) => argv.includes(name);

async function main(): Promise<void> {
  const paths = resolvePaths();
  ensureDirs(paths);

  const onlyRaw = opt('--only');
  const server = new ForgeMcpServer({
    paths,
    only: onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    exposeCommands: !has('--flat'),
    log: (m) => process.stderr.write(`[forge:mcp] ${m}\n`),
  });

  // 支持一次性探测（便于客户端/测试检查工具表）
  if (has('--list')) {
    const tools = await server.buildTools();
    process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
    return;
  }

  await server.serveStdio();
  // 客户端断开 → 清理浏览器池
  try {
    const { disposePool } = await import('../core/browserpool.js');
    await disposePool();
  } catch { /* ignore */ }
}

void rewriteArgv; // 保留导入以便未来扩展

main().catch((e) => {
  process.stderr.write(`[forge:mcp:error] ${(e as Error).message}\n`);
  process.exitCode = 1;
});