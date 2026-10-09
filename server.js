import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createStore, AppError } from './lib/store.js';
import { createPublisher, publishPayload, payloadFingerprint } from './lib/erp-publish.js';
import { createDetailsReader } from './lib/erp-details.js';
import { createScenePlanner } from './lib/scene-planner.js';
import { createMiaoshouClient } from './lib/miaoshou.js';
import { createCollectBox } from './lib/collect-box.js';
import { createProductImages } from './lib/product-images.js';
import { createWorkflows } from './lib/workflows.js';
import { createDemo } from './lib/demo.js';
import { createBrowserAssistant } from './lib/browser-assistant.js';
import { createBrowserDemo } from './lib/browser-demo.js';

const routes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/images.js': ['images.js', 'text/javascript; charset=utf-8'],
  '/rules.js': ['rules.js', 'text/javascript; charset=utf-8'],
  '/importer.js': ['importer.js', 'text/javascript; charset=utf-8'],
  '/workflow-ui.js': ['workflow-ui.js', 'text/javascript; charset=utf-8'],
  '/browser-ui.js': ['browser-ui.js', 'text/javascript; charset=utf-8'],
  '/browser-demo': ['browser-demo.html', 'text/html; charset=utf-8'],
  '/browser-demo/editor': ['browser-demo.html', 'text/html; charset=utf-8'],
  '/browser-demo.js': ['browser-demo.js', 'text/javascript; charset=utf-8'],
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('请发送 application/json', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12_000_000) throw new AppError('单次请求超过 12 MB，请分批导入或缩小图片', 413);
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new AppError('JSON 格式无效'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AppError('请求内容须为 JSON 对象');
  return parsed;
}
export function createServer({ dataDir = process.env.DATA_DIR || fileURLToPath(new URL('./.local-data/', import.meta.url)), publishEnv = process.env, publishFetch = fetch, sceneEnv = process.env, sceneFetch = fetch, imageFetch = fetch, browserEnv = process.env, demoMode = publishEnv.WORKFLOW_DEMO === 'true' } = {}) {
  const demo = demoMode ? createDemo() : null;
  const erpEnv = demo ? { ...publishEnv, ...demo.env } : publishEnv;
  const erpFetch = demo ? demo.fetch : publishFetch;
  const store = createStore(dataDir);
  const publisher = createPublisher({ env: erpEnv, fetchImpl: erpFetch });
  const reader = createDetailsReader({ env: erpEnv, fetchImpl: erpFetch });
  const planner = createScenePlanner({ env: sceneEnv, fetchImpl: sceneFetch });
  const client = createMiaoshouClient({ env: erpEnv, fetchImpl: erpFetch });
  const collectBox = createCollectBox({ client, env: erpEnv, demo: demoMode, demoImage: demo?.image });
  const images = createProductImages({ directory: dataDir, env: erpEnv, fetchImpl: imageFetch, demoImage: demo?.image });
  const workflows = createWorkflows({ store, client, images, env: erpEnv, demo: demoMode });
  const assistant = createBrowserAssistant({ directory: dataDir, store, env: browserEnv });
  const browserDemo = createBrowserDemo();
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) { json(405, { error: '不支持此方法' }); return; }
      if (!['GET', 'HEAD'].includes(method) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== erpEnv.APP_ORIGIN) throw new AppError('不接受其他网站发起的修改', 403);
      if (pathname.startsWith('/api/browser')) {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !/^((localhost|127\.0\.0\.1)(:\d+)?|\[::1\](:\d+)?)$/.test(req.headers.host || '')) throw new AppError('浏览器助手仅允许从本机控制', 403);
        if (pathname === '/api/browser/status' && method === 'GET') { json(200, await assistant.status()); return; }
        if (method === 'POST') {
          const data = await body(req);
          if (pathname === '/api/browser/open') { json(200, await assistant.open(data)); return; }
          if (pathname === '/api/browser/pick') { json(200, await assistant.pick(data)); return; }
          if (pathname === '/api/browser/recipe') { json(200, await assistant.saveRecipe(data)); return; }
          if (pathname === '/api/browser/repair') { json(200, await assistant.repair(data)); return; }
          if (pathname === '/api/browser/capture') { json(201, await assistant.capture(data)); return; }
          if (pathname === '/api/browser/jobs') { json(202, await assistant.enqueue(data)); return; }
          const control = pathname.match(/^\/api\/browser\/jobs\/([a-f0-9-]+)\/(stop|pause|resume)$/);
          if (control) { json(200, await assistant.control(control[1], control[2])); return; }
        }
      }
      if (pathname.startsWith('/browser-demo/api/')) { const result = browserDemo.request(pathname, method, method === 'POST' ? await body(req) : new URL(req.url, 'http://localhost').searchParams); json(result.status, result.data); return; }
      if (pathname === '/browser-demo/source.png' && ['GET', 'HEAD'].includes(method)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(method === 'HEAD' ? undefined : browserDemo.image); return; }
      if (pathname === '/health' && ['GET', 'HEAD'].includes(method)) { json(200, { status: 'ok', app: 'listing-workbench' }); return; }
      if (pathname === '/api/state' && method === 'GET') { json(200, await store.list()); return; }
      if (pathname === '/api/integrations' && method === 'GET') {
        json(200, { demo: demoMode, erp: { connected: false, ...publisher.configuration() }, collection: reader.configuration(), commonCollection: client.configuration(), workflow: workflows.configuration(), images: images.configuration(), sceneText: planner.configuration(), temu: { connected: false }, upload: { enabled: publisher.configuration().configured, scope: 'erp_existing_records' }, localChangesSync: { supported: workflows.configuration().configured, fields: ['primary_image'] }, message: '已实现换图保存与发布队列；配置状态不代表真实店铺连接，最终上架状态查询待接入' }); return;
      }
      if (pathname === '/api/collect-box/list' && method === 'POST') { json(200, await collectBox.list(await body(req))); return; }
      if (pathname === '/api/collect-box/import' && method === 'POST') { const data = await body(req); json(201, await store.importErp(await collectBox.read(data.detailId))); return; }
      if (pathname === '/api/workflows/preview' && method === 'POST') { json(200, await workflows.preview(await body(req))); return; }
      if (pathname === '/api/workflows' && method === 'POST') { json(202, await workflows.enqueue(await body(req))); return; }
      const stop = pathname.match(/^\/api\/workflows\/([a-f0-9-]+)\/stop$/);
      if (stop && method === 'POST') { await body(req); json(200, await store.stopWorkflow(stop[1])); return; }
      const imageRoute = pathname.match(/^\/api\/products\/([a-f0-9-]+)\/(source-image|ai-image)$/);
      if (imageRoute) {
        const product = (await store.list()).products.find(product => product.id === imageRoute[1]);
        if (!product) throw new AppError('商品不存在', 404);
        if (imageRoute[2] === 'source-image' && method === 'GET') { json(200, { image: await images.source(product) }); return; }
        if (imageRoute[2] === 'ai-image' && method === 'POST') {
          const data = await body(req);
          if (data.revision !== product.revision) throw new AppError('商品版本已变化，请刷新', 409);
          if ((await store.list()).workflowJobs.some(job => ['queued','running'].includes(job.status) && job.items.some(item => item.productId === product.id))) throw new AppError('自动任务中的商品暂不能编辑图片', 409);
          json(200, await store.update(product.id, { ...await images.edit(product, data), revision: data.revision })); return;
        }
      }
      if (pathname.startsWith('/media/') && ['GET', 'HEAD'].includes(method)) {
        const content = await images.readMedia(pathname.slice('/media/'.length));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); res.end(method === 'HEAD' ? undefined : content); return;
      }
      if (pathname === '/api/scene/plan' && method === 'POST') { json(200, await planner.plan(await body(req))); return; }
      if (pathname === '/api/erp/details/read' && method === 'POST') { const product = await reader.read(await body(req)); json(201, await store.importErp(product)); return; }
      if (pathname === '/api/erp/details/import' && method === 'POST') { const data = await body(req); const product = reader.importResponse(data.response, data.request); json(201, await store.importErp(product)); return; }
      if (pathname === '/api/import' && method === 'POST') { json(201, await store.import((await body(req)).products)); return; }
      if (pathname === '/api/export' && method === 'POST') { const data = await body(req); json(200, await store.export(data.ids, data.format)); return; }
      if (pathname === '/api/publish/preview' && method === 'POST') { json(200, publisher.preview(await body(req))); return; }
      if (pathname === '/api/publish' && method === 'POST') {
        const data = await body(req);
        if (!publisher.configuration().configured) throw new AppError('ERP 发布接口尚未配置完整；只能预览参数', 501);
        if (data.confirmed !== true || data.acknowledgeRemoteOnly !== true) throw new AppError('请确认目标店铺，并确认发布的是 ERP 现有商品，不含本地编辑和场景图');
        const payload = publishPayload(data);
        const reservation = await store.reservePublish({ requestId: data.requestId, fingerprint: payloadFingerprint(payload), payload });
        if (!reservation.created) { json(200, { job: reservation.job, reused: true }); return; }
        const result = await publisher.submit(payload);
        const job = await store.finishPublish(reservation.job.id, result);
        json(200, { job, reused: false }); return;
      }
      const match = pathname.match(/^\/api\/products\/([a-f0-9-]+)(\/review)?$/);
      if (match) {
        if (method === 'POST' && match[2]) { json(200, await store.review(match[1], (await body(req)).revision)); return; }
        if (method === 'PATCH' && !match[2]) { json(200, await store.update(match[1], await body(req))); return; }
        if (method === 'DELETE' && !match[2]) { json(200, await store.remove(match[1], (await body(req)).revision)); return; }
      }
      const route = routes[pathname];
      if (route && ['GET', 'HEAD'].includes(method)) {
        const content = await readFile(new URL(`./public/${route[0]}`, import.meta.url));
        res.writeHead(200, {
          'Content-Type': route[1], 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(method === 'HEAD' ? undefined : content); return;
      }
      json(404, { error: '不存在此资源' });
    } catch (error) { json(error.status || 500, { error: error.status ? error.message : '服务异常，请查看本地服务日志' }); if (!error.status) console.error(error); }
  });
  server.on('listening', () => { const address = server.address(); if (address && typeof address === 'object') assistant.setDemoOrigin(`http://127.0.0.1:${address.port}`); });
  server.on('close', () => { workflows.close(); assistant.close().catch(error => console.error(error.message)); });
  server.browserAssistant = assistant;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Listing workbench listening on ${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
