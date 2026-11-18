import http from 'node:http';

const items = [1, 2, 3].map((i) =>
  `<article class="item"><h3><a href="/p/${i}">第${i}篇 标题足够长以通过断言</a></h3><p>摘要${i}</p></article>`).join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>测试列表</title></head>
<body>${items}</body></html>`;

const port = Number(process.argv[2] || 8791);
const s = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
s.listen(port, '127.0.0.1', () => {
  console.log(`listening http://127.0.0.1:${port}/ (${html.length} bytes)`);
});
setTimeout(() => { console.log('exit'); process.exit(0); }, Number(process.argv[3] || 120000));