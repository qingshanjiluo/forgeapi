/**
 * pdf —— 网页转 PDF
 *
 * 走 Chromium 的 page.pdf（仅 headless 可用），支持页面尺寸、边距、
 * 页眉页脚模板、打印背景、页码范围。
 */
import fs from 'node:fs';
import path from 'node:path';

function safeName(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, '_').replace(/_+$/, '').slice(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

export default {
  name: 'pdf',
  version: '0.1.0',
  description: '网页转 PDF：页面尺寸/边距/页眉页脚/打印背景/页码范围',
  permissions: ['browser', 'net', 'fs-write'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网页地址' },
      format: { type: 'string', description: '纸张：A4 / A3 / Letter / Legal / A5 / Tabloid', default: 'A4' },
      landscape: { type: 'boolean', description: '横向', default: false },
      margin: {
        type: 'object',
        description: '边距，如 { top: "10mm", bottom: "10mm", left: "8mm", right: "8mm" }',
      },
      printBackground: { type: 'boolean', description: '打印背景色/图', default: true },
      scale: { type: 'number', description: '缩放 0.1-2', default: 1 },
      headerTemplate: { type: 'string', description: '页眉 HTML（可用 span.date / span.title / span.url / span.pageNumber / span.totalPages）' },
      footerTemplate: { type: 'string', description: '页脚 HTML（同上）' },
      displayHeaderFooter: { type: 'boolean', description: '显示页眉页脚', default: false },
      pageRanges: { type: 'string', description: '页码范围，如 "1-3,5"' },
      waitFor: { type: 'string', description: '等待选择器出现再打印' },
      delay: { type: 'integer', description: '额外等待毫秒', default: 0 },
      path: { type: 'string', description: '自定义输出路径' },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url || '');
    if (!url) return { ok: false, error: '需要 url' };

    const page = await ctx.browser.page();
    ctx.progress(`打开 ${url}`);
    const resp = await page.goto(url, { waitUntil: 'networkidle' }).catch(async () => {
      // networkidle 在有长连接页面上可能超时，回退 domcontentloaded
      ctx.log('warn', 'networkidle 超时，回退 domcontentloaded');
      return page.goto(url, { waitUntil: 'domcontentloaded' });
    });
    if (resp && !resp.ok() && resp.status() >= 400) ctx.log('warn', `HTTP ${resp.status()}`);

    if (params.waitFor) {
      await page.waitForSelector(String(params.waitFor), { timeout: 30000 }).catch((e) => {
        ctx.log('warn', `等待超时：${e.message}`);
      });
    }
    if (params.delay && Number(params.delay) > 0) await page.waitForTimeout(Number(params.delay));

    // 打印前隐藏固定定位元素（导航条会盖住每页顶部）
    await page.emulateMedia({ media: 'print' }).catch(() => {});

    const dir = path.join(ctx.dataDir, 'pdfs');
    fs.mkdirSync(dir, { recursive: true });
    const out = params.path ? String(params.path) : path.join(dir, `${safeName(url)}-${Date.now()}.pdf`);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const m = (params.margin && typeof params.margin === 'object') ? params.margin : {};
    const margin = {
      top: String(m.top ?? '10mm'),
      bottom: String(m.bottom ?? '10mm'),
      left: String(m.left ?? '8mm'),
      right: String(m.right ?? '8mm'),
    };

    ctx.progress('生成 PDF');
    await page.pdf({
      path: out,
      format: String(params.format || 'A4'),
      landscape: Boolean(params.landscape),
      margin,
      printBackground: params.printBackground !== false,
      scale: Math.min(2, Math.max(0.1, Number(params.scale || 1))),
      displayHeaderFooter: Boolean(params.displayHeaderFooter),
      ...(params.headerTemplate ? { headerTemplate: String(params.headerTemplate) } : {}),
      ...(params.footerTemplate ? { footerTemplate: String(params.footerTemplate) } : {}),
      ...(params.pageRanges ? { pageRanges: String(params.pageRanges) } : {}),
    });

    const stat = fs.statSync(out);
    return {
      ok: true,
      data: {
        file: out,
        bytes: stat.size,
        url,
        title: await page.title().catch(() => ''),
        format: String(params.format || 'A4'),
        landscape: Boolean(params.landscape),
      },
    };
  },
};