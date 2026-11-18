import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TPL = path.join(ROOT, 'templates');
const OUT = path.join(ROOT, 'dist-templates');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const names = fs.readdirSync(TPL)
  .filter((n) => fs.statSync(path.join(TPL, n)).isDirectory())
  .sort();

console.log(`打包 ${names.length} 个模板：`);
for (const name of names) {
  const src = path.join(TPL, name);
  const tgz = path.join(OUT, `${name}.tgz`);
  // -C 到模板目录，把内容直接打进去（无 package/ 前缀）
  execFileSync('tar', ['-czf', tgz, '-C', src, '.'], { stdio: 'pipe' });
  const size = fs.statSync(tgz).size;
  console.log(`  ${name.padEnd(24)} ${(size / 1024).toFixed(1)} KB`);
}

console.log(`\n产物目录：${OUT}`);