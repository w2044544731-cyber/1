import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { publishPayload, publishPreview, createPublisher, PUBLISH_PATH } from '../lib/erp-publish.js';
const payload = { shopIds: [22,11], detailIds: [44,33] };
const env = { ERP_API_BASE_URL: 'https://erp.example.test', ERP_COOKIE: 'test-cookie-only', ERP_TIMER_TOKEN: 'test-token-only', ERP_PUBLISH_SUCCESS_CODE: 'OK', ERP_PUBLISH_ENABLED: 'true' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('publish payload validates exact ID arrays and previews without secrets', () => {
  assert.deepEqual(publishPayload(payload), { shopIds: [11,22], detailIds: [33,44] });
  for (const bad of [[], [0], ['123'], [1,1], [Number.MAX_SAFE_INTEGER + 1], Array(201).fill(1)]) assert.throws(() => publishPayload({ shopIds: bad, detailIds: [1] }));
  const preview = publishPreview(payload, env);
  assert.equal(preview.configured, true); assert.equal(preview.localChangesUploaded, false);
  assert.equal(preview.path, PUBLISH_PATH);
  assert.ok(!JSON.stringify(preview).includes(env.ERP_COOKIE)); assert.ok(!JSON.stringify(preview).includes(env.ERP_TIMER_TOKEN));
  assert.equal(publishPreview(payload, {}).configured, false);
  assert.equal(publishPreview(payload, { ...env, ERP_API_BASE_URL: 'http://erp.example.test' }).configured, false);
});
test('adapter uses documented query/header/body and only confirms accepted request', async () => {
  let calls = 0;
  const publisher = createPublisher({ env, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, env.ERP_API_BASE_URL); assert.equal(url.pathname, PUBLISH_PATH);
    assert.equal(url.searchParams.get('timerToken'), env.ERP_TIMER_TOKEN); assert.equal(options.headers.Cookie, env.ERP_COOKIE);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { shopIds: [11,22], detailIds: [33,44] });
    return response({ result: 'success', code: 'OK' });
  } });
  assert.equal((await publisher.submit(payload)).status, 'accepted'); assert.equal(calls, 1);
});
test('timeouts, ambiguous success, server errors and malformed responses remain unknown', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`Request failed ${env.ERP_TIMER_TOKEN}`); },
    async () => response({ result: 'success', code: 'OTHER' }),
    async () => response({ result: 'success', code: 'ERR', reason: 'failure' }, 500),
    async () => new Response('not-json'),
  ]) {
    const result = await createPublisher({ env, fetchImpl }).submit(payload);
    assert.equal(result.status, 'unknown'); assert.ok(!JSON.stringify(result).includes(env.ERP_TIMER_TOKEN));
  }
  assert.equal((await createPublisher({ env, fetchImpl: async () => response({ code: 'DENIED', reason: env.ERP_COOKIE }, 403) }).submit(payload)).status, 'rejected');
  const disabled = createPublisher({ env: {}, fetchImpl: () => { throw new Error('must not call'); } });
  await assert.rejects(disabled.submit(payload), error => error.status === 501);
});
test('HTTP publish confirms scope, persists jobs, reuses idempotent requests and blocks repeats', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'erp-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer({ dataDir: dir, publishEnv: env, publishFetch: async () => { calls++; return response({ result: 'success', code: 'OK' }); } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(url, data) { const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); return { status:r.status, data:await r.json() }; }
  assert.equal((await post('/api/publish/preview', payload)).status,200); assert.equal(calls,0);
  assert.equal((await post('/api/publish', payload)).status,400); assert.equal(calls,0);
  const data = { ...payload, requestId: randomUUID(), confirmed: true, acknowledgeRemoteOnly: true };
  const results = await Promise.all([post('/api/publish',data),post('/api/publish',data)]);
  assert.equal(calls,1); assert.ok(results.every(r=>r.status===200));
  const repeat = await post('/api/publish',data); assert.equal(repeat.data.reused,true); assert.equal(repeat.data.job.status,'accepted'); assert.equal(calls,1);
  assert.equal((await post('/api/publish',{...data,requestId:randomUUID()})).status,409); assert.equal(calls,1);
  assert.equal((await post('/api/publish',{...data,detailIds:[999]})).status,409);
  const state = await (await fetch(base+'/api/state')).json(); assert.equal(state.publishJobs.length,1); assert.equal(state.publishJobs[0].status,'accepted');
  const serialized=JSON.stringify(state); assert.ok(!serialized.includes(env.ERP_COOKIE)); assert.ok(!serialized.includes(env.ERP_TIMER_TOKEN));
});
