import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError, image } from './store.js';

const ACTIVE = ['running', 'paused'];
const text = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const privateHost = host => /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(host) || /\.(local|localhost)$/.test(host);
class Manual extends AppError {}

export function browserUrl(value, demoOrigin = '') {
  let url;
  try { url = new URL(value); } catch { throw new AppError('请输入完整的妙手网页地址'); }
  if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|cookie|authorization|api.?key/i.test(key)) || /[?&#][^=&#]*(token|secret|password|cookie|authorization|api.?key)[^=&#]*=/i.test(url.hash)) throw new AppError('网页地址不能包含账号或凭证参数，请使用普通编辑页面地址');
  if ((url.protocol !== 'https:' || privateHost(url.hostname)) && !(demoOrigin && url.origin === demoOrigin && url.pathname.startsWith('/browser-demo'))) throw new AppError('操作地址须为 HTTPS；本地地址仅允许软件自带的演示页面');
  return url.href;
}
function target(value, required = true) {
  const result = { selector: text(value?.selector, 500), frame: text(value?.frame, 500) };
  if (required && !result.selector) throw new AppError('请先选取网页中的操作位置');
  return result;
}
export function normalizeRecipe(input) {
  if (!input || typeof input !== 'object') throw new AppError('操作流程无效');
  const steps = input.steps;
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new AppError('流程需要 1–20 个步骤');
  const recipe = { name: text(input.name || '妙手换图发布', 80), guard: target(input.guard), shop: target(input.shop), shopText: text(input.shopText, 160), extract: {}, steps: [] };
  if (!recipe.shopText) throw new AppError('请填写网页中显示的目标店铺识别文字');
  for (const field of ['title', 'sku', 'category', 'image']) recipe.extract[field] = target(input.extract?.[field], false);
  let uploads = 0, saves = 0, publishes = 0;
  for (const step of steps) {
    if (!['click', 'upload', 'fill', 'wait', 'pause', 'save', 'publish'].includes(step.type)) throw new AppError('不支持的操作步骤');
    const item = { type: step.type, label: text(step.label || step.type, 80), ...target(step, step.type !== 'pause') };
    if (step.type === 'fill') { item.value = text(step.value, 1000); if (/password|passwd|cookie|token|secret/i.test(item.selector)) throw new AppError('流程不记录密码或凭证输入，请自行登录'); }
    if (step.type === 'wait') item.expected = text(step.expected, 200);
    if (['save', 'publish'].includes(step.type)) {
      item.success = { ...target(step.success), expected: text(step.success?.expected, 200) };
      if (!item.success.expected) throw new AppError('保存与发布步骤须填写网页成功提示文字');
    }
    if (step.type === 'upload') { uploads++; if (saves || publishes) throw new AppError('图片上传须在保存和发布之前'); }
    if (step.type === 'save') { saves++; if (!uploads || publishes) throw new AppError('保存须在上传之后、发布之前'); }
    if (step.type === 'publish') { publishes++; if (!saves) throw new AppError('须先保存再发布'); }
    recipe.steps.push(item);
  }
  if (uploads !== 1 || saves !== 1 || publishes > 1) throw new AppError('流程须有一次图片上传、一次保存，最多一次发布');
  if (publishes && recipe.steps.at(-1).type !== 'publish') throw new AppError('发布须为最后一步；确认弹窗按钮可设为发布步骤');
  return recipe;
}

// Runs only while the user explicitly picks a control. No input values, cookies,
// page HTML, keyboard activity, or browsing history are recorded.
function pickerScript({ key }) {
  window.__listingPickerCancel?.();
  const banner = document.createElement('div');
  banner.textContent = '商品流：点击要选取的位置（本次点击只选取，不触发按钮）；Esc 取消';
  Object.assign(banner.style, { position: 'fixed', zIndex: '2147483647', top: '8px', left: '8px', padding: '12px', background: '#28644e', color: 'white', font: '14px sans-serif', pointerEvents: 'none', borderRadius: '8px' });
  document.documentElement.append(banner);
  let highlighted, outline;
  const css = element => {
    const root = element.getRootNode();
    for (const attr of ['data-testid', 'id', 'name', 'aria-label']) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const selector = `${element.localName}[${attr}="${CSS.escape(value)}"]`;
      if (root.querySelectorAll(selector).length === 1) return root.host ? `${css(root.host)} >> ${selector}` : selector;
    }
    const parts = []; let node = element;
    while (node?.nodeType === 1) {
      const siblings = [...(node.parentElement?.children || root.children || [])].filter(child => child.localName === node.localName);
      parts.unshift(node.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
      node = node.parentElement;
    }
    return (root.host ? `${css(root.host)} >> ` : '') + parts.join(' > ');
  };
  const clear = () => { if (highlighted) highlighted.style.outline = outline; highlighted = null; };
  const cancel = () => { clear(); banner.remove(); document.removeEventListener('click', pick, true); document.removeEventListener('pointermove', hover, true); document.removeEventListener('keydown', keyboard, true); window.__listingPickerCancel = null; };
  const hover = event => { clear(); highlighted = event.composedPath()[0]; outline = highlighted.style?.outline; if (highlighted.style) highlighted.style.outline = '3px solid #36a875'; };
  const keyboard = event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); window.listingPick({ key, cancelled: true }); } };
  const pick = event => {
    event.preventDefault(); event.stopImmediatePropagation();
    let element = event.composedPath()[0];
    const label = element.closest?.('label');
    const file = label?.control || label?.querySelector('input[type=file]');
    if (file?.type === 'file') element = file;
    cancel(); window.listingPick({ key, selector: css(element), tag: element.localName, file: element.type === 'file' });
  };
  window.__listingPickerCancel = cancel;
  document.addEventListener('click', pick, true); document.addEventListener('pointermove', hover, true); document.addEventListener('keydown', keyboard, true);
}

export function createBrowserAssistant({ directory, store, env = process.env, launch = options => chromium.launchPersistentContext(path.join(directory, 'browser-profile'), options) }) {
  const filename = path.join(directory, 'browser-jobs.json');
  let context, page, opening = false, state, initializing, tail = Promise.resolve(), runner = null, closing = false, demoOrigin = '', picked = null, pickKey = null;
  const timeout = Math.max(500, Math.min(30_000, Number(env.BROWSER_STEP_TIMEOUT_MS) || 12_000));
  async function read() {
    if (state) return state;
    initializing ||= initialize();
    return initializing;
  }
  async function initialize() {
    try { state = JSON.parse(await readFile(filename, 'utf8')); if (!Array.isArray(state.jobs)) throw new Error('invalid'); }
    catch (error) { if (error.code !== 'ENOENT') throw new AppError('浏览器任务数据无法读取，未覆盖原文件', 500); state = { recipe: null, jobs: [] }; }
    let recovered = false;
    for (const job of state.jobs) if (ACTIVE.includes(job.status)) {
      const uncertain = job.items.some(item => item.steps.some(step => step.state === 'sending'));
      job.status = uncertain ? 'unknown' : 'stopped'; job.message = uncertain ? '服务中断，网页操作结果未知；请在妙手核对，禁止自动重放' : '服务重启，旧任务已停止；不会自动续跑';
      for (const item of job.items) if (['waiting', 'running', 'paused'].includes(item.status)) item.status = uncertain ? 'unknown' : 'stopped';
      recovered = true;
    }
    if (recovered) await persist();
    return state;
  }
  async function persist() {
    await mkdir(directory, { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2)); await rename(temporary, filename);
  }
  function transact(action) {
    const run = tail.then(async () => { await read(); const result = await action(state); await persist(); return result; });
    tail = run.catch(() => {}); return run;
  }
  function idle() { if (state?.jobs.some(job => ACTIVE.includes(job.status))) throw new AppError('请先停止当前任务再修改流程或打开其他页面', 409); }
  function browser() { if (!context || !page || page.isClosed()) throw new Manual('操作浏览器未打开，请先打开并登录妙手', 409); }
  function checkOrigin(origin) {
    browser();
    let current;
    try { current = browserUrl(page.url(), demoOrigin); } catch { throw new Manual('当前为登录、验证或其他页面，请自行完成后回到商品编辑页'); }
    if (new URL(current).origin !== origin) throw new Manual('当前网页与任务地址不同，请完成登录后回到妙手商品页');
  }
  function publicJob(job) {
    const copy = structuredClone(job);
    for (const item of copy.items) delete item.image;
    return copy;
  }
  async function locator(spec, { visible = true } = {}) {
    browser(); let root = page;
    if (spec.frame) {
      const frame = page.locator(spec.frame);
      if (await frame.count() !== 1) throw new Manual('框架位置不唯一或不存在，请重新选取');
      root = page.frameLocator(spec.frame);
    }
    const found = root.locator(spec.selector);
    try {
      if (await found.count() !== 1) throw new Manual(`位置不唯一或不存在：${spec.selector}。请重新选取后继续`);
      if (visible && !await found.isVisible()) throw new Manual('操作位置暂未显示，请处理网页弹窗或登录后继续');
      return found;
    } catch (error) { if (error instanceof AppError) throw error; throw new Manual('位置表达式无效，请重新选取'); }
  }
  async function content(spec) { const node = await locator(spec); if (await node.evaluate(el => el.type === 'password')) throw new Manual('不能读取密码输入框，请选取商品文字位置'); return text(await node.evaluate(el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? el.value : el.innerText), 2000); }
  function matches(actual, expected) {
    // Prevent SKU CUP-1 matching CUP-10 and detail ID 101 matching 1011.
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[\w-]+$/.test(expected) ? new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(actual) : actual.includes(expected);
  }
  async function identity(job, item) {
    checkOrigin(new URL(item.url).origin);
    if (!matches(await content(job.recipe.guard), item.expectedText)) throw new Manual('网页商品与任务的识别文字不一致，已暂停；请切回正确商品');
    if (!matches(await content(job.recipe.shop), job.recipe.shopText)) throw new Manual('网页店铺与任务的目标店铺不一致，已暂停；请核对店铺');
  }
  async function success(spec) {
    try { return matches(await content(spec), spec.expected); } catch { return false; }
  }
  async function waitSuccess(spec) {
    const end = Date.now() + timeout;
    do { if (await success(spec)) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end && !closing);
    throw new Error('Confirmation missing');
  }
  async function checkpoint(job, item, message) {
    await transact(() => { job.status = 'paused'; item.status = 'paused'; job.message = message; });
  }
  async function execute(job) {
    for (; job.itemIndex < job.items.length; job.itemIndex++) {
      const item = job.items[job.itemIndex];
      if (job.cancelRequested || closing) break;
      if (!item.opened) {
        try { browser(); await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout }); item.opened = true; await transact(() => {}); }
        catch { await checkpoint(job, item, '页面打开失败，请在操作浏览器中打开目标商品后继续'); return; }
      }
      await transact(() => { item.status = 'running'; });
      while (item.stepIndex < job.recipe.steps.length) {
        if (job.cancelRequested || closing) break;
        if (job.pauseRequested) { job.pauseRequested = false; await checkpoint(job, item, '已暂停，你可以接管操作浏览器；核对商品和店铺后继续'); return; }
        const step = job.recipe.steps[item.stepIndex];
        if (step.type === 'pause' || (step.type === 'publish' && job.pauseBeforePublish && !item.publishApproved)) {
          if (step.type === 'pause') item.stepIndex++;
          else item.publishApproved = true;
          await checkpoint(job, item, step.type === 'pause' ? step.label : '图片已保存，等待你核对后继续发布'); return;
        }
        let node;
        try {
          await identity(job, item);
          if (step.type === 'wait') { await waitSuccess(step.expected ? { ...step, expected: step.expected } : { ...step, expected: '' }); item.stepIndex++; await transact(() => {}); continue; }
          node = await locator(step, { visible: step.type !== 'upload' });
          if (step.type !== 'upload' && !await node.isEnabled()) throw new Manual('按钮或输入框尚不可操作，请处理页面提示后继续');
          if (['save', 'publish'].includes(step.type) && await success(step.success)) throw new Manual('网页已显示成功提示，无法判定是否是本次操作；请刷新核对后继续');
          if (step.type === 'fill' && await node.evaluate(el => el.type === 'password')) throw new Manual('密码由你自行输入，助手不记录登录内容');
        } catch (error) { await checkpoint(job, item, error instanceof AppError ? error.message : '页面位置发生变化，请重新校准后继续'); return; }
        const record = { label: step.label, type: step.type, state: 'sending', time: new Date().toISOString() };
        // Persist BEFORE dispatch: a crash cannot silently replay a save/publish.
        await transact(() => { item.steps.push(record); });
        try {
          await identity(job, item);
          if (step.type === 'upload') {
            const file = { name: `${item.productId}.png`, mimeType: 'image/png', buffer: Buffer.from(item.image.split(',')[1], 'base64') };
            if (await node.evaluate(el => el.tagName === 'INPUT' && el.type === 'file')) await node.setInputFiles(file, { timeout });
            else { const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout }), node.click({ timeout })]); await chooser.setFiles(file, { timeout }); }
          } else if (step.type === 'fill') await node.fill(step.value, { timeout });
          else await node.click({ timeout });
          if (step.success) await waitSuccess(step.success);
          await transact(() => { record.state = 'completed'; item.stepIndex++; });
        } catch {
          await transact(() => { record.state = 'unknown'; item.status = 'unknown'; job.status = 'unknown'; job.message = '网页操作或成功提示未能确认；请在妙手核对，不自动重复点击'; }); return;
        }
      }
      if (job.cancelRequested || closing) break;
      await transact(() => { item.status = 'completed'; });
    }
    await transact(() => { job.status = job.cancelRequested || closing ? 'stopped' : 'completed'; job.message = job.status === 'stopped' ? '已停止后续步骤；已完成的网页操作不会撤销' : '网页流程已完成，请在妙手查看最终发布结果'; for (const item of job.items) if (['waiting', 'running', 'paused'].includes(item.status)) item.status = 'stopped'; });
  }
  function start(job) {
    runner = execute(job).catch(async () => { await transact(() => { job.status = 'unknown'; job.message = '任务中断，请在妙手核对后续结果'; }); }).finally(() => { runner = null; });
  }
  async function cancelPicker() {
    pickKey = null;
    if (page && !page.isClosed()) await Promise.allSettled(page.frames().map(frame => frame.evaluate(() => window.__listingPickerCancel?.())));
  }
  return {
    setDemoOrigin(value) { demoOrigin = value; },
    async status() {
      await tail; const data = await read(); let currentUrl = '';
      try { currentUrl = page && !page.isClosed() ? browserUrl(page.url(), demoOrigin) : ''; } catch { /* Do not expose credential-bearing login URLs. */ }
      return { open: Boolean(context && page && !page.isClosed()), opening, currentUrl, recipe: data.recipe, jobs: data.jobs.map(publicJob).reverse(), picked, picking: Boolean(pickKey), headless: env.BROWSER_HEADLESS === 'true' };
    },
    async open(input) {
      await read(); idle(); if (opening) throw new AppError('浏览器正在启动', 409);
      const url = browserUrl(input.url, demoOrigin); await cancelPicker();
      opening = true;
      try {
        if (!context) {
          const options = { headless: env.BROWSER_HEADLESS === 'true', viewport: null, acceptDownloads: false, timeout: 30_000 };
          if (env.BROWSER_EXECUTABLE_PATH) options.executablePath = env.BROWSER_EXECUTABLE_PATH;
          else options.channel = env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
          context = await launch(options);
          await context.exposeBinding('listingPick', async ({ frame }, value) => {
            if (!pickKey || value.key !== pickKey) return;
            let frameSelector = '';
            if (frame !== page.mainFrame()) {
              if (frame.parentFrame() !== page.mainFrame()) { picked = { key: pickKey, error: '嵌套框架请手工填写定位表达式' }; await cancelPicker(); return; }
              const handle = await frame.frameElement();
              frameSelector = await handle.evaluate(el => el.id ? `iframe[id="${CSS.escape(el.id)}"]` : `iframe:nth-of-type(${[...el.parentElement.children].filter(node => node.tagName === 'IFRAME').indexOf(el) + 1})`);
              if (await page.locator(frameSelector).count() !== 1) { picked = { key: pickKey, error: '框架位置不唯一，请手工填写框架定位' }; await cancelPicker(); return; }
            }
            picked = { key: pickKey, selector: value.selector || '', frame: frameSelector, cancelled: Boolean(value.cancelled), file: Boolean(value.file) };
            await cancelPicker();
          });
          context.on('close', () => { context = null; page = null; });
          context.on('page', newPage => { if (!state?.jobs.some(job => ACTIVE.includes(job.status))) page = newPage; });
        }
        page = context.pages().find(tab => !tab.isClosed()) || await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); await page.bringToFront();
      } catch { throw new AppError('浏览器打开失败。Windows 请确认已安装 Edge；也可在安装助手中下载 Chromium', 502); }
      finally { opening = false; }
      return this.status();
    },
    async pick(input) {
      await read(); if (state.jobs.some(job => job.status === 'running')) throw new AppError('任务执行中不能选取位置', 409);
      browser(); browserUrl(page.url(), demoOrigin); await cancelPicker();
      pickKey = text(input.key, 80); if (!pickKey) throw new AppError('选取项无效'); picked = null;
      const key = pickKey;
      await Promise.allSettled(page.frames().map(frame => frame.evaluate(pickerScript, { key })));
      await page.bringToFront(); return { picking: true };
    },
    async saveRecipe(input) {
      await read(); idle(); const recipe = normalizeRecipe(input); await transact(data => { data.recipe = recipe; }); return recipe;
    },
    async repair(input) {
      await read(); const job = state.jobs.find(job => job.id === input.jobId);
      if (!job || job.status !== 'paused') throw new AppError('只有暂停中的任务可以校准位置', 409);
      const recipe = normalizeRecipe(input.recipe);
      if (recipe.steps.length !== job.recipe.steps.length || recipe.steps.some((step, i) => step.type !== job.recipe.steps[i].type) || recipe.shopText !== job.recipe.shopText) throw new AppError('续跑时只能调整位置和提示，不能改变步骤类型或目标店铺');
      await transact(data => { job.recipe = recipe; data.recipe = recipe; }); return publicJob(job);
    },
    async capture(input) {
      await read(); idle(); browser(); const recipe = normalizeRecipe(input.recipe || state.recipe);
      const sourceUrl = browserUrl(page.url(), demoOrigin), expectedText = text(input.expectedText, 160);
      if (!expectedText || !matches(await content(recipe.guard), expectedText)) throw new AppError('请填写当前商品在网页显示的识别文字并核对选取位置');
      if (!matches(await content(recipe.shop), recipe.shopText)) throw new AppError('当前店铺与配置不一致');
      if (!recipe.extract.title.selector || !recipe.extract.sku.selector || !recipe.extract.image.selector) throw new AppError('读取商品需要先选取标题、SKU 和原图位置');
      const title = await content(recipe.extract.title), sku = await content(recipe.extract.sku), category = recipe.extract.category.selector ? await content(recipe.extract.category) : text(input.category, 100);
      const node = await locator(recipe.extract.image);
      const src = await node.evaluate(el => el.currentSrc || el.src || ''); let sourceImage;
      if (src.startsWith('data:')) sourceImage = image(src);
      else {
        let url;
        try { url = new URL(src); } catch { throw new AppError('未找到原图，请选取 img 图片位置'); }
        if ((url.protocol !== 'https:' || privateHost(url.hostname)) && !(url.origin === demoOrigin && url.pathname.startsWith('/browser-demo/'))) throw new AppError('原图地址不受支持，请下载原图后在商品编辑器上传');
        try {
          const response = await context.request.get(url.href, { timeout, maxRedirects: 0 });
          if (!response.ok() || Number(response.headers()['content-length']) > 6_000_000) throw new Error('bad image');
          const bytes = await response.body(); if (bytes.length > 6_000_000) throw new Error('large');
          sourceImage = image(`data:image/${bytes[0] === 137 ? 'png' : bytes[0] === 255 ? 'jpeg' : 'webp'};base64,${bytes.toString('base64')}`);
        } catch { throw new AppError('网页原图下载失败，请在商品编辑器上传本地原图', 502); }
      }
      const [product] = await store.import([{ title, sku, category, sourceImage, ...(sourceUrl.startsWith('https:') ? { sourceUrl } : { isDemo: true }) }]);
      return { product, editorUrl: sourceUrl, expectedText };
    },
    async enqueue(input) {
      await read();
      if (input.imagesReviewed !== true) throw new AppError('请先检查并确认本批图片');
      const recipe = normalizeRecipe(input.recipe || state.recipe);
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) throw new AppError('每批需要 1–20 件商品');
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId || '')) throw new AppError('任务需要 UUID requestId');
      const requestHash = hash([recipe, input.items, input.pauseBeforePublish !== false]);
      const old = state.jobs.find(job => job.requestId === input.requestId);
      if (old) { if (old.requestHash !== requestHash) throw new AppError('同一请求 ID 不能用于不同任务', 409); return publicJob(old); }
      idle(); browser(); await cancelPicker();
      if (state.jobs.length >= 100) throw new AppError('任务记录达到 100 条，请先备份核对', 409);
      const productState = await store.list(), products = productState.products, ids = new Set(), fingerprints = new Set(), items = [];
      for (const row of input.items) {
        const product = products.find(item => item.id === row.productId);
        if (!product || product.revision !== row.revision) throw new AppError('商品版本已变化，请刷新任务图片', 409);
        if (ids.has(product.id)) throw new AppError('同批商品不能重复'); ids.add(product.id);
        if (productState.workflowJobs.some(job => ['queued', 'running'].includes(job.status) && job.items.some(item => item.productId === product.id))) throw new AppError('此商品正在 API 任务中，请等待完成', 409);
        if (!product.processedImage) throw new AppError(`${product.title} 尚无处理图`);
        image(product.processedImage);
        const url = browserUrl(row.url, demoOrigin), expectedText = text(row.expectedText, 160);
        if (!expectedText) throw new AppError('每件商品都须填写网页识别文字');
        if (product.isDemo && new URL(url).origin !== demoOrigin) throw new AppError('演示商品只能操作演示网页');
        const fingerprint = hash([new URL(url).origin, expectedText, recipe.shopText, product.processedImage]);
        if (fingerprints.has(fingerprint)) throw new AppError('同批商品识别文字与图片重复，请核对是否加入了同一商品'); fingerprints.add(fingerprint);
        if (state.jobs.some(job => job.items.some(item => item.fingerprint === fingerprint && (['completed', 'unknown'].includes(item.status) || item.steps.some(step => step.state === 'sending' || step.state === 'unknown' || ['save', 'publish'].includes(step.type)))))) throw new AppError('相同商品与图片已有保存或未知记录，请先在妙手核对，避免重复提交', 409);
        items.push({ productId: product.id, title: product.title, revision: product.revision, image: product.processedImage, url, expectedText, fingerprint, status: 'waiting', stepIndex: 0, steps: [], opened: false, publishApproved: false });
      }
      if (new Set(items.map(item => new URL(item.url).origin)).size !== 1) throw new AppError('同批商品须来自同一个妙手网站');
      const job = { id: randomUUID(), requestId: input.requestId, requestHash, recipe, items, itemIndex: 0, pauseBeforePublish: input.pauseBeforePublish !== false, status: 'running', message: '正在按网页流程处理', createdAt: new Date().toISOString(), cancelRequested: false };
      await transact(data => { idle(); data.jobs.push(job); data.recipe = recipe; }); start(job); return publicJob(job);
    },
    async control(id, action) {
      await read(); const job = state.jobs.find(job => job.id === id);
      if (!job) throw new AppError('任务不存在', 404);
      if (action === 'stop') {
        await transact(() => { job.cancelRequested = true; if (job.status === 'paused') { job.status = 'stopped'; job.message = '已停止，已完成操作不会撤销'; for (const item of job.items) if (['waiting', 'paused'].includes(item.status)) item.status = 'stopped'; } });
      } else if (action === 'pause') {
        if (job.status !== 'running') throw new AppError('只有执行中的任务可以暂停', 409);
        await transact(() => { job.pauseRequested = true; job.message = '已请求暂停，当前操作完成后可接管'; });
      } else if (action === 'resume') {
        if (job.status === 'paused' && runner) await runner;
        if (job.status !== 'paused' || runner) throw new AppError('只能继续已暂停的任务；结果未知时须在妙手核对', 409);
        browser(); await cancelPicker(); await transact(() => { job.status = 'running'; job.message = '继续网页操作'; }); start(job);
      } else throw new AppError('不支持此任务操作');
      return publicJob(job);
    },
    async close() { closing = true; await cancelPicker(); if (context) await context.close(); await runner; await tail; },
  };
}
