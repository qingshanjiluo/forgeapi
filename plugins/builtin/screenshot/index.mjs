/**
 * screenshot —— 网页截图
 *
 * 输出模式：
 *   file（默认）—— 存到插件 dataDir/shots/，返回路径
 *   base64      —— 直接返回 base64（小图 / 传给下游 AI 看图）
 *
 * 能力：整页截图、视口截图、元素截图、指定尺寸裁剪、PNG/JPEG
 */
import fs from 'node:fs';
import path from 'node:path';

function safeName(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/[^\w.-]+/g, '_').replace(/_+$/,'').slice(0, 80) || 'shot';
  } catch {
    return 'shot';
  }
}

export default {
  name: 'screenshot',
  version: '0.1.0',
  description: '网页截图：整页/视口/元素，PNG/JPEG，可存文件或返回 base64',
  permissions: ['browser', 'net', 'fs-write'],
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网页地址' },
      fullPage: { type: 'boolean', description: '整页截图（含滚动区域）', default: true },
      selector: { type: 'string', description: '只截某个元素（CSS 选择器）；给此参数则忽略 fullPage' },
      width: { type: 'integer', description: '视口宽度（默认 1440）' },
      height: { type: 'integer', description: '视口高度（默认 900）' },
      type: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
      quality: { type: 'integer', description: 'JPEG 质量 1-100（仅 jpeg 生效）', default: 80 },
      output: { type: 'string', enum: ['file', 'base64'], default: 'file' },
      path: { type: 'string', description: '自定义输出路径（output=file 时可选）' },
      waitFor: { type: 'string', description: '等待该选择器出现再截图' },
      delay: { type: 'integer', description: '额外等待毫秒（动画/懒加载）', default: 0 },
      hideSelectors: { type: 'array', items: { type: 'string' }, description: '截图前隐藏这些元素（弹窗/广告）' },
    },
    required: ['url'],
  },

  async execute(params, ctx) {
    const url = String(params.url || '');
    if (!url) return { ok: false, error: '需要 url' };

    const page = await ctx.browser.page();
    if (params.width || params.height) {
      await page.setViewportSize({
        width: Number(params.width || 1440),
        height: Number(params.height || 900),
      });
    }

    ctx.progress(`打开 ${url}`);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (resp && !resp.ok() && resp.status() >= 400) {
      ctx.log('warn', `HTTP ${resp.status()}`);
    }

    if (params.waitFor) {
      await page.waitForSelector(String(params.waitFor), { timeout: 30000 }).catch((e) => {
        ctx.log('warn', `等待 ${params.waitFor} 超时：${e.message}`);
      });
    }

    // 隐藏干扰元素
    if (Array.isArray(params.hideSelectors) && params.hideSelectors.length) {
      await page.evaluate((sels) => {
        for (const s of sels) {
          document.querySelectorAll(s).forEach((el) => {
            el.style.visibility = 'hidden';
          });
        }
      }, params.hideSelectors).catch(() => {});
    }

    if (params.delay && Number(params.delay) > 0) {
      await page.waitForTimeout(Number(params.delay));
    }

    const kind = params.type === 'jpeg' ? 'jpeg' : 'png';
    const opts = {
      type: kind,
      ...(kind === 'jpeg' ? { quality: Math.min(100, Math.max(1, Number(params.quality || 80))) } : {}),
    };

    ctx.progress('截图中');
    let buf;
    let target = null;
    if (params.selector) {
      const el = await page.$(String(params.selector));
      if (!el) return { ok: false, error: `选择器无命中: ${params.selector}` };
      buf = await el.screenshot(opts);
      target = `元素 ${params.selector}`;
    } else {
      buf = await page.screenshot({ ...opts, fullPage: params.fullPage !== false });
      target = params.fullPage === false ? '视口' : '整页';
    }

    const meta = {
      url,
      title: await page.title().catch(() => ''),
      bytes: buf.length,
      type: kind,
      scope: target,
      finalUrl: page.url(),
    };

    if (params.output === 'base64') {
      return { ok: true, data: { ...meta, base64: buf.toString('base64') } };
    }

    const dir = path.join(ctx.dataDir, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const ext = kind === 'jpeg' ? 'jpg' : 'png';
    const out = params.path
      ? String(params.path)
      : path.join(dir, `${safeName(url)}-${Date.now()}.${ext}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);

    return { ok: true, data: { ...meta, file: out }, meta: { dir } };
  },
};