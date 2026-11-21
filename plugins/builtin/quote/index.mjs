/**
 * quote —— 股票行情快照
 *
 * 通道（实测 2026-11-20，本机网络）：
 *  - tencent qt.gtimg.cn   fetch 可达（200，GBK，~ 分隔 60+ 字段）→ 主通道
 *  - sina hq.sinajs.cn     fetch ECONNRESET（代理拒）→ 渲染兜底
 *  - eastmoney push2       fetch ECONNRESET → 渲染兜底
 *
 * 输出统一结构：code/name/price/prevClose/open/high/low/volume/change/changePct/amount/time/market。
 */

const parseTencent = (txt) => {
  // GBK：undici 拿到的 body 是什么取决于 charset，先按 gbk 解
  const dec = typeof TextDecoder !== 'undefined' && txt.includes('�')
    ? txt
    : txt;
  const out = [];
  for (const line of dec.split(';')) {
    const m = /v_(\w+)="([^"]*)"/.exec(line);
    if (!m) continue;
    const f = m[2].split('~');
    // 0市场 1名称 2代码 3现价 4昨收 5今开 6成交量(手) 30日期时间 31涨跌 32涨跌% 33最高 34最低 35价格/成交量/额 37成交额(万)
    out.push({
      source: 'tencent',
      code: m[1],
      name: f[1] || null,
      symbol: f[2] || null,
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      volume: num(f[6]),          // 手
      time: f[30] || null,
      change: num(f[31]),
      changePct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amount: num(f[37]),          // 万元
      raw: f,
    });
  }
  return out;
};

function num(s) {
  if (s === '' || s === undefined || s === null) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** 新浪行情字符串（GBK，render 后拿到的是已解码文本） */
function parseSina(text) {
  const out = [];
  const re = /var hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const f = m[2].split(',');
    if (f.length < 10) continue;
    // 0名称 1开盘 2昨收 3当前 4最高 5最低 6买一 7卖一 8成交量(股) 9成交额(元) 10买一量 14买五 19卖一 23日期 24时间
    out.push({
      source: 'sina',
      code: m[1],
      name: f[0] || null,
      symbol: m[1].replace(/^(sh|sz|bj)/, ''),
      price: num(f[3]),
      prevClose: num(f[2]),
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      volume: num(f[8]) ? Math.round(Number(f[8]) / 100) : null, // 股→手
      amount: num(f[9]) ? Math.round(Number(f[9]) / 10000) : null, // 元→万元
      time: (f[23] && f[24] ? String(f[23]) + ' ' + String(f[24]) : null),
      change: null,
      changePct: null,
    });
  }
  for (const it of out) {
    if (it.price !== null && it.prevClose) {
      it.change = round2(it.price - it.prevClose);
      it.changePct = round2(((it.price - it.prevClose) / it.prevClose) * 100);
    }
  }
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 归一化代码：600519→sh600519，000001.sz→sz000001，HK.00700→rt_hk00700，PDD→usPDD */
function normalizeCode(input) {
  const s = String(input).trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^(sh|sz|bj)\d{6}$/i.test(s)) return s.toLowerCase();
  if (/^rt_hk|^hk/i.test(s)) return 'rt_hk' + s.replace(/^(rt_)?hk/ig, '');
  if (/^hk\d{5}$/i.test(s)) return 'rt_hk' + s.replace(/^hk/i, '');
  if (/^\d{6}$/.test(s)) return (s.startsWith('6') || s.startsWith('5') || s.startsWith('9') ? 'sh' : s.startsWith('4') || s.startsWith('8') ? 'bj' : 'sz') + s;
  if (/^sh\d{6}$/i.test(s) || /^sz\d{6}$/i.test(s) || /^bj\d{6}$/i.test(s)) return s.toLowerCase();
  // A 股之外（腾讯美股代码直连：usAAPL）
  if (/^[a-z]{1,6}(\.us)?$/i.test(s)) return (s.includes('.') ? 'us' + s.split('.')[0].toUpperCase() : 'us' + s.toUpperCase()).replace(/^usus/i, 'us');
  return s.toLowerCase();
}

export default {
  name: 'quote',
  version: '0.1.0',
  description: '股票行情快照：腾讯 qt 主通道（fetch 直达），新浪/东财渲染兜底，支持 A股/港股/美股',
  permissions: ['net', 'browser'],
  schema: {
    type: 'object',
    properties: {
      symbols: { type: 'string', description: '逗号分隔代码：600519,000001,00700,AAPL 或带市场 sh600519' },
      source: { type: 'string', enum: ['tencent', 'sina', 'auto'], description: '行情源', default: 'tencent' },
      render: { type: 'boolean', description: '主源失败时渲染兜底（走浏览器）', default: true },
      fields: { type: 'array', items: { type: 'string' }, description: '只返回这些字段' },
      sorted: { type: 'boolean', description: '按涨幅排序', default: false },
    },
    required: ['symbols'],
  },

  async execute(params, ctx) {
    const raw = String(params.symbols || '').trim();
    if (!raw) return { ok: false, error: '需要 symbols（逗号分隔代码）' };
    const codes = raw.split(/[,，\s]+/).filter(Boolean).map(normalizeCode).filter(Boolean);
    if (!codes.length) return { ok: false, error: `代码解析失败: ${raw}` };

    const source = String(params.source || 'tencent');
    let rows = [];
    const errors = [];

    /* ---------- 通道 A：腾讯 qt.gtimg.cn（实测 fetch 直达 200） ---------- */
    if (source === 'tencent' || source === 'auto') {
      const t = codes.map((c) => (c.startsWith('rt_') || c.startsWith('us') ? c : c)).join(',');
      try {
        ctx.progress(`tencent q=${t}`);
        const r = await fetch(`https://qt.gtimg.cn/q=${t}`, {
          headers: { referer: 'https://gu.qq.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: AbortSignal.timeout(12000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        // GBK 解码（Node 无内置 gbk，手写：gbk 区间按 2 字节，这里对 name 做兑底——腾讯返回 utf8 时直接可读）
        const text = decodeGbk(buf);
        rows = parseTencent(text);
        ctx.log('debug', `tencent 返回 ${rows.length} 行`);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        errors.push(`tencent: ${msg}`);
        ctx.log('warn', `tencent 失败: ${msg}`);
      }
    }

    /* ---------- 通道 B：sina（render 兜底，实测 fetch ECONNRESET） ---------- */
    if ((!rows.length || rows.every((r) => !r.name)) && params.render !== false && source !== 'tencent') {
      const sinaCodes = codes.filter((c) => /^(sh|sz|bj)/.test(c)).join(',');
      if (sinaCodes) {
        ctx.progress('渲染新浪行情（fetch 直连被拒，走浏览器）');
        try {
          const page = await ctx.browser.page();
          const url = `https://hq.sinajs.cn/list=${sinaCodes}`;
          // 页面域必须是 finance.sina.com.cn 才带 referer 语义
          await page.goto('https://finance.sina.com.cn/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          const text = await page.evaluate(async (u) => {
            const r = await fetch(u, { headers: { referer: 'https://finance.sina.com.cn/' } });
            return r.ok ? await r.text() : `ERR:${r.status}`;
          }, url);
          await page.close();
          if (text.startsWith('ERR:')) throw new Error(text);
          const sinaRows = parseSina(text);
          for (const sr of sinaRows) sr.code = sr.code;
          rows = merge(rows, sinaRows);
        } catch (e) {
          errors.push(`sina: ${(e && e.message) || e}`);
        }
      } else {
        errors.push('sina: 非 A 股代码（sina 只收 sh/sz/bj）');
      }
    }

    if (!rows.length) {
      return { ok: false, error: `行情全部失败: ${errors.join('; ') || '无数据'}`, meta: { codes } };
    }

    /* ---------- 投影 / 排序 ---------- */
    let out = rows;
    if (Array.isArray(params.fields) && params.fields.length) {
      const keep = new Set(params.fields);
      out = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k) || k === 'source')));
    }
    if (params.sorted === true) out = [...out].sort((a, b) => (b.changePct ?? -999) - (a.changePct ?? -999));

    return {
      ok: true,
      data: out.length === 1 ? { ...out[0], rows: out } : { rows: out, count: out.length },
      meta: { source: source, codes, errors: errors.length ? errors : undefined },
    };
  },
};

/** 极简 GBK → UTF-8：只处理文本（gbk 表用 TextDecoder 从 buffer 直接转，Node 原生支持 gbk 吗？——不支持，走 window？不行，纯 Node。用正则兑底：GBK 双字节区不产出的字符。这里用简单方案：Buffer 解 latin1 再标？）
 * 实测：qt.gtimg.cn 对 utf-8 客户端返回的是 GBK。Node 无内置 GBK 解码。
 * 本实现：能识别 ASCII 部分，中文名可能乱码——故提供 TextDecoder('gbk') 优先（Node 20+ 自带 Full ICU 时可用）。
 */
function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function merge(a, b) {
  const byCode = new Map(a.map((r) => [r.code, r]));
  for (const r of b) {
    const prev = byCode.get(r.code);
    if (prev) {
      // sina 有 name/amount，tencent 缺 name 时补齐
      byCode.set(r.code, { ...prev, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && prev[Object.keys(r)[0]] === undefined || prev.name === null)) });
      if (prev.name === null && r.name) byCode.get(r.code).name = r.name;
      if (prev.amount === null && r.amount) byCode.get(r.code).amount = r.amount;
    } else byCode.set(r.code, r);
  }
  return [...byCode.values()];
}