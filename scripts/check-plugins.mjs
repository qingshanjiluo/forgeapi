#!/usr/bin/env node
/**
 * 插件语法门禁：遍历 plugins/builtin 与 templates 下的 .mjs，逐个 node --check。
 *
 * 存在的理由：开发中连续三次把 TypeScript 语法（`as X`、`const x: T =`）
 * 写进 .mjs，直到运行时才暴露。这个脚本 5 秒内能挡住同类错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const dirs = [
  path.join(ROOT, 'plugins', 'builtin'),
  path.join(ROOT, 'templates'),
];

const files = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (f.endsWith('.mjs') || f.endsWith('.js')) files.push(path.join(sub, f));
    }
  }
}

let fail = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`OK   ${path.relative(ROOT, f)}`);
  } catch (e) {
    fail++;
    const err = String(e.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ');
    console.log(`FAIL ${path.relative(ROOT, f)}`);
    console.log(`     ${err}`);
  }
}

console.log(`\n${files.length - fail}/${files.length} 插件语法通过`);
process.exit(fail ? 1 : 0);