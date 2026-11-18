/**
 * pdf-text —— PDF 文本提取
 *
 * 依赖 pdfjs-dist（装本插件时自动安装，见 plugins/builtin/pdf-text/package.json）。
 * 支持：本地文件 / 远程 URL；按页提取；页码范围；输出每页文本 + 全文。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 动态加载 pdfjs-dist（未装时给可操作提示） */
async function loadPdfjs() {
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error(
      '缺少依赖 pdfjs-dist。在该插件目录安装后重试：\n' +
      `  cd "${path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))}" && npm install\n` +
      `原始错误: ${(e && e.message) || String(e)}`,
    );
  }
}

/** 解析页码范围 "1-3,5" → Set（1 基） */
function parsePages(spec, total) {
  if (!spec) return null;
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) throw new Error(`页码表达式非法: ${p}（示例 "1-3,5"）`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b; i++) if (i >= 1 && i <= total) set.add(i);
  }
  return set;
}

export default {
  name: 'pdf-text',
  version: '0.1.0',
  description: 'PDF 文本提取：本地文件或 URL，按页返回文本与元信息（依赖 pdfjs-dist）',
  permissions: ['fs-read', 'net'],
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '本地 PDF 路径' },
      url: { type: 'string', description: '远程 PDF 地址（与 file 二选一）' },
      pages: { type: 'string', description: '页码范围，如 "1-3,5"（缺省全部）' },
      maxPages: { type: 'integer', description: '最多解析多少页（防超大文件）', default: 50 },
      joinPages: { type: 'boolean', description: '是否给出合并后的全文', default: true },
    },
  },

  async execute(params, ctx) {
    if (!params.file && !params.url) return { ok: false, error: '需要 file 或 url' };

    let buf;
    let source;
    if (params.file) {
      const f = String(params.file);
      if (!fs.existsSync(f)) return { ok: false, error: `文件不存在: ${f}` };
      buf = new Uint8Array(fs.readFileSync(f));
      source = f;
    } else {
      const u = String(params.url);
      ctx.progress(`下载 ${u}`);
      const r = await fetch(u, { headers: { 'user-agent': 'ForgeAPI/0.8 (+local)' } });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      buf = new Uint8Array(await r.arrayBuffer());
      source = u;
    }

    const pdfjs = await loadPdfjs();
    // Node 环境需要禁用 worker
    const doc = await pdfjs.getDocument({
      data: buf,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    const total = doc.numPages;
    const want = parsePages(params.pages, total);
    const maxPages = Number(params.maxPages ?? 50);
    const targets = (want ? [...want].sort((x, y) => x - y) : Array.from({ length: total }, (_, i) => i + 1)).slice(0, maxPages);

    const pages = [];
    for (const n of targets) {
      ctx.progress(`解析第 ${n}/${total} 页`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => (it.str !== undefined ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ page: n, chars: text.length, text });
      page.cleanup();
    }

    await doc.destroy();

    const joined = params.joinPages !== false ? pages.map((p) => p.text).join('\n\n') : undefined;

    return {
      ok: true,
      data: {
        source,
        pages: total,
        parsed: pages.length,
        pageList: pages,
        ...(joined !== undefined ? { text: joined, chars: joined.length } : {}),
      },
      meta: { bytes: buf.length },
    };
  },
};