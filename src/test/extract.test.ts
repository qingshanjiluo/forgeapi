import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, extractFromJson, jsonpath, interpolate, detectKind } from '../core/extract.js';

const HTML = `<!doctype html><html><head><title>测试页</title>
<meta name="description" content="一个测试页面"></head>
<body>
  <h1 class="t">主标题</h1>
  <span class="price">￥1,299.00</span>
  <div class="review-item"><span class="user-name">张三</span><span class="review-content">很好</span></div>
  <div class="review-item"><span class="user-name">李四</span><span class="review-content">一般</span></div>
  <a href="/a">链接A</a><a href="https://x.com/b">链接B</a>
</body></html>`;

test('CSS 文本提取', () => {
  const r = extractFromHtml(HTML, [{ name: '标题', selector: 'h1.t' }]);
  assert.equal(r['标题'], '主标题');
});

test('meta 属性提取', () => {
  const r = extractFromHtml(HTML, [{ name: 'desc', selector: 'meta[name=description]', type: 'attr', attr: 'content' }]);
  assert.equal(r['desc'], '一个测试页面');
});

test('number 类型清洗', () => {
  const r = extractFromHtml(HTML, [{ name: 'price', selector: '.price', type: 'number' }]);
  assert.equal(r['price'], 1299);
});

test('list 嵌套字段', () => {
  const r = extractFromHtml(HTML, [{
    name: 'reviews',
    selector: '.review-item',
    type: 'list',
    fields: [
      { name: 'user', selector: '.user-name' },
      { name: 'content', selector: '.review-content' },
    ],
  }]);
  const arr = r['reviews'] as any[];
  assert.equal(arr.length, 2);
  assert.equal(arr[0].user, '张三');
  assert.equal(arr[1].content, '一般');
});

test('空选择器取节点自身', () => {
  const r = extractFromHtml(HTML, [{
    name: 'links',
    selector: 'a',
    type: 'list',
    fields: [
      { name: 'text', selector: '' },
      { name: 'href', selector: '', type: 'attr', attr: 'href' },
    ],
  }]);
  const arr = r['links'] as any[];
  assert.equal(arr.length, 2);
  assert.equal(arr[0].text, '链接A');
  assert.equal(arr[0].href, '/a');
});

test('url 类型提取', () => {
  const r = extractFromHtml(HTML, [{ name: 'u', selector: 'a', type: 'url' }]);
  assert.equal(r['u'], '/a');
});

test('正则提取', () => {
  const r = extractFromHtml(HTML, [{ name: 'm', selector: 're:￥([\\d,\\.]+)', kind: 'regex' }]);
  assert.equal(r['m'], '1,299.00');
});

test('缺失字段标 null / optional 跳过', () => {
  const r = extractFromHtml(HTML, [
    { name: 'missing', selector: '.nope' },
    { name: 'opt', selector: '.nope', optional: true },
  ]);
  assert.equal(r['missing'], null);
  assert.equal('opt' in r, false);
});

test('JSONPath 基本路径', () => {
  const j = { data: { items: [{ a: 1 }, { a: 2 }] } };
  const v = jsonpath(j, '$.data.items[*].a');
  assert.deepEqual(v, [1, 2]);
});

test('JSONPath 索引与负索引', () => {
  const j = { list: ['x', 'y', 'z'] };
  assert.deepEqual(jsonpath(j, '$.list[0]'), ['x']);
  assert.deepEqual(jsonpath(j, '$.list[-1]'), ['z']);
});

test('JSON 字段提取', () => {
  const j = { hits: [{ title: 'A', points: 5 }, { title: 'B', points: 9 }] };
  const r = extractFromJson(j, [
    { name: 'items', selector: '$.hits', type: 'list', fields: [{ name: 'title', selector: '$.title' }] },
    { name: 'first', selector: '$.hits[0].title' },
  ]);
  assert.deepEqual(r['items'], [{ title: 'A' }, { title: 'B' }]);
  assert.equal(r['first'], 'A');
});

test('选择器类型识别', () => {
  assert.equal(detectKind('h1'), 'css');
  assert.equal(detectKind('$.a.b'), 'jsonpath');
  assert.equal(detectKind('//div[@id]'), 'xpath');
  assert.equal(detectKind('re:abc'), 'regex');
  assert.equal(detectKind('h1', 'xpath'), 'xpath');
});

test('变量插值', () => {
  assert.equal(interpolate('hi ${name}', { name: '石井' }), 'hi 石井');
  assert.deepEqual(interpolate('${obj}', { obj: { a: 1 } }), { a: 1 });
  assert.equal(interpolate('${cred:K}', {}, () => 'secret'), 'secret');
  assert.equal(interpolate('${missing}', {}), '');
});