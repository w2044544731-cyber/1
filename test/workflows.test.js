import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.js';
import { createStore } from '../lib/store.js';
import { createDemo } from '../lib/demo.js';
import { createMiaoshouClient, signRequest, COMMON_PREFIX, TEMU_PREFIX, PUBLISH_PATH } from '../lib/miaoshou.js';
import { createProductImages } from '../lib/product-images.js';
import { validateTemuShop } from '../lib/temu-validation.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-test-'));
  const demo = createDemo(), calls = [];
  const env = { ...demo.env, ...options.env };
  const erpFetch = async (url, input) => {
    const record = { path: new URL(url).pathname, body: JSON.parse(input.body), input }; calls.push(record);
    if (options.intercept) { const response = await options.intercept(record, demo); if (response) return response; }
    return demo.fetch(url, input);
  };
  const server = createServer({ dataDir: dir, publishEnv: env, publishFetch: erpFetch, imageFetch: options.imageFetch || (async () => new Response(Buffer.from(demo.image.split(',')[1], 'base64'))), sceneEnv: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  async function request(url, data, method = 'POST') {
    const response = await fetch(base + url, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  async function prepared() {
    const imported = await request('/api/collect-box/import', { detailId: 101 }); assert.equal(imported.status, 201);
    const changed = await request(`/api/products/${imported.data.id}`, { revision: 1, processedImage: demo.image }, 'PATCH'); assert.equal(changed.status, 200);
    const reviewed = await request(`/api/products/${imported.data.id}/review`, { revision: 2 }); assert.equal(reviewed.status, 200);
    return reviewed.data;
  }
  async function plan(product) {
    const input = { shopId: 7, products: [{ id: product.id, revision: product.revision }] };
    const response = await request('/api/workflows/preview', input); assert.equal(response.status, 200);
    return { input, plan: response.data };
  }
  async function submit(product) {
    const { input, plan: preview } = await plan(product); assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
    const data = { ...input, previewHash: preview.previewHash, requestId: randomUUID(), confirmed: true };
    const response = await request('/api/workflows', data); assert.equal(response.status, 202);
    return { data, id: response.data.job.id };
  }
  async function finished(id) {
    for (let count = 0; count < 150; count++) {
      const state = (await request('/api/state')).data, job = state.workflowJobs.find(job => job.id === id);
      if (job && !['queued', 'running'].includes(job.status)) return { job, state };
      await delay(20);
    }
    assert.fail('Workflow did not finish');
  }
  return { dir, demo, env, calls, base, request, prepared, plan, submit, finished };
}

test('HMAC matches independent golden vector and sends exactly the signed UTF-8 JSON', async () => {
  assert.equal(signRequest('test-secret', '/open/test', '1700000000', 'test-key', '{"title":"保温杯","zero":0}'), '4f0cf60b4530be153a3328c045e2e377913dc31f18e04cb5c00a7d3b21c89e50');
  let called = 0;
  const env = { MIAOSHOU_APP_KEY: 'test-key', MIAOSHOU_APP_SECRET: 'test-secret' };
  const client = createMiaoshouClient({ env, now: () => 1700000000123, fetchImpl: async (url, options) => {
    called++; assert.equal(url.origin, 'https://openapi-erp.91miaoshou.com'); assert.equal(options.headers['x-timestamp'], '1700000000');
    assert.equal(options.body, '{"title":"保温杯","zero":0}'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-sign'], signRequest(env.MIAOSHOU_APP_SECRET, url.pathname, '1700000000', env.MIAOSHOU_APP_KEY, options.body));
    return new Response('{"result":"success","code":"200","data":{}}');
  } });
  await client.request(COMMON_PREFIX + 'get_common_collect_box_list', { title: '保温杯', zero: 0 }); assert.equal(called, 1);
  await assert.rejects(client.request('/invented/upload', {}), error => error.status === 501);
  await assert.rejects(client.request(COMMON_PREFIX + 'claimed', {}, { write: true }), error => error.status === 501); assert.equal(called, 1);
});

test('signed client does not replay ambiguous writes or disclose echoed authorization', async () => {
  let calls = 0;
  const env = { MIAOSHOU_APP_KEY: 'key-only-test', MIAOSHOU_APP_SECRET: 'secret-only-test', MIAOSHOU_WRITE_ENABLED: 'true' };
  const client = createMiaoshouClient({ env, fetchImpl: async () => { calls++; return new Response('invalid'); } });
  await assert.rejects(client.request(COMMON_PREFIX + 'claimed', {}, { write: true }), error => error.outcome === 'unknown' && !error.message.includes(env.MIAOSHOU_APP_SECRET)); assert.equal(calls, 1);
  const echoed = createMiaoshouClient({ env, fetchImpl: async () => new Response(JSON.stringify({ result: 'success', code: '200', data: { appSecret: env.MIAOSHOU_APP_SECRET } })) });
  await assert.rejects(echoed.request(COMMON_PREFIX + 'get_common_collect_box_detail', {}), error => !error.message.includes(env.MIAOSHOU_APP_SECRET));
});

test('complete HTTP workflow saves new image, preserves SKU data, maps claim ID and submits only after readback', async t => {
  const f = await fixture(t), product = await f.prepared();
  const original = structuredClone(product.erpSource.snapshot), { id, data } = await f.submit(product);
  const { job, state } = await f.finished(id); assert.equal(job.status, 'accepted');
  assert.equal(job.items[0].temuDetailId, 1001); assert.equal(job.items[0].effects.length, 4);
  const commonSave = f.calls.find(call => call.path.endsWith('edit_common_collect_box_detail'));
  assert.equal(commonSave.body.ossMd5, 'demo-version-1'); assert.deepEqual(commonSave.body.editCommonCollectBoxDetail.skuMap, original.skuMap);
  assert.equal(commonSave.body.editCommonCollectBoxDetail.imgUrls[1], original.imgUrls[1]);
  const shopSave = f.calls.find(call => call.path.endsWith('demo_shop_save'));
  assert.equal(shopSave.body.detailId, 1001); assert.equal(shopSave.body.shopId, 7);
  assert.equal(shopSave.body.shopCollectItemInfo.preservedExtraField.demo, true);
  assert.equal(shopSave.body.shopCollectItemInfo.isBasePlate, 0);
  assert.deepEqual(f.calls.at(-1).body, { detailIds: [1001], shopIds: [7] });
  assert.equal(f.calls.at(-1).path, PUBLISH_PATH);
  const saved = state.products[0]; assert.deepEqual(saved.erpSource.snapshot, original);
  assert.ok(saved.erpSource.remoteSync.imageUrl.startsWith('https://demo.invalid/media/'));
  const mediaPath = new URL(saved.erpSource.remoteSync.imageUrl).pathname;
  const media = await fetch(f.base + mediaPath); assert.equal(media.status, 200); assert.equal(media.headers.get('Content-Type'), 'image/png');
  assert.equal((await fetch(f.base + '/media/../products.json')).status, 404);
  const count = f.calls.length; const repeated = await f.request('/api/workflows', data);
  assert.equal(repeated.data.reused, true); assert.equal(f.calls.length, count);
  assert.equal((await f.plan(saved)).plan.ready, false);
  assert.ok(!JSON.stringify(state).includes(f.env.MIAOSHOU_APP_SECRET));
});

test('missing official save contract blocks preview and prevents all remote writes', async t => {
  const f = await fixture(t, { env: { MIAOSHOU_SHOP_SAVE_PATH: '' } }), product = await f.prepared();
  const { input, plan } = await f.plan(product); assert.equal(plan.ready, false); assert.ok(plan.missing.some(value => value.includes('MIAOSHOU_SHOP_SAVE_PATH')));
  const before = f.calls.length;
  const result = await f.request('/api/workflows', { ...input, previewHash: plan.previewHash, requestId: randomUUID(), confirmed: true });
  assert.equal(result.status, 501); assert.equal(f.calls.length, before);
});

test('existing Temu shop record updates the shop image without a second common save or claim', async t => {
  const f = await fixture(t);
  await f.demo.fetch('https://demo.invalid' + CLAIM_PATH_FOR_TEST, { body: JSON.stringify({ detailSerialNumberPlatformList: [{ detailId: 101, platform: 'pddkj', serialNumber: 1 }] }) });
  const imported = await f.request('/api/erp/details/read', { shopId: 7, detailId: 1001 }); assert.equal(imported.status, 201);
  await f.request(`/api/products/${imported.data.id}`, { revision: 1, processedImage: f.demo.image }, 'PATCH');
  const reviewed = await f.request(`/api/products/${imported.data.id}/review`, { revision: 2 });
  const { id } = await f.submit(reviewed.data); assert.equal((await f.finished(id)).job.status, 'accepted');
  assert.ok(!f.calls.some(call => call.path.startsWith(COMMON_PREFIX)));
  assert.deepEqual(f.calls.at(-1).body, { detailIds: [1001], shopIds: [7] });
});

test('stopping a running batch completes its current product and does not start remaining products', async t => {
  let release, started; const startedPromise = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { intercept: async call => { if (call.path.endsWith('edit_common_collect_box_detail') && !release) { started(); await new Promise(resolve => { release = resolve; }); } } });
  const first = await f.prepared(), second = (await f.request('/api/collect-box/import', { detailId: 102 })).data;
  await f.request(`/api/products/${second.id}`, { revision: 1, processedImage: f.demo.image }, 'PATCH');
  await f.request(`/api/products/${second.id}/review`, { revision: 2 });
  const input = { shopId: 7, products: [{ id: first.id, revision: first.revision }, { id: second.id, revision: 3 }] };
  const plan = (await f.request('/api/workflows/preview', input)).data;
  const submitted = (await f.request('/api/workflows', { ...input, previewHash: plan.previewHash, requestId: randomUUID(), confirmed: true })).data;
  await startedPromise; await f.request(`/api/workflows/${submitted.job.id}/stop`, {}); release();
  const { job } = await f.finished(submitted.job.id); assert.equal(job.status, 'partial');
  assert.equal(job.items[0].status, 'accepted'); assert.equal(job.items[1].status, 'blocked');
  assert.equal(f.calls.filter(call => call.path.endsWith('edit_common_collect_box_detail')).length, 1);
  assert.equal(f.calls.filter(call => call.path === PUBLISH_PATH).length, 1);
});

test('stale preview and changed remote record fail without overwriting or publication', async t => {
  let change = false;
  const f = await fixture(t, { intercept: async (call, demo) => {
    if (change && call.path.endsWith('get_common_collect_box_detail')) { const response = await demo.fetch('https://demo.invalid' + call.path, call.input); const data = await response.json(); data.data.editCommonCollectBoxDetail.title = 'Updated by another user'; return new Response(JSON.stringify(data)); }
  } });
  const product = await f.prepared(), { input, plan } = await f.plan(product);
  assert.equal((await f.request('/api/workflows', { ...input, previewHash: 'stale', requestId: randomUUID(), confirmed: true })).status, 409);
  change = true; const { id } = await f.submit(product); assert.equal((await f.finished(id)).job.status, 'blocked');
  assert.ok(!f.calls.some(call => call.path === CLAIM_PATH_FOR_TEST || call.path === PUBLISH_PATH || call.path.endsWith('edit_common_collect_box_detail')));
});
const CLAIM_PATH_FOR_TEST = COMMON_PREFIX + 'claimed';

test('publication timeout stays unknown, same request is reused and a new request cannot replay it', async t => {
  const f = await fixture(t, { intercept: async call => { if (call.path === PUBLISH_PATH) throw new Error('timeout'); } });
  const product = await f.prepared(), submitted = await f.submit(product);
  const { job, state } = await f.finished(submitted.id); assert.equal(job.status, 'unknown');
  assert.equal(job.items[0].effects.at(-1).outcome, 'unknown');
  assert.equal((await f.request('/api/workflows', submitted.data)).data.reused, true);
  assert.equal(f.calls.filter(call => call.path === PUBLISH_PATH).length, 1);
  const next = await f.plan(state.products[0]); assert.equal(next.plan.ready, false); assert.ok(next.plan.blockers.some(x => x.message.includes('未知')));
});

test('unconfirmed remote image readback prevents claiming and publication', async t => {
  const f = await fixture(t, { intercept: async call => call.path.endsWith('edit_common_collect_box_detail') ? new Response('{"result":"success","code":"200","data":{}}') : null });
  const product = await f.prepared(), { id } = await f.submit(product), { job } = await f.finished(id);
  assert.equal(job.status, 'failed'); assert.ok(job.items[0].message.includes('未确认'));
  assert.ok(!f.calls.some(call => [CLAIM_PATH_FOR_TEST, PUBLISH_PATH].includes(call.path)));
});

test('public image content must be readable and match the prepared image before ERP writes', async t => {
  const f = await fixture(t, { imageFetch: async () => new Response('HTML error page') });
  const product = await f.prepared(), { id } = await f.submit(product), { job } = await f.finished(id);
  assert.equal(job.status, 'blocked'); assert.ok(job.items[0].message.includes('公网图片'));
  assert.ok(!f.calls.some(call => call.path.endsWith('edit_common_collect_box_detail')));
});

test('queued product locks protect edits, and restart stops interrupted writes without replay', async t => {
  let release, started; const startedPromise = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { intercept: async call => { if (call.path.endsWith('edit_common_collect_box_detail')) { started(); await new Promise(resolve => { release = resolve; }); } } });
  const product = await f.prepared(), { id } = await f.submit(product); await startedPromise;
  assert.equal((await f.request(`/api/products/${product.id}`, { revision: product.revision, title: 'Should not change' }, 'PATCH')).status, 409);
  release(); await f.finished(id);
  const data = JSON.parse(await readFile(path.join(f.dir, 'products.json'), 'utf8'));
  data.workflowJobs[0].status = 'running'; data.workflowJobs[0].items[0].status = 'running'; data.workflowJobs[0].items[0].effects.at(-1).outcome = 'sending';
  await writeFile(path.join(f.dir, 'products.json'), JSON.stringify(data));
  const restarted = createStore(f.dir); await restarted.recoverWorkflows(); const recovered = (await restarted.list()).workflowJobs[0];
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.items[0].status, 'unknown');
});

test('demo mode runs the full workflow without using supplied real ERP fetch or credentials', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-demo-'));
  const server = createServer({ dataDir: dir, publishEnv: {}, sceneEnv: {}, demoMode: true, publishFetch: () => { assert.fail('Real fetch must not run'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, data, method = 'POST') => { const result = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(result.ok); return result.json(); };
  assert.equal((await (await fetch(base + '/api/integrations')).json()).demo, true);
  const list = await post('/api/collect-box/list', {}); assert.equal(list.total, 2);
  const product = await post('/api/collect-box/import', { detailId: 101 }); assert.equal(product.isDemo, true); assert.ok(product.sourceImage.startsWith('data:'));
  await post(`/api/products/${product.id}`, { revision: 1, processedImage: product.sourceImage }, 'PATCH');
  await post(`/api/products/${product.id}/review`, { revision: 2 });
  const input = { shopId: 7, products: [{ id: product.id, revision: 3 }] }, plan = await post('/api/workflows/preview', input); assert.equal(plan.ready, true);
  await post('/api/workflows', { ...input, previewHash: plan.previewHash, requestId: randomUUID(), confirmed: true });
  for (let count = 0; count < 100; count++) { const state = await (await fetch(base + '/api/state')).json(); if (state.workflowJobs[0].status === 'accepted') { assert.equal(state.workflowJobs[0].demo, true); return; } await delay(20); }
  assert.fail('Demo did not complete');
});

test('image editor sends the original multipart image and rejects URL-only or unauthorized output', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'image-editor-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const demo = createDemo(), env = { SCENE_IMAGE_API_KEY: 'image-only-test', SCENE_IMAGE_BASE_URL: 'https://images.example.test/v1', SCENE_IMAGE_MODEL: 'gpt-image-1' };
  const images = createProductImages({ directory: dir, env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://images.example.test/v1/images/edits'); assert.equal(options.headers.Authorization, 'Bearer ' + env.SCENE_IMAGE_API_KEY);
    assert.ok(options.body instanceof FormData); assert.equal(options.body.get('image').type, 'image/png');
    assert.ok(options.body.get('prompt').includes('Preserve the product')); assert.equal(options.body.get('output_format'), 'png');
    return new Response(JSON.stringify({ data: [{ b64_json: demo.image.split(',')[1] }] }));
  } });
  const result = await images.edit({ sourceImage: demo.image }, { prompt: 'A quiet kitchen' }); assert.equal(result.processedImage, demo.image);
  const invalid = createProductImages({ directory: dir, env, fetchImpl: async () => new Response('{"data":[{"url":"https://elsewhere.example/image.png"}]}') });
  await assert.rejects(invalid.edit({ sourceImage: demo.image }, { prompt: 'A kitchen' }), /b64_json/);
  await assert.rejects(images.source({ sourceImage: 'https://127.0.0.1/internal.png' }), error => error.status === 501);
});

test('Temu baseline validation preserves zero-valued enums and blocks missing SKU dimensions', () => {
  const info = { detailId: 1, shopId: 2, cid: 3, title: 'Cup', productOriginCountry: 'CN', productOriginProvince: '浙江', outerPackageShape: 0, outerPackageType: 0, editModel: 0, isBasePlate: 0, imgUrls: ['https://example.test/image.png'], outerPackageImgUrls: ['https://example.test/package.png'], goodsLayerDecorationReqs: [{ type: 'text', content: {} }], attributes: [], saleAttributes: [], skuMap: { one: { length: '0.5', width: '1', height: '1', price: 0, weight: 0 } } };
  const rules = { data: { productAttributeRules: [], saleAttributeRules: [] } }, options = { data: {} };
  assert.deepEqual(validateTemuShop(info, rules, options), []);
  delete info.skuMap.one.length; assert.ok(validateTemuShop(info, rules, options).some(value => value.includes('length')));
});
