import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '..', 'web');

function ensure(): void {
  fs.mkdirSync(path.join(WEB, 'assets'), { recursive: true });
  // 内容比对：内嵌资源升级后要覆盖旧文件，否则浏览器一直跑旧 bundle
  const writeIfChanged = (file: string, content: string) => {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
    } catch { /* 读失败就当需要重写 */ }
    fs.writeFileSync(file, content, 'utf8');
    return true;
  };
  writeIfChanged(path.join(WEB, 'index.html'), INDEX_HTML);
  writeIfChanged(path.join(WEB, 'assets', 'app.js'), APP_JS);
  writeIfChanged(path.join(WEB, 'assets', 'style.css'), STYLE_CSS);
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>ForgeAPI 控制台</title>
<link rel="stylesheet" href="/assets/style.css" />
</head>
<body>
<div id="app"></div>
<script type="module" src="/assets/app.js"></script>
</body>
</html>`;

const STYLE_CSS = `
:root{--bg:#0d1117;--panel:#161b22;--bd:#30363d;--fg:#e6edf3;--dim:#8b949e;--acc:#f0883e;--ok:#3fb950;--err:#f85149;}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--bd);background:var(--panel)}
header h1{font-size:16px;margin:0;color:var(--acc);letter-spacing:.5px}
nav{display:flex;gap:4px;margin-left:24px}
nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px}
nav button.active{color:var(--fg);background:#21262d;border-color:var(--bd)}
main{display:grid;grid-template-columns:280px 1fr;gap:0;height:calc(100vh - 57px)}
aside{border-right:1px solid var(--bd);overflow:auto;padding:12px}
aside .item{padding:8px 10px;border-radius:6px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
aside .item:hover{background:#21262d}
aside .item.sel{background:#21262d;border-color:var(--acc)}
aside .item .n{font-weight:600}
aside .item .d{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
aside .item .badge{font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--bd);color:var(--dim)}
section{padding:16px 20px;overflow:auto}
h2{font-size:14px;margin:0 0 12px;color:var(--dim);text-transform:uppercase;letter-spacing:1px}
textarea,input,select{width:100%;background:#0d1117;border:1px solid var(--bd);color:var(--fg);border-radius:6px;padding:8px;font:inherit}
textarea{font-family:ui-monospace,Consolas,monospace;font-size:12px;min-height:120px}
button.act{background:#21262d;border:1px solid var(--bd);color:var(--fg);padding:6px 14px;border-radius:6px;cursor:pointer}
button.act:hover{border-color:var(--acc)}
button.act.primary{background:var(--acc);border-color:var(--acc);color:#0d1117;font-weight:600}
.row{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
pre{background:#0d1117;border:1px solid var(--bd);border-radius:6px;padding:12px;overflow:auto;font-size:12px;line-height:1.45;max-height:420px}
.tag{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--bd);color:var(--dim)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.tag.err{color:var(--err);border-color:var(--err)}
.muted{color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--bd)}
th{color:var(--dim);font-weight:500}
.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}
`;

const APP_JS = String.raw`
const $ = (s, r=document) => r.querySelector(s);
const el = (t, props={}, ...kids) => {
  const n = document.createElement(t);
  for (const [k,v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const api = async (p, opt={}) => {
  const r = await fetch('/api'+p, {headers:{'content-type':'application/json'}, ...opt});
  return r.json();
};

const TABS = ['插件','调试','规则','日志','配置','模板','工作流'];
let state = { tab:'插件', plugins:[], cur:null, detail:null };

function render() {
  const root = $('#app');
  root.innerHTML = '';
  const nav = el('nav', {}, ...TABS.map(t => el('button', {class: t===state.tab?'active':'', onclick:()=>{state.tab=t;render();}}, t)));
  root.append(el('header', {}, el('h1', {}, 'ForgeAPI'), nav,
    el('span', {class:'muted', style:'margin-left:auto'}, '把世界锻造成 AI 能调用的接口')));
  const main = el('main');
  if (state.tab === '插件') { main.append(pluginList(), pluginDetailPane()); }
  if (state.tab === '调试') { main.append(el('aside'), debugPane()); }
  if (state.tab === '规则') { main.append(el('aside'), rulesPane()); }
  if (state.tab === '日志') { main.append(el('aside'), logsPane()); }
  if (state.tab === '配置') { main.append(el('aside'), configPane()); }
  if (state.tab === '模板') { main.append(el('aside'), templatesPane()); }
  if (state.tab === '工作流') { main.append(el('aside'), pipelinePane()); }
  root.append(main);
}

function pipelinePane() {
  const s = el('section');
  s.append(el('h2',{},'工作流编排'));

  const listBox = el('div',{class:'row'});
  const fileInput = el('input',{placeholder:'工作流文件路径（YAML/JSON）'});
  const inputTa = el('textarea',{placeholder:'input 参数 JSON，如 {"query":"rust"}','style':'min-height:80px'});
  const out = el('pre',{},'(未执行)');

  const run2 = async (file) => {
    out.textContent = '执行中…';
    let input = {};
    try { input = inputTa.value.trim() ? JSON.parse(inputTa.value) : {}; }
    catch(e){ out.textContent = 'input JSON 非法: ' + e.message; return; }
    const r = await api('/pipeline',{method:'POST',body:JSON.stringify({ file, input })});
    const lines = (r.logs||[]).join(' → ');
    out.textContent = (lines ? '# 步骤\n' + lines + '\n\n' : '') + JSON.stringify(r, null, 2);
  };

  const refreshList = async () => {
    listBox.innerHTML = '';
    const r = await api('/pipeline/list');
    const items = r.data || [];
    if (!items.length) {
      listBox.append(el('span',{class:'muted'},'工作区 pipelines/ 目录为空；可直接填路径'));
      return;
    }
    for (const it of items) {
      listBox.append(el('button',{class:'act',onclick:()=>{ fileInput.value = it.file; }}, it.name));
    }
  };

  s.append(el('div',{class:'row'},
    fileInput,
    el('button',{class:'act primary',onclick:()=>{
      if (!fileInput.value.trim()) return;
      void run2(fileInput.value.trim());
    }},'执行'),
  ));
  s.append(el('div',{class:'row'}, listBox));
  s.append(inputTa);
  s.append(out);
  refreshList();
  return s;
}

function pluginList() {
  const aside = el('aside');
  aside.append(el('div', {class:'row'}, el('button', {class:'act primary', onclick: async ()=>{
    const src = prompt('插件源（本地目录 / .tgz / 内置名）');
    if (!src) return;
    const r = await api('/plugins/install', {method:'POST', body: JSON.stringify({source: src})});
    alert(r.ok ? '安装成功: '+r.data.name : '失败: '+r.error);
    await loadPlugins();
  }}, '安装插件')));
  for (const p of state.plugins) {
    aside.append(el('div', {class:'item '+(state.cur===p.name?'sel':''), onclick:()=>{state.cur=p.name;loadDetail();}},
      el('div', {class:'row'}, el('span',{class:'n'},p.name),
        el('span',{class:'badge'},p.enabled?'启用':'禁用')),
      el('div',{class:'d'},p.description||'—')));
  }
  return aside;
}

async function loadPlugins() {
  const r = await api('/plugins');
  state.plugins = r.data || [];
  if (!state.cur && state.plugins.length) state.cur = state.plugins[0].name;
  render();
  if (state.cur) loadDetail();
}

async function loadDetail() {
  if (!state.cur) return;
  const r = await api('/plugins/'+encodeURIComponent(state.cur));
  state.detail = r;
  if (state.tab === '插件') render();
}

function pluginDetailPane() {
  const s = el('section');
  if (!state.detail || !state.detail.ok) { s.append(el('div',{class:'muted'},'选择左侧插件')); return s; }
  const d = state.detail.data;
  s.append(el('h2', {}, d.entry.name + ' v' + d.entry.version));
  s.append(el('div', {class:'row'},
    el('span',{class:'tag'}, d.kind),
    ...(d.entry.permissions||[]).map(p=>el('span',{class:'tag'},p)),
    d.entry.enabled ? el('span',{class:'tag ok'},'启用') : el('span',{class:'tag err'},'禁用')));
  s.append(el('p',{class:'muted'}, d.entry.description||''));
  s.append(el('div',{class:'row'},
    el('button',{class:'act',onclick:async()=>{
      await api('/plugins/'+encodeURIComponent(state.cur)+'/'+(d.entry.enabled?'disable':'enable'),{method:'POST'});
      await loadPlugins();
    }}, d.entry.enabled?'禁用':'启用'),
    el('button',{class:'act',onclick:async()=>{
      if(!confirm('确认卸载 '+state.cur+' ?')) return;
      await api('/plugins/'+encodeURIComponent(state.cur),{method:'DELETE'});
      state.cur=null;state.detail=null;await loadPlugins();
    }},'卸载'),
    el('button',{class:'act',onclick:async()=>{
      const r = await fetch('/api/plugins/'+encodeURIComponent(state.cur)+'/skill');
      const md = await r.text();
      const w = window.open('','_blank');
      const pre = document.createElement('pre');
      pre.textContent = md;
      w.document.body.append(pre);
    }},'查看 Skill')));
  s.append(el('h2',{},'参数 Schema'));
  s.append(el('pre',{}, JSON.stringify(d.schema, null, 2)));
  if (d.commands?.length) {
    s.append(el('h2',{},'子命令'));
    s.append(el('table',{}, el('tr',{},el('th',{},'名称'),el('th',{},'说明')),
      ...d.commands.map(c=>el('tr',{},el('td',{},c.name),el('td',{},c.description)))));
  }
  return s;
}

function debugPane() {
  const s = el('section');
  s.append(el('h2',{},'调试台'));
  const sel = el('select', {onchange:()=>{ state.cur = sel.value; }});
  for (const p of state.plugins) sel.append(el('option',{value:p.name, selected:p.name===state.cur?'':null}, p.name));
  const ta = el('textarea', {placeholder:'{"query":"AI 绘画"}'});
  const out = el('pre', {}, '(未执行)');
  s.append(el('div',{class:'row'}, sel,
    el('button',{class:'act primary',onclick:async()=>{
      out.textContent = '执行中…';
      let params = {};
      try { params = ta.value.trim()? JSON.parse(ta.value): {}; } catch(e){ out.textContent='参数 JSON 解析失败: '+e.message; return; }
      const r = await api('/run',{method:'POST',body:JSON.stringify({plugin: sel.value, params})});
      out.textContent = (r.logs?.length? '# 进度\n'+r.logs.join('\n')+'\n\n' : '') + JSON.stringify(r, null, 2);
    }},'执行')));
  s.append(ta);
  s.append(out);
  return s;
}

function rulesPane() {
  const s = el('section');
  s.append(el('h2',{},'提取规则'));
  if (!state.cur) { s.append(el('div',{class:'muted'},'先在插件页选择插件')); return s; }
  const nameInput = el('input',{placeholder:'规则名，例如 product'});
  const ta = el('textarea',{placeholder:'fields:\n  - name: 标题\n    selector: "h1"\n    type: text'});
  const list = el('pre',{},'加载中…');
  const refresh = async () => {
    const r = await api('/plugins/'+encodeURIComponent(state.cur)+'/rules');
    list.textContent = JSON.stringify(r.data, null, 2);
  };
  s.append(el('div',{class:'row'}, nameInput, el('button',{class:'act primary',onclick:async()=>{
    const r = await api('/plugins/'+encodeURIComponent(state.cur)+'/rules',{method:'POST',body:JSON.stringify({name:nameInput.value||'rule',content:ta.value})});
    alert(r.ok?'已保存: '+r.data.file:'失败: '+r.error);
    refresh();
  }},'保存到 '+state.cur)));
  s.append(ta);
  refresh();
  s.append(el('h2',{},'当前规则'));
  s.append(list);
  return s;
}

function logsPane() {
  const s = el('section');
  s.append(el('h2',{},'调用日志'));
  const out = el('pre',{},'加载中…');
  const onlyErr = el('input',{type:'checkbox'});
  const refresh = async () => {
    const r = await api('/logs?limit=200'+(onlyErr.checked?'&error=1':''));
    out.textContent = (r.data||[]).map(e=>e.ts+' '+(e.ok?'OK  ':'FAIL')+' '+e.plugin+(e.command?':'+e.command:'')+' '+e.ms+'ms '+e.summary).join('\n') || '(无日志)';
  };
  s.append(el('div',{class:'row'}, el('label',{}, onlyErr, ' 只看失败'),
    el('button',{class:'act',onclick:refresh},'刷新')));
  s.append(out);
  refresh();
  return s;
}

function configPane() {
  const s = el('section');
  s.append(el('h2',{},'全局配置'));
  const ta = el('textarea',{style:'min-height:340px'});
  const load = async()=>{ const r = await api('/config'); ta.value = JSON.stringify(r.data,null,2); };
  load();
  s.append(ta);
  s.append(el('div',{class:'row'}, el('button',{class:'act primary',onclick:async()=>{
    let patch; try{ patch = JSON.parse(ta.value);}catch(e){alert('JSON 非法: '+e.message);return;}
    const r = await api('/config',{method:'PUT',body:JSON.stringify({patch})});
    ta.value = JSON.stringify(r.data,null,2); alert('已保存');
  }},'保存')));
  return s;
}

function templatesPane() {
  const s = el('section');
  s.append(el('h2',{},'模板库'));
  const kw = el('input',{placeholder:'搜索关键词'});
  const out = el('div');
  const refresh = async()=>{
    const r = await api('/templates'+(kw.value?'?q='+encodeURIComponent(kw.value):''));
    out.innerHTML='';
    const list = r.data||[];
    if(!list.length) out.append(el('div',{class:'muted'},'暂无模板'));
    for (const t of list) {
      out.append(el('div',{class:'row'}, el('strong',{},t.name), el('span',{class:'tag'},'v'+t.version),
        el('span',{class:'muted'},t.description||''),
        t.installed? el('span',{class:'tag ok'},'已安装') : el('button',{class:'act',onclick:async()=>{
          const r = await api('/templates/install',{method:'POST',body:JSON.stringify({name:t.name})});
          alert(r.ok?'已安装 '+t.name:'失败: '+r.error);
          await refresh(); await loadPlugins();
        }},'安装')));
    }
  };
  s.append(el('div',{class:'row'}, kw, el('button',{class:'act',onclick:refresh},'搜索'), el('button',{class:'act',onclick:refresh},'刷新')));
  s.append(out);
  refresh();
  return s;
}

loadPlugins();
`;

export function ensureWebAssets(): string {
  ensure();
  return WEB;
}

export const webRoot = WEB;
