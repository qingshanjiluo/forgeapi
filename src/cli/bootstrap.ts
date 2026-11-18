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

export async function initWorkspace(
  opts: { force?: boolean; quiet?: boolean; noInstall?: boolean } = {},
): Promise<{ installed: string[]; skipped: string[]; templates: number; depsSkipped: string[] }> {
  const paths = resolvePaths();
  ensureDirs(paths);
  const root = builtinPluginRoot();
  const reg = new Registry(paths);
  const installed: string[] = [];
  const skipped: string[] = [];
  const depsSkipped: string[] = [];

  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (reg.has(name) && !opts.force) { skipped.push(name); continue; }
      const r = await installPlugin(paths, {
        source: dir,
        force: true,
        yes: true,
        noInstall: Boolean(opts.noInstall),
      });
      installed.push(name);
      // 只记录"声明了依赖但被跳过"的插件
      if (opts.noInstall) {
        try {
          const pkgFile = path.join(dir, 'package.json');
          if (fs.existsSync(pkgFile)) {
            const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''));
            if (Object.keys(pkg.dependencies || {}).length) depsSkipped.push(name);
          }
        } catch { /* ignore */ }
      }
    }
  }

  const tplRoot = builtinTemplateRoot();
  const templates = await seedTemplates(paths, tplRoot);
  return { installed, skipped, templates, depsSkipped };
}
