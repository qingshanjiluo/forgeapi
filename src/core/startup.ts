/**
 * 开机自启动 —— 把 `forge serve` 挂到操作系统启动项
 *
 * 跨平台：
 * - Windows：启动文件夹放一个 `.vbs`，用 wscript 无窗口拉起（cmd 弹窗不可接受）
 * - macOS：~/Library/LaunchAgents/com.forgeapi.serve.plist + launchctl bootstrap
 * - Linux：~/.config/autostart/forgeapi.desktop（freedesktop autostart）
 *
 * 关键点：
 * 1. 用「当前 node 绝对路径 + CLI 绝对路径」而不是 `forge` 命令 ——
 *    没做全局安装（npx/仓库直跑）时也要能启动
 * 2. stdout/stderr 重定向到工作区 logs/serve-startup.log，否则无窗口进程丢日志无从排查
 * 3. 幂等：install 已存在时更新内容；uninstall 找不到也返回成功（附 alreadyAbsent）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WorkspacePaths } from './types.js';
import { resolvePaths as resolveWsPaths } from './workspace.js';

const TAG = 'forgeapi';

export interface StartupTarget {
  /** 启动项文件绝对路径 */
  file: string;
  /** 已存在 */
  installed: boolean;
  /** 直接运行的命令行（预览用） */
  command: string;
}

/** PATH 里第一个"真 node"；找不到回落 process.execPath */
function resolveNode(): string {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['node'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // 跳过 Python 虚拟环境里那份（本机实测 where node 首个命中
    // ...\Python313\Scripts\node.exe），卸载 Python 就会断
    const clean = out.filter((p) => !/nodejs_wheel|Python\d+/i.test(p));
    const pick = clean[0] || out[0];
    if (pick && fs.existsSync(pick)) return pick;
  } catch { /* PATH 里没有 node，走回落 */ }
  return process.execPath;
}

/** 当前 node + 本 CLI 的 serve 命令行 */
function buildCommand(paths: WorkspacePaths, port: number): { node: string; cli: string; args: string[] } {
  const node = asciiSafe(resolveNode(), resolveNode());
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = asciiSafe(path.resolve(here, '..', 'cli', 'index.js'), path.resolve(here, '..', 'cli', 'index.js'));
  return { node, cli, args: ['serve', '--port', String(port)] };
}

function shellQuote(a: string): string {
  return /[\s"&|<>^%]/.test(a) ? `"${a}"` : a;
}

/** 确保命令里不含非 ASCII（vbs 被 wscript 按系统 ANSI 解析，UTF-8 中文路径必乱码 → 起不来）。
 *  三级兜底：原生 ASCII → 8.3 短路径 → 建 ASCII junction（卷禁用 8.3 时唯一出路）。 */
function asciiSafe(p: string, original: string): string {
  if (!/[^\x00-\x7F]/.test(p)) return original;
  if (process.platform !== 'win32') return original;
  const esc = (s: string) => s.replace(/'/g, "''");
  const tryPs = (expr: string): string | null => {
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', expr],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 },
      ).trim();
      if (out && fs.existsSync(out) && !/[^\x00-\x7F]/.test(out)) return out;
    } catch { /* ignore */ }
    return null;
  };
  // 1) 8.3 短路径（.NET 没有 Path.GetShortPathName，必须走 COM）
  const hit = tryPs(`(New-Object -ComObject Scripting.FileSystemObject).GetFile('${esc(original)}').ShortPath`);
  if (hit) return hit;
  const dir = path.dirname(original);
  const dirShort = tryPs(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${esc(dir)}').ShortPath`);
  if (dirShort) {
    const cand = path.join(dirShort, path.basename(original));
    if (fs.existsSync(cand) && !/[^\x00-\x7F]/.test(cand)) return cand;
  }
  // 2) 建 ASCII junction：只对项目 dist 目录做，其他路径（如日志）交给调用方处理
  const linkRoot = process.env.ProgramData || 'C:\\ProgramData';
  const link = path.join(linkRoot, `${TAG}-link`);
  try {
    if (!fs.existsSync(link)) {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, dir], { stdio: 'ignore' });
    }
    if (fs.existsSync(link)) {
      const cand = path.join(link, path.basename(original));
      if (fs.existsSync(cand) && !/[^\x00-\x7F]/.test(cand)) return cand;
    }
  } catch { /* ignore */ }
  return original;
}

function cmdLine(cmd: { node: string; cli: string; args: string[] }): string {
  return [cmd.node, cmd.cli, ...cmd.args].map(shellQuote).join(' ');
}

/* ---------- 路径 ---------- */

function winStartupDir(): string {
  const appData = process.env.APPDATA;
  if (appData) return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(userProfile, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function startupFile(): string {
  const homedir = process.env.USERPROFILE || process.env.HOME || '.';
  if (process.platform === 'win32') return path.join(winStartupDir(), `${TAG}-serve.vbs`);
  if (process.platform === 'darwin') return path.join(homedir, 'Library', 'LaunchAgents', `com.${TAG}.serve.plist`);
  return path.join(homedir, '.config', 'autostart', `${TAG}.desktop`);
}

/* ---------- 内容生成 ---------- */

function renderWindows(cmd: ReturnType<typeof buildCommand>, logFile: string): string {
  const inner = `cmd /c ${shellQuote(cmdLine(cmd))} > ${shellQuote(logFile)} 2>&1`;
  // 整份必须纯 ASCII：wscript 按系统 ANSI(CP936) 解析，UTF-8 中文注释都会让其报语法错
  return [
    `' Generated by "forge install-startup". Delete this file to stop auto-start.`,
    `Set ws = CreateObject("Wscript.Shell")`,
    `ws.Run "${inner.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
}

function renderDarwin(cmd: ReturnType<typeof buildCommand>, logFile: string): string {
  const args = [cmd.node, cmd.cli, ...cmd.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 forge install-startup 生成，launchctl bootout 即取消 -->
<plist version="1.0">
<dict>
  <key>Label</key><string>com.${TAG}.serve</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logFile)}</string>
  <key>WorkingDirectory</key><string>${escapeXml(path.dirname(cmd.cli))}</string>
</dict>
</plist>
`;
}

function renderLinuxDesktop(cmd: ReturnType<typeof buildCommand>): string {
  return `[Desktop Entry]
Type=Application
Name=ForgeAPI
# 由 forge install-startup 生成，删除本文件即取消开机自启
Exec=${cmdLine(cmd)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

/* ---------- 对外 ---------- */

let cachedPaths: WorkspacePaths | null = null;
/** 由 CLI 注入工作区路径（缺省回落 resolvePaths()） */
export function setStartupPaths(p: WorkspacePaths): void {
  cachedPaths = p;
}
function pathsFor(): WorkspacePaths {
  if (!cachedPaths) cachedPaths = resolveWsPaths();
  return cachedPaths;
}

/** 当前自启状态 */
export function startupStatus(port: number): StartupTarget {
  const file = startupFile();
  const cmd = buildCommand(pathsFor(), port);
  return { file, installed: fs.existsSync(file), command: cmdLine(cmd) };
}

export function installStartup(port: number): StartupTarget {
  const pathsRef = pathsFor();
  const file = startupFile();
  const cmd = buildCommand(pathsRef, port);
  const logFile = asciiSafe(path.join(pathsRef.logs, 'serve-startup.log'), path.join(pathsRef.logs, 'serve-startup.log'));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let content: string;
  if (process.platform === 'win32') content = renderWindows(cmd, logFile);
  else if (process.platform === 'darwin') content = renderDarwin(cmd, logFile);
  else content = renderLinuxDesktop(cmd);

  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content, 'utf8');

  // macOS 装完要 load（已 load 会报错，忽略即可）
  if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 1000}`, file], { stdio: 'ignore' });
    } catch {
      try { execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }

  return { file, installed: fs.existsSync(file), command: cmdLine(cmd) };
}

export function uninstallStartup(): { file: string; removed: boolean; alreadyAbsent: boolean } {
  const file = startupFile();
  if (!fs.existsSync(file)) return { file, removed: false, alreadyAbsent: true };

  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 1000}/${TAG}.serve`], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { execFileSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  fs.unlinkSync(file);
  return { file, removed: true, alreadyAbsent: false };
}