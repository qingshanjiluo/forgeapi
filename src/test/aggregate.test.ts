import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeResults, itemsFromBody, pick } from '../core/aggregate.js';

test('concat 合并保留全部', () => {
  const out = mergeResults([
    { name: 'a', items: [{ title: 'x' }, { title: 'y' }] },
    { name: 'b', items: [{ title: 'z' }] },
  ], { strategy: 'concat' });
  assert.equal(out.total, 3);
  assert.equal(out.results[0]['来源'], 'a');
  assert.equal(out.results[2]['来源'], 'b');
});

test('dedupe_by_title 去重并合并来源', () => {
  const out = mergeResults([
    { name: 'a', items: [{ title: 'Same Title', url: 'u1' }] },
    { name: 'b', items: [{ title: 'same title', url: 'u2' }] },
  ], { strategy: 'dedupe_by_title' });
  assert.equal(out.total, 1);
  const row = out.results[0];
  assert.equal(row['来源'], 'a,b');
  assert.equal(row['url'], 'u1');
});

test('dedupe 补全缺失字段', () => {
  const out = mergeResults([
    { name: 'a', items: [{ title: 'T', snippet: '' }] },
    { name: 'b', items: [{ title: 't', snippet: '补全内容' }] },
  ], { strategy: 'dedupe_by_key', key: 'title' });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]['snippet'], '补全内容');
});

test('limit 截断', () => {
  const items = Array.from({ length: 10 }, (_v, i) => ({ title: `t${i}` }));
  const out = mergeResults([{ name: 'a', items }], { strategy: 'concat', limit: 4 });
  assert.equal(out.total, 4);
});

test('sources 统计含错误', () => {
  const out = mergeResults([
    { name: 'ok', items: [1, 2] },
    { name: 'bad', items: [], error: 'HTTP 500' },
  ], { strategy: 'concat' });
  assert.deepEqual(out.sources, [
    { name: 'ok', count: 2, error: undefined },
    { name: 'bad', count: 0, error: 'HTTP 500' },
  ]);
});

test('itemsFromBody 自动找数组', () => {
  assert.deepEqual(itemsFromBody({ data: { results: [1, 2] } }, { name: 's', type: 'api' }), [1, 2]);
  assert.deepEqual(itemsFromBody([1, 2, 3], { name: 's', type: 'api' }), [1, 2, 3]);
  assert.deepEqual(itemsFromBody({ a: 1 }, { name: 's', type: 'api' }), [{ a: 1 }]);
});

test('itemsFromBody 使用 jsonpath', () => {
  const body = { payload: { nodes: [{ id: 1 }] } };
  assert.deepEqual(itemsFromBody(body, { name: 's', type: 'api', jsonpath: '$.payload.nodes' }), [{ id: 1 }]);
});

test('pick 支持点路径', () => {
  assert.equal(pick({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(pick({ a: 1 }, 'x.y'), undefined);
});