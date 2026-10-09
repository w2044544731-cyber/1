import { editRules } from './rules.js';
import { parseImport, parseCsv } from './importer.js';
import { readImage, processImage, composeScene, chooseScene, demoImage } from './images.js';
import { initializeWorkflowUI } from './workflow-ui.js';
const $ = selector => document.querySelector(selector);
const statusLabels = { draft: '待处理', ready: '审核通过', exported: '已导出' };
const state = { products: [], events: [], workflowJobs: [], current: null, editorRevision: null, selected: new Set(), image: '', processed: '', background: '', custom: '', busy: false, dirty: false, publishJobs: [], publishPreview: null, publishRequestId: null, scenePlan: null };
let toastTimer;
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').classList.toggle('error-toast', error); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 5000);
}
async function api(path, data, method = 'POST') {
  const response = await fetch(path, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
async function run(action) {
  if (state.busy) return;
  state.busy = true;
  const regions = [...document.querySelectorAll('main, .sidebar, dialog')];
  regions.forEach(region => { region.inert = true; });
  const buttons = [...document.querySelectorAll('button')].filter(button => !button.disabled);
  buttons.forEach(button => { button.disabled = true; });
  try { await action(); } catch (error) { toast(error.message, true); }
  finally { state.busy = false; regions.forEach(region => { region.inert = false; }); buttons.forEach(button => { button.disabled = false; }); syncPublishButton(); workflowUI.syncSubmit(); }
}
async function reload() {
  const data = await api('/api/state'); state.products = data.products; state.events = data.events; state.publishJobs = data.publishJobs || [];
  state.workflowJobs = data.workflowJobs || [];
  for (const id of state.selected) if (!state.products.some(product => product.id === id)) state.selected.delete(id);
  renderList(); renderEvents(); renderPublishJobs(); workflowUI.renderJobs();
  const current = state.products.find(product => product.id === state.current);
  if (current && !state.dirty && current.revision !== state.editorRevision) selectProduct(current.id, true);
}
function visibleProducts() {
  const query = $('#search').value.trim().toLowerCase(), filter = $('#filter').value;
  return state.products.filter(product => (filter === 'all' || product.status === filter) && `${product.title} ${product.sku}`.toLowerCase().includes(query));
}
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function renderList() {
  $('#stat-total').textContent = state.products.length;
  for (const status of ['draft', 'ready', 'exported']) $(`#stat-${status}`).textContent = state.products.filter(product => product.status === status).length;
  $('#library-count').textContent = `${state.products.length} 件`;
  const products = visibleProducts(), list = $('#product-list'); list.replaceChildren();
  $('#empty').hidden = products.length > 0;
  if (!products.length && state.products.length) $('#empty p').textContent = '没有匹配的商品，请调整筛选或搜索。';
  for (const product of products) {
    const row = element('div', `product-row${state.current === product.id ? ' current' : ''}`);
    row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-label', `编辑 ${product.title || '未命名商品'}`);
    const select = element('input'); select.type = 'checkbox'; select.checked = state.selected.has(product.id); select.setAttribute('aria-label', `选择 ${product.title || '未命名商品'}`);
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', () => { select.checked ? state.selected.add(product.id) : state.selected.delete(product.id); renderSelection(); });
    const thumb = element('img', 'thumb'); thumb.alt = ''; thumb.referrerPolicy = 'no-referrer';
    if (product.processedImage || product.sourceImage) thumb.src = product.processedImage || product.sourceImage;
    else thumb.hidden = true;
    const info = element('div', 'product-info'); info.append(element('div', 'product-title', `${product.isDemo ? '[演示] ' : ''}${product.title || '未命名商品'}`));
    const meta = element('div', 'product-meta'); meta.append(element('span', '', product.sku || '未填写 SKU'), element('span', `badge ${product.status}`, statusLabels[product.status])); info.append(meta);
    row.append(select, thumb, info);
    row.addEventListener('click', () => selectProduct(product.id));
    row.addEventListener('keydown', event => { if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectProduct(product.id); } });
    list.append(row);
  }
  renderSelection();
}
function renderSelection() {
  const visible = visibleProducts();
  $('#selected-count').textContent = `已选 ${state.selected.size} 件`;
  $('#select-all').checked = visible.length > 0 && visible.every(product => state.selected.has(product.id));
  $('#select-all').indeterminate = visible.some(product => state.selected.has(product.id)) && !$('#select-all').checked;
}
function renderEvents() {
  const list = $('#activity-list'); list.replaceChildren();
  if (!state.events.length) { list.append(element('p', 'empty', '还没有处理记录')); return; }
  for (const event of state.events) {
    const row = element('div', 'activity-row'); row.append(element('span', '', event.message), element('time', '', new Date(event.time).toLocaleString('zh-CN'))); list.append(row);
  }
}
function mayDiscard() { return !state.dirty || window.confirm('有未保存的修改，确定放弃这些修改吗？'); }
function selectProduct(id, force = false) {
  if (!force && state.current === id) return;
  if (!force && !mayDiscard()) return;
  const product = state.products.find(item => item.id === id);
  if (!product) { state.current = null; state.dirty = false; $('#editor').hidden = true; $('#editor-empty').hidden = false; renderList(); return; }
  state.current = id; state.image = product.sourceImage; state.processed = product.processedImage; state.background = product.background; state.custom = ''; state.scenePlan = product.scenePlan || null; state.dirty = false;
  state.editorRevision = product.revision;
  $('#editor').hidden = false; $('#editor-empty').hidden = true;
  const form = $('#edit-form');
  for (const name of ['title', 'sku', 'category', 'price', 'currency', 'stock', 'sourceUrl', 'description']) form.elements[name].value = product[name] ?? '';
  for (const name of ['sku', 'price', 'stock']) form.elements[name].required = !product.erpSource;
  $('#editor-status').textContent = statusLabels[product.status]; $('#editor-status').className = `badge ${product.status}`;
  $('#scene').value = 'auto'; $('#tolerance').value = 45; $('#tolerance-value').value = 45; $('#custom-background-label').hidden = true;
  $('#source-file').value = ''; $('#background-file').value = ''; $('#background-name').textContent = ''; $('#image-result').textContent = '';
  $('#ai-edit-prompt').value = '';
  renderErpSource(product); renderScenePlan(); renderImages(); renderList();
}
function renderImages() {
  for (const [selector, empty, source] of [['#source-preview', '#source-empty', state.image], ['#processed-preview', '#processed-empty', state.processed]]) {
    $(selector).hidden = !source; $(empty).hidden = Boolean(source);
    if (source) $(selector).src = source; else $(selector).removeAttribute('src');
  }
}
function values() {
  const form = $('#edit-form'); const product = state.products.find(product => product.id === state.current);
  const data = Object.fromEntries(['title', 'sku', 'category', 'price', 'currency', 'stock', 'sourceUrl', 'description'].map(key => [key, form.elements[key].value]));
  return { ...data, sourceImage: state.image, processedImage: state.processed, background: state.background, scenePlan: state.scenePlan, revision: state.editorRevision };
}
async function saveCurrent(review = false) {
  if (!state.current) throw new Error('请先选择商品');
  if (review && !$('#edit-form').reportValidity()) return;
  const updated = await api(`/api/products/${state.current}`, values(), 'PATCH');
  // The draft was saved even if a later review validation fails.
  state.dirty = false;
  await reload();
  if (review) {
    try { await api(`/api/products/${state.current}/review`, { revision: updated.revision }); }
    catch (error) { selectProduct(state.current, true); throw error; }
    await reload();
  }
  selectProduct(state.current, true); toast(review ? '审核通过，可以导出；尚未上传到 Temu' : '草稿已保存');
}
function download(content, name, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = element('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('#search').addEventListener('input', renderList); $('#filter').addEventListener('change', renderList);
$('#select-all').addEventListener('change', () => { for (const product of visibleProducts()) $('#select-all').checked ? state.selected.add(product.id) : state.selected.delete(product.id); renderList(); });
$('#edit-form').addEventListener('input', event => { state.dirty = true; if (['title','category','description'].includes(event.target.name)) { state.scenePlan = null; renderScenePlan(); } });
$('#edit-form').addEventListener('submit', event => { event.preventDefault(); run(() => saveCurrent()); });
$('#review').addEventListener('click', () => run(() => saveCurrent(true)));
$('#delete-product').addEventListener('click', () => run(async () => {
  if (!confirm('删除此商品及本地保存的图片？此操作不可撤销。')) return;
  const product = state.products.find(product => product.id === state.current);
  await api(`/api/products/${product.id}`, { revision: product.revision }, 'DELETE'); state.dirty = false; await reload(); selectProduct(null, true); toast('商品已删除');
}));
$('#source-file').addEventListener('change', () => run(async () => {
  const file = $('#source-file').files[0]; if (!file) return;
  state.image = await readImage(file); state.processed = ''; state.background = ''; state.dirty = true; renderImages();
}));
$('#scene').addEventListener('change', () => { $('#custom-background-label').hidden = $('#scene').value !== 'custom'; });
$('#tolerance').addEventListener('input', () => { $('#tolerance-value').value = $('#tolerance').value; });
$('#background-file').addEventListener('change', () => run(async () => {
  const file = $('#background-file').files[0]; if (!file) return;
  state.custom = await readImage(file); $('#background-name').textContent = file.name;
}));
$('#process').addEventListener('click', () => run(async () => {
  if (!state.image) throw new Error('请先上传或导入商品原图');
  if (!state.image.startsWith('data:')) { try { state.image = (await api(`/api/products/${state.current}/source-image`)).image; } catch { /* Continue with browser image loading when supported. */ } }
  const data = values(); let scene = $('#scene').value;
  if (scene === 'auto') scene = chooseScene(data);
  const result = scene === 'white' ? await processImage(state.image, '#ffffff', Number($('#tolerance').value)) : await composeScene(state.image, scene, Number($('#tolerance').value), state.custom);
  state.processed = result.url; state.background = scene; state.dirty = true; renderImages();
  const labels = { kitchen: '厨房', living: '家居', desk: '办公', outdoor: '户外', custom: '自定义场景', white: '白底' };
  $('#image-result').textContent = `${labels[scene]} · ${result.width} × ${result.height} PNG · 已处理 ${result.replaced} 个背景像素。请检查效果后保存。`;
  toast('场景图已生成；请预览并保存');
}));
$('#download-image').addEventListener('click', () => {
  if (!state.processed) { toast('请先生成场景图', true); return; }
  const link = element('a'); link.href = state.processed; link.download = `${state.current}.png`; link.click();
});
$('#export').addEventListener('click', () => run(async () => {
  if (state.dirty) throw new Error('请先保存当前修改，避免导出旧数据');
  const format = $('#export-format').value;
  const result = await api('/api/export', { ids: [...state.selected], format });
  download(result.content, `products-${new Date().toISOString().slice(0,10)}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
  await reload(); if (state.current) selectProduct(state.current, true);
  toast(`已导出 ${result.count} 件商品，尚未上传 Temu${format === 'csv' ? '；CSV 不含图片，请另行下载 PNG' : ''}`);
}));
function openImport() { $('#import-error').textContent = ''; $('#import-dialog').showModal(); }
$('#open-import').addEventListener('click', openImport); $('#close-import').addEventListener('click', () => $('#import-dialog').close());
let importFilename = '';
$('#import-file').addEventListener('change', () => run(async () => {
  const file = $('#import-file').files[0]; if (!file) return;
  if (file.size > 10_000_000) throw new Error('导入文件须小于 10 MB');
  importFilename = file.name; $('#import-text').value = await file.text();
}));
$('#import-text').addEventListener('input', () => { importFilename = ''; });
$('#import-submit').addEventListener('click', () => run(async () => {
  try {
    const text = $('#import-text').value.trim();
    const looksCsv = /\.csv$/i.test(importFilename) || (!/^[{[<]/.test(text) && text.split('\n')[0].includes(','));
    const products = looksCsv ? parseCsv(text) : parseImport(text, $('#import-url').value.trim());
    if (!mayDiscard()) return;
    const created = await api('/api/import', { products });
    $('#import-dialog').close(); $('#import-text').value = ''; await reload(); selectProduct(created[0].id, true); showView('products'); toast(`导入 ${created.length} 件商品；请核对字段并处理图片`);
  } catch (error) { $('#import-error').textContent = error.message; }
}));
$('#new-product').addEventListener('click', () => run(async () => {
  if (!mayDiscard()) return;
  const created = await api('/api/import', { products: [{}] }); $('#import-dialog').close(); await reload(); selectProduct(created[0].id, true); showView('products');
}));
$('#demo').addEventListener('click', () => run(async () => {
  if (!mayDiscard()) return;
  const created = await api('/api/import', { products: [{ title: '演示保温杯（非真实商品）', sku: `DEMO-${Date.now()}`, category: '厨房用品', price: 12.99, stock: 100, currency: 'USD', description: '仅用于体验工作流，请勿作为真实商品上架。', sourceImage: demoImage(), isDemo: true }] });
  await reload(); selectProduct(created[0].id, true); showView('products'); toast('已创建演示商品，可生成厨房场景图');
}));
function showView(view) {
  for (const name of ['products', 'workflows', 'activity', 'integrations']) $(`#${name}-view`).hidden = name !== view;
  for (const nav of document.querySelectorAll('[data-view]')) nav.classList.toggle('active', nav.dataset.view === view);
  $('#page-title').textContent = { products: '商品工作台', workflows: '自动上架任务', activity: '处理记录', integrations: '平台连接' }[view];
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
$('#refresh').addEventListener('click', () => run(reload));
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
const workflowUI = initializeWorkflowUI({ state, api, run, element, reload, selectProduct, showView, toast, saveCurrent });
run(async () => { await reload(); await loadIntegrations(); });

$('#open-batch').addEventListener('click', () => {
  if (!state.selected.size) { toast('请先勾选要处理的商品', true); return; }
  if (state.dirty) { toast('请先保存当前编辑', true); return; }
  $('#batch-results').replaceChildren(); $('#batch-progress').textContent = `已选 ${state.selected.size} 件`; $('#batch-dialog').showModal();
});
$('#close-batch').addEventListener('click', () => $('#batch-dialog').close());
$('#batch-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
$('#batch-submit').addEventListener('click', () => run(async () => {
  const products = state.products.filter(product => state.selected.has(product.id));
  const rules = { prefix: $('#batch-prefix').value, suffix: $('#batch-suffix').value, markup: $('#batch-markup').value, stock: $('#batch-stock').value };
  editRules({ title: '', price: 1, stock: 0 }, rules);
  $('#batch-results').replaceChildren(); let successes = 0;
  for (const [index, product] of products.entries()) {
    $('#batch-progress').textContent = `处理中 ${index + 1} / ${products.length}`;
    try {
      const patch = { ...editRules(product, rules), revision: product.revision };
      if ($('#batch-images').checked) {
        if (!product.sourceImage) throw new Error('缺少商品原图');
        const scene = chooseScene({ ...product, ...patch });
        const result = await composeScene(product.sourceImage, scene, 45);
        patch.processedImage = result.url; patch.background = scene;
      }
      await api(`/api/products/${product.id}`, patch, 'PATCH'); successes++;
      $('#batch-results').append(element('p', 'hint', `${product.title || product.id}：已保存草稿`));
    } catch (error) { $('#batch-results').append(element('p', 'error', `${product.title || product.id}：${error.message}`)); }
  }
  await reload(); if (state.current) selectProduct(state.current, true);
  $('#batch-progress').textContent = `完成：${successes} 件成功，${products.length - successes} 件失败`; toast('批量处理结束，请查看明细并审核图片');
}));

function syncPublishButton() { $('#confirm-publish').disabled = !state.publishPreview?.configured || !$('#publish-ack').checked; }
function renderPublishJobs() {
  const list = $('#publish-jobs'); list.replaceChildren();
  const labels = { submitting: '已记录 / 结果待确认', accepted: '请求已接受 / 未确认上架', rejected: '请求被拒绝', unknown: '结果未知 / 请核对' };
  if (!state.publishJobs.length) { list.append(element('p', 'hint', '尚无发布请求')); return; }
  for (const job of state.publishJobs) {
    const row = element('article', 'publish-job');
    row.append(element('strong', '', labels[job.status] || '未知状态'), element('p', 'hint', `店铺 ID：${job.payload.shopIds.join(', ')} · 详情 ID：${job.payload.detailIds.join(', ')}`), element('p', 'hint', job.message), element('p', 'hint', `记录 ${job.id} · ${new Date(job.createdAt).toLocaleString('zh-CN')}`)); list.append(row);
  }
}
async function loadIntegrations() {
  const integrations = await api('/api/integrations');
  workflowUI.updateConfig(integrations);
  $('#scene-ai-config').textContent = integrations.sceneText.configured ? '文字服务已配置（尚未验证连接）；点击后请求生成方案。' : `文字服务待配置：${integrations.sceneText.missing.join('、')}。当前可继续用场景模板。`;
  $('#read-config').textContent = integrations.collection.configured ? '详情读取参数已配置，点击后将读取远端商品。' : `缺少配置：${integrations.collection.missing.join('、')}。可先离线导入已取得的 JSON 响应。`;
  $('#integration-status').textContent = integrations.erp.configured ? '发布参数已配置（未验证连接）' : '发布接口待配置';
  $('#publish-config').textContent = integrations.erp.configured ? '可预览并确认发布 ERP 现有商品，本地修改同步仍未接入。' : `缺少配置：${integrations.erp.missing.join('、')}。仅可预览，不发送发布请求。`;
}
function parseIds(value) {
  const parts = value.trim().split(/[,，\s]+/);
  if (!value.trim() || parts.some(part => !/^\d+$/.test(part))) throw new Error('请输入用逗号分隔的整数 ID');
  return parts.map(Number);
}
$('#preview-publish').addEventListener('click', () => run(async () => {
  const data = { shopIds: parseIds($('#publish-shops').value), detailIds: parseIds($('#publish-details').value) };
  state.publishPreview = await api('/api/publish/preview', data); state.publishRequestId = crypto.randomUUID();
  $('#publish-payload').textContent = JSON.stringify({ method: state.publishPreview.method, path: state.publishPreview.path, body: state.publishPreview.payload }, null, 2);
  $('#publish-readiness').textContent = state.publishPreview.configured ? '接口参数已配置，确认后将发送真实发布请求。' : `不会发送：缺少 ${state.publishPreview.missing.join('、')}。`;
  $('#publish-ack').checked = false; $('#publish-dialog').showModal(); syncPublishButton();
}));
$('#publish-ack').addEventListener('change', syncPublishButton);
$('#close-publish').addEventListener('click', () => { $('#publish-dialog').close(); state.publishPreview = null; syncPublishButton(); });
$('#publish-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); else state.publishPreview = null; });
$('#confirm-publish').addEventListener('click', () => run(async () => {
  if (!state.publishPreview?.configured || !$('#publish-ack').checked) throw new Error('请先预览、配置接口并确认发布内容');
  try {
    const result = await api('/api/publish', { ...state.publishPreview.payload, requestId: state.publishRequestId, confirmed: true, acknowledgeRemoteOnly: true });
    state.publishPreview = null; $('#publish-dialog').close(); await reload(); toast(result.job.message, result.job.status !== 'accepted');
  } catch (error) {
    await reload(); throw new Error(`${error.message}；若已产生请求记录，请先在妙手核对，不要新建请求重复提交`);
  }
}));

function renderErpSource(product) {
  const container = $('#erp-source-meta'); container.replaceChildren(); container.hidden = !product.erpSource;
  if (!product.erpSource) return;
  const source = product.erpSource;
  container.append(element('strong', '', `${source.box === 'common' ? '妙手公共采集箱' : `妙手店铺 ${source.shopId}`} · 详情 ${source.detailId} · ${source.skuCount} 个 SKU`));
  container.append(element('p', 'hint', `${source.origin === 'live_read' ? '接口读取' : '离线响应（未验证）'} · ${source.remoteSync?.syncStatus === 'publish_accepted' ? '主图已同步 / 发布结果待确认' : '主图尚未完成发布流程'} · 自动流程保留价格和库存`));
  for (const warning of source.warnings || []) container.append(element('p', 'hint', warning));
  const details = element('details'); details.append(element('summary', '', '查看完整原始 SKU / 属性快照'));
  const raw = element('pre'); raw.textContent = JSON.stringify(source.snapshot, null, 2); details.append(raw); container.append(details);
}
function readRequest() {
  const values = [$('#read-shop').value.trim(), $('#read-detail').value.trim()];
  if (values.some(value => !/^\d+$/.test(value))) throw new Error('请填写整数店铺 ID 与采集箱详情 ID');
  return { shopId: Number(values[0]), detailId: Number(values[1]) };
}
async function importErp(responseMode) {
  if (!mayDiscard()) return;
  const request = readRequest(); let product;
  if (responseMode) {
    let response;
    try { response = JSON.parse($('#erp-response').value); } catch { throw new Error('详情响应 JSON 格式无效'); }
    product = await api('/api/erp/details/import', { request, response });
  } else product = await api('/api/erp/details/read', request);
  await reload(); selectProduct(product.id, true);
  showView('products');
  toast('采集箱详情已导入，完整 SKU / 属性已保留；图片修改尚未同步到妙手');
}
$('#read-erp').addEventListener('click', () => run(() => importErp(false)));
$('#import-erp-response').addEventListener('click', () => run(() => importErp(true)));

function renderScenePlan() {
  $('#scene-reason').textContent = state.scenePlan ? `${state.scenePlan.reason}（文字方案；尚未生成图片）` : '';
  $('#scene-prompt').value = state.scenePlan?.prompt || '';
  $('#scene-prompt').disabled = !state.scenePlan;
}
$('#plan-scene').addEventListener('click', () => run(async () => {
  if (!state.current) throw new Error('请先选择商品');
  const input = values();
  state.scenePlan = await api('/api/scene/plan', { title: input.title, category: input.category, description: input.description });
  state.dirty = true; renderScenePlan(); toast('文字场景方案已生成，图片尚未生成；保存草稿可保留方案');
}));
$('#scene-prompt').addEventListener('input', () => {
  if (state.scenePlan) { state.scenePlan.prompt = $('#scene-prompt').value; state.dirty = true; }
});
$('#apply-plan').addEventListener('click', () => {
  if (!state.scenePlan) { toast('请先生成文字场景方案', true); return; }
  $('#scene').value = state.scenePlan.scene; $('#custom-background-label').hidden = true;
  toast('已选择建议的模板，可点击生成场景图进行模板合成');
});
