import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, resolvePaths } from '../core/workspace.js';
import { installPlugin } from '../core/installer.js';
import { seedTemplates, listTemplates } from '../core/templates.js';
import { Registry } from '../core/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/cli -> dist -> project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export function builtinPluginRoot(): string {
  const direct = path.join(PROJECT_ROOT, 'plugins', 'builtin');
  if (fs.existsSync(direct)) return direct;
  // 安装为全局包时：node_modules/forgeapi/plugins/builtin
  const alt = path.resolve(__dirname, '../../plugins/builtin');
  return fs.existsSync(alt) ? alt : direct;
}

export function builtinTemplateRoot(): string {
  const direct = path.join(PROJECT_ROOT, 'templates');
  if (fs.existsSync(direct)) return direct;
  return path.resolve(__dirname, '../../templates');
}

export async function initWorkspace(opts: { force?: boolean; quiet?: boolean } = {}): Promise<{ installed: string[]; skipped: string[]; templates: number }> {
  const paths = resolvePaths();
  ensureDirs(paths);
  const root = builtinPluginRoot();
  const reg = new Registry(paths);
  const installed: string[] = [];
  const skipped: string[] = [];

  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (reg.has(name) && !opts.force) { skipped.push(name); continue; }
      await installPlugin(paths, { source: dir, force: true, yes: true });
      installed.push(name);
    }
  }

  const tplRoot = builtinTemplateRoot();
  const templates = await seedTemplates(paths, tplRoot);
  return { installed, skipped, templates };
}
