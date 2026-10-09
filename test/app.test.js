import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createStore, readiness, csv } from '../lib/store.js';
import { replaceEdgeBackground, chooseScene } from '../public/images.js';
import { parseCsv, parseImport } from '../public/importer.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
const complete = { title: '杯子', sku: 'CUP-1', category: '厨房', price: 10, currency: 'USD', stock: 100, sourceImage: png, processedImage: png };
async function directory(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'listing-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('product import, review, export, edit invalidation, restart persistence', async t => {
  const dir = await directory(t), store = createStore(dir);
  const [product] = await store.import([complete]);
  assert.equal(product.status, 'draft');
  assert.deepEqual(readiness(product), []);
  await assert.rejects(store.export([product.id], 'json'), /审核通过/);
  const reviewed = await store.review(product.id, 1);
  assert.equal(reviewed.status, 'ready');
  const exported = await store.export([product.id], 'json');
  assert.equal(JSON.parse(exported.content).products[0].processedImage, png);
  const restarted = createStore(dir);
  assert.equal((await restarted.list()).products[0].status, 'exported');
  const updated = await restarted.update(product.id, { revision: 3, price: 11 });
  assert.equal(updated.status, 'draft');
  assert.equal(updated.price, 11);
  await assert.rejects(restarted.update(product.id, { revision: 3, title: 'stale' }), error => error.status === 409);
  await assert.rejects(restarted.export([product.id], 'csv'), /审核通过/);
});
test('invalid batch is atomic; validation and image changes invalidate processed image', async t => {
  const store = createStore(await directory(t));
  await assert.rejects(store.import([complete, { price: -1 }]), /价格/);
  assert.equal((await store.list()).products.length, 0);
  await assert.rejects(store.import([{ sourceUrl: 'http://example.com' }]), /HTTPS/);
  await assert.rejects(store.import([{ sourceImage: 'data:image/svg+xml;base64,PHN2Zz4=' }]), /仅支持/);
  const [empty] = await store.import([{}]);
  await assert.rejects(store.review(empty.id, 1), /标题/);
  const [product] = await store.import([complete]);
  const updated = await store.update(product.id, { revision: 1, sourceImage: 'https://example.com/new.png' });
  assert.equal(updated.processedImage, '');
  await assert.rejects(store.review(product.id, 2), /已处理商品图/);
});
test('concurrent imports do not lose records and corrupted data is not overwritten', async t => {
  const dir = await directory(t), store = createStore(dir);
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.import([{ title: `Product ${i}` }])));
  assert.equal((await store.list()).products.length, 8);
  const filename = path.join(dir, 'products.json');
  await writeFile(filename, '{broken');
  await assert.rejects(store.import([{}]), /未覆盖/);
  assert.equal(await readFile(filename, 'utf8'), '{broken');
});
test('CSV import supports Chinese columns, quoting and empty fields; export escapes formulas', () => {
  const products = parseCsv('商品标题,SKU,价格,库存,主图链接\r\n"杯子,双层",C-1,12.5,0,\r\n"带""盖杯",C-2,,10,');
  assert.equal(products.length, 2);
  assert.equal(products[0].title, '杯子,双层');
  assert.equal(products[1].title, '带"盖杯');
  assert.equal(products[1].price, '');
  assert.equal(parseImport('{"name":"杯子","offers":{"price":5,"priceCurrency":"CNY"}}')[0].price, 5);
  assert.match(csv([{ ...complete, title: '=HYPERLINK("bad")', id: 'one' }]), /'=HYPERLINK/);
  assert.throws(() => parseCsv('wrong,field\nx,y'), /标题列/);
});
test('background extraction preserves enclosed white areas and foreground colors', () => {
  const pixels = new Uint8ClampedArray(5 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const p = (y * 5 + x) * 4;
    const light = x === 0 || x === 4 || y === 0 || y === 4 || (x === 2 && y === 2);
    pixels.set(light ? [245,245,245,255] : [50,80,60,255], p);
  }
  const result = replaceEdgeBackground(pixels, 5, 5, [10,20,30], 20);
  assert.equal(result.replaced, 16);
  assert.deepEqual([...result.pixels.subarray(0,4)], [10,20,30,255]);
  assert.deepEqual([...result.pixels.subarray(48,52)], [245,245,245,255]);
  assert.equal(result.mask[12], 0);
  assert.equal(chooseScene({ title: '保温杯', category: '厨房' }), 'kitchen');
  assert.equal(chooseScene({ title: '键盘', category: '办公' }), 'desk');
});
test('HTTP complete workflow, static assets, cross-origin protection and unconfigured upload', async t => {
  const server = createServer({ dataDir: await directory(t), publishEnv: {}, sceneEnv: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, data, method = 'POST', extra = {}) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await (await fetch(base + '/health')).json()).app, 'listing-workbench');
  for (const [url, type] of [['/', 'text/html'], ['/app.js','text/javascript'], ['/images.js','text/javascript'], ['/importer.js','text/javascript'], ['/style.css','text/css']]) {
    const response = await fetch(base + url); assert.equal(response.status, 200); assert.ok(response.headers.get('Content-Type').startsWith(type)); assert.ok((await response.text()).length > 20);
  }
  assert.equal((await fetch(base + '/.local-data/products.json')).status, 404);
  assert.equal((await request('/api/import', { products: [complete] }, 'POST', { Origin: 'https://bad.example' })).status, 403);
  assert.equal((await request('/api/import', null)).status, 400);
  const imported = await request('/api/import', { products: [complete] }); assert.equal(imported.status, 201);
  const id = imported.data[0].id;
  assert.equal((await request(`/api/products/${id}/review`, { revision: 1 })).status, 200);
  const exported = await request('/api/export', { ids: [id], format: 'csv' }); assert.equal(exported.status, 200); assert.ok(exported.data.content.includes('CUP-1'));
  const publish = await request('/api/publish', { ids: [id] }); assert.equal(publish.status, 501);
  assert.equal((await (await fetch(base + '/api/integrations')).json()).upload.enabled, false);
  assert.equal((await request(`/api/products/${id}`, { revision: 3 }, 'DELETE')).status, 200);
  assert.equal((await (await fetch(base + '/api/state')).json()).products.length, 0);
});

test('bulk edit rules preserve missing prices and compute rounding safely', async () => {
  const { editRules } = await import('../public/rules.js');
  assert.deepEqual(editRules({ title: '杯子', price: 12.99, stock: 10 }, { prefix: '新款 ', markup: 10, stock: '0' }), { title: '新款 杯子', price: 14.29, stock: 0 });
  assert.equal(editRules({ title: '杯子', price: null, stock: null }).price, null);
  assert.throws(() => editRules(complete, { markup: -100 }), /比例/);
  assert.throws(() => editRules(complete, { stock: 2.5 }), /库存/);
});
