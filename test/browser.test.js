import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.js';
import { createStore } from '../lib/store.js';
import { createBrowserAssistant, normalizeRecipe, browserUrl } from '../lib/browser-assistant.js';
import { demoPng } from '../lib/demo.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
const recipe = () => ({ name: 'Test original training page', guard: { selector: '#identity' }, shop: { selector: '#shop' }, shopText: '演示店铺 7', extract: { title: { selector: '#title' }, sku: { selector: '#sku' }, category: { selector: '#category' }, image: { selector: '#original' } }, steps: [{ type: 'upload', selector: '#upload' }, { type: 'save', selector: '#save', success: { selector: '#save-result', expected: '图片已保存' } }, { type: 'publish', selector: '#publish', success: { selector: '#publish-result', expected: '发布任务已提交' } }] });

test('browser recipe enforces upload-save-publish order, identity, and credential-free URLs', () => {
  assert.equal(normalizeRecipe(recipe()).steps.length, 3);
  const wrong = recipe(); [wrong.steps[0], wrong.steps[1]] = [wrong.steps[1], wrong.steps[0]];
  assert.throws(() => normalizeRecipe(wrong), /保存须在上传之后/);
  assert.throws(() => normalizeRecipe({ ...recipe(), shopText: '' }), /店铺识别文字/);
  const missing = recipe(); missing.steps[2].success.expected = '';
  assert.throws(() => normalizeRecipe(missing), /成功提示文字/);
  assert.throws(() => browserUrl('https://erp.example/product?token=private'), /凭证/);
  assert.throws(() => browserUrl('https://erp.example/#access_token=private'), /凭证/);
  assert.throws(() => browserUrl('http://127.0.0.1:3000/api/state', 'http://127.0.0.1:3000'), /HTTPS/);
});

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'browser-workbench-'));
  const server = createServer({ dataDir: path.join(dir, 'server'), publishEnv: {}, sceneEnv: {}, browserEnv: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = createStore(path.join(dir, 'data')); let context;
  const executablePath = process.env.BROWSER_TEST_EXECUTABLE || (process.platform === 'linux' ? '/usr/bin/chromium' : undefined);
  const assistant = createBrowserAssistant({ directory: path.join(dir, 'data'), store, env: { BROWSER_HEADLESS: 'true', BROWSER_STEP_TIMEOUT_MS: '1000' }, launch: async options => {
    delete options.channel; if (!executablePath && process.platform === 'win32') options.channel = 'msedge';
    context = await chromium.launchPersistentContext(path.join(dir, 'profile'), { ...options, ...(executablePath ? { executablePath } : {}), viewport: { width: 1280, height: 900 } }); return context;
  } });
  assistant.setDemoOrigin(base);
  t.after(async () => { await assistant.close(); await server.browserAssistant.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const url = id => `${base}/browser-demo/editor?id=${id}`;
  await assistant.open({ url: url(101) });
  async function product(id) {
    await assistant.open({ url: url(id) });
    const captured = await assistant.capture({ recipe: recipe(), expectedText: 'DEMO-' + id });
    const updated = await store.update(captured.product.id, { revision: 1, processedImage: png });
    return { productId: updated.id, revision: updated.revision, url: url(id), expectedText: 'DEMO-' + id };
  }
  const enqueue = (items, extra = {}) => assistant.enqueue({ recipe: recipe(), requestId: crypto.randomUUID(), items, imagesReviewed: true, pauseBeforePublish: false, ...extra });
  async function wait(id, state) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const job = (await assistant.status()).jobs.find(job => job.id === id);
      if (job?.status === state) return job;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail(`Expected ${state}; got ${JSON.stringify((await assistant.status()).jobs)}`);
  }
  return { dir, base, assistant, store, product, enqueue, wait, page: () => context.pages()[0], remote: async id => (await fetch(`${base}/browser-demo/api/product?id=${id}`)).json() };
}

test('real Chromium picks a control without activating it, reads an original image, uploads two replacements and publishes once', { timeout: 30_000 }, async t => {
  const env = await setup(t);
  await env.assistant.pick({ key: 'choose-save' });
  await env.page().locator('#save').click();
  const picked = (await env.assistant.status()).picked;
  assert.equal(picked.selector, 'button[id="save"]');
  assert.equal(await env.page().locator('#save-result').innerText(), '');
  const one = await env.product(101), two = await env.product(102);
  assert.equal((await env.store.list()).products[0].sourceImage, 'data:image/png;base64,' + demoPng().toString('base64'));
  const job = await env.enqueue([one, two]);
  assert.equal((await env.enqueue([one, two], { requestId: job.requestId })).id, job.id);
  await assert.rejects(env.enqueue([two], { requestId: job.requestId }), /同一请求 ID/);
  const finished = await env.wait(job.id, 'completed');
  assert.equal(finished.items.length, 2);
  assert.ok(finished.items.every(item => item.steps.every(step => step.state === 'completed')));
  assert.ok(finished.items.every(item => !Object.hasOwn(item, 'image')));
  for (const id of [101,102]) { const remote = await env.remote(id); assert.equal(remote.savedImage, png); assert.equal(remote.saveCount, 1); assert.equal(remote.publishCount, 1); }
  assert.equal((await env.enqueue([one, two], { requestId: job.requestId })).id, job.id);
  await assert.rejects(env.enqueue([one]), /相同商品与图片/);
});

test('wrong item or shop pauses before upload; calibration can resume without replaying completed steps', { timeout: 30_000 }, async t => {
  const env = await setup(t), one = await env.product(101);
  const wrong = recipe(); wrong.guard.selector = 'input';
  const job = await env.enqueue([one], { recipe: wrong });
  assert.equal((await env.wait(job.id, 'paused')).items[0].steps.length, 0);
  assert.equal((await env.remote(101)).saveCount, undefined);
  await env.assistant.repair({ jobId: job.id, recipe: recipe() });
  await env.assistant.control(job.id, 'resume');
  await env.wait(job.id, 'completed');
  assert.equal((await env.remote(101)).publishCount, 1);
  const two = await env.product(102);
  const mismatch = await env.enqueue([{ ...two, expectedText: 'DEMO-10' }]);
  assert.match((await env.wait(mismatch.id, 'paused')).message, /识别文字不一致/);
  await env.assistant.control(mismatch.id, 'stop');
  const badShop = recipe(); badShop.shopText = '演示店铺 8';
  const shopJob = await env.enqueue([two], { recipe: badShop });
  assert.match((await env.wait(shopJob.id, 'paused')).message, /店铺/);
  assert.equal((await env.remote(102)).saveCount, undefined);
});

test('manual review pauses after exactly one save; stopping prevents publication and subsequent products', { timeout: 30_000 }, async t => {
  const env = await setup(t), one = await env.product(101), two = await env.product(102);
  const job = await env.enqueue([one, two], { pauseBeforePublish: true });
  await env.assistant.control(job.id, 'pause');
  const manual = await env.wait(job.id, 'paused');
  assert.match(manual.message, /接管/);
  assert.equal((await env.remote(101)).saveCount, undefined);
  await env.assistant.control(job.id, 'resume');
  const paused = await env.wait(job.id, 'paused');
  assert.equal(paused.items[0].stepIndex, 2);
  assert.equal((await env.remote(101)).saveCount, 1);
  await env.assistant.control(job.id, 'resume');
  await env.wait(job.id, 'paused');
  assert.equal((await env.remote(101)).publishCount, 1);
  assert.equal((await env.remote(102)).saveCount, 1);
  await env.assistant.control(job.id, 'stop');
  assert.equal((await env.remote(102)).publishCount, undefined);
  assert.equal((await env.wait(job.id, 'stopped')).items[1].status, 'stopped');
});

test('missing save confirmation leaves an unknown result, prevents publication, resume and duplicate execution', { timeout: 30_000 }, async t => {
  const env = await setup(t), one = await env.product(101);
  const missing = recipe(); missing.steps[1].success.selector = '#absent-success';
  const job = await env.enqueue([one], { recipe: missing });
  const unknown = await env.wait(job.id, 'unknown');
  assert.equal(unknown.items[0].steps[1].state, 'unknown');
  assert.equal((await env.remote(101)).saveCount, 1);
  assert.equal((await env.remote(101)).publishCount, undefined);
  await assert.rejects(env.assistant.control(job.id, 'resume'), /结果未知/);
  await assert.rejects(env.enqueue([one]), /相同商品与图片/);
});

test('browser job restart does not replay an in-flight publication', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'browser-recover-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'browser-jobs.json');
  await writeFile(file, JSON.stringify({ recipe: null, jobs: [{ id: 'old', status: 'running', items: [{ status: 'running', steps: [{ type: 'publish', state: 'sending' }] }] }] }));
  const assistant = createBrowserAssistant({ directory: dir, store: createStore(dir), launch: () => assert.fail('must not launch') });
  const job = (await assistant.status()).jobs[0];
  assert.equal(job.status, 'unknown');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).jobs[0].status, 'unknown');
  await assistant.close();
});
