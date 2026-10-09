import { composeScene, chooseScene } from './images.js';

const $ = selector => document.querySelector(selector);
const labels = { queued: '等待处理', running: '处理中', accepted: '发布任务已接受', partial: '部分完成', blocked: '已停止 / 待补充', failed: '未完成', unknown: '结果未知，请核对' };
const phases = { waiting: '等待', hosting: '准备公网图片', read_common: '读取公共采集箱', save_common: '保存公共主图', verify_common: '核对公共主图', claim: '认领到 Temu', read_shop: '读取店铺商品', validate: '检查商品资料', recheck_shop: '复核店铺版本', save_shop: '保存店铺主图', verify_shop: '核对店铺主图', publish: '提交发布', done: '完成' };

export function initializeWorkflowUI({ state, api, run, element, reload, selectProduct, showView, toast, saveCurrent }) {
  let config, page = 1, pageData, plan = null, requestId = null, pollTimer;
  const collectSelected = new Set();
  const selected = () => state.products.filter(product => state.selected.has(product.id));
  function syncSubmit() { $('#workflow-submit').disabled = !plan?.ready || !$('#workflow-images-checked').checked; }
  function invalidate() { plan = null; $('#workflow-preview-status').textContent = ''; syncSubmit(); }
  function updateConfig(data) {
    config = data;
    $('#workflow-mode').textContent = data.demo ? '演示模式 · 妙手与 Temu 请求均模拟' : '真实店铺模式 · 最终上架状态待确认';
    $('#workflow-notice').textContent = data.demo ? '演示模式：可以体验采集箱读取、换图、保存和发布队列；不会向真实店铺提交。' : '按分类生成场景图，审核后批量写回妙手并提交发布。请先完成平台连接配置；发布任务接受后仍需确认最终上架结果。';
    $('#workflow-config').textContent = data.workflow.configured ? (data.demo ? '演示工作流可运行，目标店铺 ID 可使用 7。' : '参数已配置，执行时会读取并校验远端资料。配置完整不代表已验证真实连接。') : '待配置：' + data.workflow.missing.join('、');
    $('#common-config').textContent = data.commonCollection.configured ? '可读取公共采集箱，按商品 ID 导入完整资料。' : '公共采集箱签名连接待配置：' + data.commonCollection.missing.join('、');
    $('#image-ai-config').textContent = data.images.imageAi.configured ? '图像编辑已配置，点击后将向该服务发送商品原图和提示词。' : 'AI 图像编辑待配置，可继续使用本地场景模板。';
    $('.connection').textContent = data.demo ? '● 演示模式' : data.workflow.configured ? '● 工作流待联调' : '● 平台待配置';
  }
  function renderPreviewImages() {
    const list = $('#workflow-products'); list.replaceChildren();
    for (const product of selected()) {
      const row = element('article', 'workflow-product');
      const img = element('img'); img.alt = '待发布的场景主图'; img.referrerPolicy = 'no-referrer';
      if (product.processedImage || product.sourceImage) img.src = product.processedImage || product.sourceImage;
      const text = element('div');
      text.append(element('strong', '', product.title || '未命名商品'), element('p', 'hint', `${product.erpSource?.box === 'common' ? '公共采集箱' : 'Temu 店铺采集箱'} · ID ${product.erpSource?.detailId || '未绑定'} · ${product.processedImage ? '场景图已生成' : '尚未生成场景图'}`));
      row.append(img, text); list.append(row);
    }
  }
  function renderJobs() {
    const list = $('#workflow-jobs'); list.replaceChildren();
    const jobs = state.workflowJobs || [];
    if (!jobs.length) list.append(element('p', 'empty', '还没有自动任务。导入妙手商品，生成场景图后，选择批量自动上架。'));
    for (const job of jobs) {
      const card = element('article', 'workflow-job'), heading = element('div', 'workflow-job-heading');
      heading.append(element('strong', '', `${job.demo ? '[演示] ' : ''}${labels[job.status] || job.status}`), element('span', 'hint', `店铺 ${job.shopId} · ${new Date(job.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`));
      const progress = element('progress'); progress.max = job.items.length; progress.value = job.items.filter(item => !['queued', 'running'].includes(item.status)).length; progress.setAttribute('aria-label', '商品处理进度');
      card.append(heading, progress);
      for (const item of job.items) {
        const row = element('div', 'workflow-item');
        row.append(element('strong', '', item.title), element('span', `badge ${item.status === 'accepted' ? 'ready' : 'draft'}`, labels[item.status]), element('p', 'hint', `${phases[item.phase] || item.phase} · ${item.message}`));
        const details = element('details'); details.append(element('summary', '', `查看 ${item.steps.length} 个步骤${item.temuDetailId ? ` · Temu 详情 ID ${item.temuDetailId}` : ''}`));
        for (const step of item.steps) details.append(element('p', 'hint', `${step.state === 'completed' ? '✓' : step.state === 'failed' ? '!' : '…'} ${phases[step.phase] || step.phase}`));
        row.append(details); card.append(row);
      }
      if (['queued', 'running'].includes(job.status)) {
        const stop = element('button', 'secondary', job.cancelRequested ? '已请求停止剩余商品' : '停止剩余商品'); stop.disabled = job.cancelRequested;
        stop.addEventListener('click', () => run(async () => { await api(`/api/workflows/${job.id}/stop`, {}); await reload(); toast('当前商品会完成处理，后续商品不再执行'); })); card.append(stop);
      }
      list.append(card);
    }
    clearTimeout(pollTimer);
    if (jobs.some(job => ['queued', 'running'].includes(job.status))) pollTimer = setTimeout(() => reload().catch(error => { toast(error.message, true); renderJobs(); }), 1500);
  }
  async function loadCollection() {
    pageData = await api('/api/collect-box/list', { pageNo: page, pageSize: 20, keyword: $('#collect-keyword').value.trim() });
    const list = $('#collect-list'); list.replaceChildren();
    if (!pageData.records.length) list.append(element('p', 'hint', '当前页没有商品'));
    for (const record of pageData.records) {
      const label = element('label', 'collect-record'), check = element('input'); check.type = 'checkbox'; check.checked = collectSelected.has(record.detailId);
      check.addEventListener('change', () => { check.checked ? collectSelected.add(record.detailId) : collectSelected.delete(record.detailId); $('#collect-count').textContent = `已选 ${collectSelected.size} 件`; });
      const text = element('span'); text.append(element('strong', '', record.title || '未命名商品'), element('span', 'hint', `ID ${record.detailId} · ${record.sourceUrl || '链接未提供'}`)); label.append(check, text); list.append(label);
    }
    $('#collect-page').textContent = `第 ${page} 页 · 共 ${pageData.total} 件`;
    $('#collect-count').textContent = `已选 ${collectSelected.size} 件`;
  }
  $('#open-collect').addEventListener('click', () => run(async () => { $('#collect-dialog').showModal(); $('#collect-errors').textContent = ''; page = 1; await loadCollection(); }));
  $('#close-collect').addEventListener('click', () => $('#collect-dialog').close());
  $('#collect-search').addEventListener('click', () => run(async () => { page = 1; await loadCollection(); }));
  $('#collect-prev').addEventListener('click', () => run(async () => { if (page > 1) { page--; await loadCollection(); } }));
  $('#collect-next').addEventListener('click', () => run(async () => { if (pageData && page * 20 < pageData.total) { page++; await loadCollection(); } }));
  $('#collect-import').addEventListener('click', () => run(async () => {
    if (state.dirty) throw new Error('请先保存当前编辑');
    if (!collectSelected.size || collectSelected.size > 20) throw new Error('每批请选择 1–20 件商品');
    const created = [], errors = [];
    for (const detailId of [...collectSelected]) {
      try { created.push(await api('/api/collect-box/import', { detailId })); collectSelected.delete(detailId); }
      catch (error) { errors.push(`ID ${detailId}：${error.message}`); }
    }
    await reload();
    for (const product of created) state.selected.add(product.id);
    if (created.length) { selectProduct(created[0].id, true); showView('products'); }
    $('#collect-errors').textContent = errors.join('\n'); $('#collect-count').textContent = `已选 ${collectSelected.size} 件`;
    if (!errors.length) $('#collect-dialog').close();
    toast(`已导入 ${created.length} 件，${errors.length} 件未导入`, Boolean(errors.length));
  }));
  $('#open-workflow').addEventListener('click', () => {
    if (state.dirty) { toast('请先保存当前编辑', true); return; }
    if (!state.selected.size || state.selected.size > 20) { toast('请选择 1–20 件商品', true); return; }
    const shops = [...new Set(selected().map(product => product.erpSource?.shopId).filter(Boolean))];
    $('#workflow-shop').value = shops.length === 1 ? shops[0] : config?.demo ? 7 : '';
    $('#workflow-images-checked').checked = false; renderPreviewImages(); invalidate(); $('#workflow-dialog').showModal();
  });
  $('#close-workflow').addEventListener('click', () => $('#workflow-dialog').close());
  $('#workflow-shop').addEventListener('input', invalidate);
  $('#workflow-images-checked').addEventListener('change', () => { if (!$('#workflow-images-checked').checked) invalidate(); syncSubmit(); });
  $('#workflow-generate').addEventListener('click', () => run(async () => {
    invalidate(); $('#workflow-images-checked').checked = false;
    const errors = [];
    for (const product of selected().filter(product => !product.processedImage)) {
      try {
        let source = product.sourceImage;
        if (!source.startsWith('data:')) { try { source = (await api(`/api/products/${product.id}/source-image`)).image; } catch { /* Browser CORS or local upload remains available. */ } }
        const scene = chooseScene(product), result = await composeScene(source, scene, 45);
        await api(`/api/products/${product.id}`, { revision: product.revision, processedImage: result.url, background: scene }, 'PATCH');
      } catch (error) { errors.push(`${product.title}：${error.message}`); }
    }
    await reload(); renderPreviewImages();
    if (state.current && !state.dirty) selectProduct(state.current, true);
    $('#workflow-preview-status').textContent = errors.length ? errors.join('\n') : '场景图已准备，请逐件检查图片后勾选确认。';
  }));
  $('#workflow-preview').addEventListener('click', () => run(async () => {
    invalidate();
    if (!$('#workflow-images-checked').checked) throw new Error('请先检查所选场景图，并勾选图片确认');
    if (!/^\d+$/.test($('#workflow-shop').value.trim())) throw new Error('请输入正整数店铺 ID');
    for (const product of selected()) if (!['ready', 'exported'].includes(product.status)) await api(`/api/products/${product.id}/review`, { revision: product.revision });
    await reload();
    const input = { shopId: Number($('#workflow-shop').value), products: selected().map(product => ({ id: product.id, revision: product.revision })) };
    plan = await api('/api/workflows/preview', input); requestId = crypto.randomUUID();
    const problems = [...plan.missing, ...plan.blockers.map(item => `${item.title}：${item.message}`)];
    $('#workflow-preview-status').textContent = plan.ready ? `${plan.demo ? '演示' : '真实'}任务可提交：${plan.items.length} 件商品 → 店铺 ${plan.shopId}。${plan.note}` : '尚不能执行：\n' + problems.join('\n');
    syncSubmit();
  }));
  $('#workflow-submit').addEventListener('click', () => run(async () => {
    if (!plan?.ready || !$('#workflow-images-checked').checked) throw new Error('请先完成图片与任务预览');
    const input = { shopId: plan.shopId, products: plan.items.map(item => ({ id: item.productId, revision: item.revision })), previewHash: plan.previewHash, requestId, confirmed: true };
    try { await api('/api/workflows', input); $('#workflow-dialog').close(); await reload(); showView('workflows'); toast('自动任务已排队，可查看逐件进度'); }
    catch (error) { await reload(); throw error; }
  }));
  $('#refresh-workflows').addEventListener('click', () => run(reload));
  $('#edit-ai-image').addEventListener('click', () => run(async () => {
    if (!state.current) throw new Error('请先选择商品');
    const prompt = $('#ai-edit-prompt').value.trim() || $('#scene-prompt').value.trim();
    if (!prompt) throw new Error('请填写场景提示词，或先生成文字场景方案');
    if (state.dirty) await saveCurrent();
    const product = state.products.find(product => product.id === state.current);
    await api(`/api/products/${product.id}/ai-image`, { revision: product.revision, prompt });
    await reload(); selectProduct(product.id, true); toast('AI 场景图已保存为草稿，请检查商品外观再确认图片');
  }));
  return { renderJobs, updateConfig, syncSubmit };
}
