const $ = selector => document.querySelector(selector);
const labels = { running: '正在执行', paused: '已暂停，等你接管', completed: '网页流程完成', unknown: '结果未知，请在妙手核对', stopped: '已停止', waiting: '等待', sending: '已开始', file: '图片上传' };
const types = { click: '点击', upload: '上传处理后的图片', fill: '填写固定文字', wait: '等待位置 / 文字', pause: '暂停，人工接管', save: '保存商品', publish: '提交发布' };
const blank = () => ({ name: '妙手换图发布', guard: {}, shop: {}, shopText: '', extract: {}, steps: [{ type: 'upload', label: '上传场景主图' }, { type: 'save', label: '保存商品主图', success: {} }, { type: 'publish', label: '提交发布任务', success: {} }] });
const demoRecipe = () => ({ name: '本地演示 · 非妙手真实页面', guard: { selector: '#identity' }, shop: { selector: '#shop' }, shopText: '演示店铺 7', extract: Object.fromEntries(['title','sku','category'].map(field => [field, { selector: '#' + field }]).concat([['image', { selector: '#original' }]])), steps: [{ type: 'upload', label: '上传场景主图', selector: '#upload' }, { type: 'save', label: '保存商品主图', selector: '#save', success: { selector: '#save-result', expected: '图片已保存' } }, { type: 'publish', label: '提交发布任务', selector: '#publish', success: { selector: '#publish-result', expected: '发布任务已提交' } }] });

export function initializeBrowserUI({ state, api, run, element, reload, selectProduct, showView, toast }) {
  let recipe = blank(), status, timer, dirty = false, pickRequest, submittedRequestId = null;
  const fields = new Map(), items = new Map();
  function changed() { dirty = true; submittedRequestId = null; $('#browser-images-reviewed').checked = false; }
  function field(parent, key, label, value = {}) {
    const group = element('div', 'browser-position'), name = element('label', '', label), line = element('div', 'browser-toolbar');
    const selector = element('input'); selector.value = value.selector || ''; selector.placeholder = '点击选取，或填写定位表达式'; selector.setAttribute('aria-label', label + '定位');
    const frame = element('input'); frame.value = value.frame || ''; frame.placeholder = '框架定位（通常留空）'; frame.setAttribute('aria-label', label + '框架');
    const details = element('details'), summary = element('summary', '', '框架 / 高级定位'); details.append(summary, frame);
    const pick = element('button', 'secondary', '到网页选取'); pick.type = 'button';
    pick.addEventListener('click', () => run(async () => {
      const keyId = crypto.randomUUID(); pickRequest = { key: keyId, field: key };
      await api('/api/browser/pick', { key: keyId }); $('#browser-pick-message').textContent = `请到操作浏览器点击：${label}。Esc 可取消。`; poll();
    }));
    selector.addEventListener('input', changed); frame.addEventListener('input', changed);
    name.append(line); line.append(selector, pick); group.append(name, details); parent.append(group); fields.set(key, { selector, frame });
  }
  function values() {
    const result = structuredClone(recipe); result.name = $('#browser-recipe-name').value; result.shopText = $('#browser-shop-text').value;
    for (const [key, entry] of fields) {
      const parts = key.split('.'); let current = result;
      for (const part of parts.slice(0, -1)) current = current[part] ||= {};
      const last = parts.at(-1); current[last] = { ...current[last], selector: entry.selector.value, frame: entry.frame.value };
    }
    for (const [i, step] of result.steps.entries()) {
      step.type = $(`#browser-step-type-${i}`).value; step.label = $(`#browser-step-label-${i}`).value;
      if (step.type === 'fill') step.value = $(`#browser-step-value-${i}`)?.value ?? step.value ?? '';
      if (step.type === 'wait') step.expected = $(`#browser-step-value-${i}`)?.value ?? step.expected ?? '';
      if (['save', 'publish'].includes(step.type)) { step.success ||= {}; step.success.expected = $(`#browser-step-success-${i}`)?.value ?? step.success.expected ?? ''; }
    }
    return result;
  }
  function renderRecipe(value) {
    recipe = structuredClone(value); fields.clear();
    $('#browser-recipe-name').value = recipe.name; $('#browser-shop-text').value = recipe.shopText || '';
    const identity = $('#browser-identity-fields'); identity.replaceChildren(); field(identity, 'guard', '商品识别位置（网页的 SKU / 详情 ID）', recipe.guard); field(identity, 'shop', '目标店铺位置', recipe.shop);
    const extract = $('#browser-extract-fields'); extract.replaceChildren();
    for (const [key, label] of Object.entries({ title: '商品标题', sku: '商品 SKU', category: '分类（可选）', image: '商品原图' })) field(extract, 'extract.' + key, label, recipe.extract?.[key]);
    const steps = $('#browser-steps'); steps.replaceChildren();
    recipe.steps.forEach((step, i) => {
      const card = element('article', 'browser-step'), head = element('div', 'browser-toolbar'), select = element('select'); select.id = `browser-step-type-${i}`; select.setAttribute('aria-label', `步骤 ${i + 1} 类型`);
      for (const [value, label] of Object.entries(types)) { const option = element('option', '', label); option.value = value; select.append(option); } select.value = step.type;
      const label = element('input'); label.id = `browser-step-label-${i}`; label.value = step.label || types[step.type]; label.setAttribute('aria-label', `步骤 ${i + 1} 名称`);
      head.append(element('strong', '', String(i + 1).padStart(2, '0')), select, label); card.append(head);
      const actions = element('div', 'browser-toolbar');
      for (const [title, move] of [['↑', -1], ['↓', 1], ['删除', 0]]) {
        const button = element('button', 'text-button', title); button.setAttribute('aria-label', `${title}步骤 ${i + 1}`);
        button.addEventListener('click', () => { const updated = values(); if (move) { const next = i + move; if (next < 0 || next >= updated.steps.length) return; [updated.steps[i], updated.steps[next]] = [updated.steps[next], updated.steps[i]]; } else updated.steps.splice(i, 1); renderRecipe(updated); changed(); }); actions.append(button);
      }
      select.addEventListener('change', () => { const updated = values(); updated.steps[i].type = select.value; updated.steps[i].success ||= {}; renderRecipe(updated); changed(); });
      label.addEventListener('input', changed);
      if (step.type !== 'pause') field(card, `steps.${i}`, '网页操作位置', step);
      if (['fill', 'wait'].includes(step.type)) { const input = element('input'); input.id = `browser-step-value-${i}`; input.value = step.value || step.expected || ''; input.placeholder = step.type === 'fill' ? '要填写的固定文字' : '等待文字（可留空，只等待位置显示）'; input.addEventListener('input', changed); card.append(input); }
      if (['save', 'publish'].includes(step.type)) {
        field(card, `steps.${i}.success`, '本次操作的成功提示位置', step.success);
        const prompt = element('label', '', '成功提示应包含的文字'), input = element('input'); input.id = `browser-step-success-${i}`; input.value = step.success?.expected || ''; input.placeholder = '如：保存成功 / 发布任务已提交'; input.addEventListener('input', changed); prompt.append(input); card.append(prompt);
      }
      card.append(actions); steps.append(card);
    });
  }
  function renderItems() {
    const list = $('#browser-items'); list.replaceChildren();
    if (!items.size) list.append(element('p', 'empty', '先读入商品并生成场景图，再加入任务。'));
    for (const row of items.values()) {
      const product = state.products.find(product => product.id === row.productId), card = element('article', 'browser-item');
      const heading = element('div', 'workflow-product'), image = element('img'); image.alt = '待上传图片'; if (product?.processedImage || product?.sourceImage) image.src = product.processedImage || product.sourceImage;
      const description = element('div'); description.append(element('strong', '', product?.title || '商品已删除'), element('p', 'hint', product?.processedImage ? '使用已保存的场景图；网页原有 SKU 与价格保留' : '请到商品工作台生成场景图并保存草稿'));
      heading.append(image, description); card.append(heading);
      const urlLabel = element('label', '', '妙手商品编辑页地址'), url = element('input'); url.type = 'url'; url.value = row.url; url.placeholder = 'https://…（每件商品的编辑页）'; url.setAttribute('aria-label', '商品编辑页 ' + row.productId);
      url.addEventListener('input', () => { row.url = url.value; changed(); }); urlLabel.append(url);
      const identityLabel = element('label', '', '网页显示的商品识别文字'), identity = element('input'); identity.value = row.expectedText; identity.placeholder = '准确的 SKU / 详情 ID'; identity.setAttribute('aria-label', '商品识别 ' + row.productId); identity.addEventListener('input', () => { row.expectedText = identity.value; changed(); }); identityLabel.append(identity);
      const remove = element('button', 'text-button danger', '移出任务'); remove.addEventListener('click', () => { items.delete(row.productId); renderItems(); changed(); });
      card.append(urlLabel, identityLabel, remove); list.append(card);
    }
  }
  function renderJobs() {
    const list = $('#browser-jobs'); list.replaceChildren();
    const active = status?.jobs.find(job => job.status === 'paused'); $('#browser-repair').hidden = !active;
    if (!status?.jobs.length) list.append(element('p', 'hint', '尚无网页操作任务。'));
    for (const job of status?.jobs || []) {
      const card = element('article', 'workflow-job'), heading = element('div', 'workflow-job-heading');
      heading.append(element('strong', '', labels[job.status]), element('span', 'hint', `${job.recipe.shopText} · ${new Date(job.createdAt).toLocaleString('zh-CN')}`)); card.append(heading, element('p', 'hint', job.message));
      for (const item of job.items) {
        const row = element('div', 'workflow-item'); row.append(element('strong', '', item.title), element('span', 'badge', labels[item.status]), element('p', 'hint', `${item.expectedText} · 步骤 ${Math.min(item.stepIndex + 1, job.recipe.steps.length)} / ${job.recipe.steps.length}`));
        for (const step of item.steps) row.append(element('p', 'hint', `${step.state === 'completed' ? '✓' : '…'} ${step.label} · ${labels[step.state] || step.state}`));
        card.append(row);
      }
      if (job.status === 'paused') { const resume = element('button', 'primary', '我已处理页面，继续'); resume.addEventListener('click', () => run(async () => { if (dirty) throw new Error('请先将位置校准应用到暂停任务'); await api(`/api/browser/jobs/${job.id}/resume`, {}); await poll(); })); card.append(resume); }
      if (job.status === 'running') { const pause = element('button', 'secondary', job.pauseRequested ? '正在暂停…' : '暂停并接管'); pause.disabled = Boolean(job.pauseRequested); pause.addEventListener('click', () => run(async () => { await api(`/api/browser/jobs/${job.id}/pause`, {}); await poll(); })); card.append(pause); }
      if (['running', 'paused'].includes(job.status)) { const stop = element('button', 'secondary', job.cancelRequested ? '正在停止…' : '停止后续操作'); stop.disabled = job.cancelRequested; stop.addEventListener('click', () => run(async () => { await api(`/api/browser/jobs/${job.id}/stop`, {}); await poll(); })); card.append(stop); }
      list.append(card);
    }
  }
  async function poll() {
    clearTimeout(timer);
    try {
      status = await api('/api/browser/status'); $('#browser-status').textContent = status.open ? (status.headless ? '云端测试浏览器' : '操作浏览器已打开') : '浏览器未打开'; $('#browser-status').className = `badge ${status.open ? 'ready' : 'draft'}`;
      $('#browser-current').textContent = status.currentUrl ? '当前网页：' + status.currentUrl : '浏览器控制只在本机运行；Windows 默认使用 Edge。';
      if (status.picked && pickRequest?.key === status.picked.key) {
        const result = status.picked, entry = fields.get(pickRequest.field);
        if (result.error || result.cancelled) $('#browser-pick-message').textContent = result.error || '已取消选取';
        else if (entry) { entry.selector.value = result.selector; entry.frame.value = result.frame || ''; changed(); $('#browser-pick-message').textContent = '位置已选取。请保存流程；暂停中的任务可应用校准。'; }
        pickRequest = null;
      }
      renderJobs();
    } catch (error) { $('#browser-run-note').textContent = error.message; }
    timer = setTimeout(poll, status?.picking || status?.jobs.some(job => ['running', 'paused'].includes(job.status)) ? 900 : 3500);
  }
  $('#browser-open').addEventListener('click', () => run(async () => { await api('/api/browser/open', { url: $('#browser-url').value }); await poll(); toast('请在操作浏览器中登录妙手并打开商品页'); }));
  $('#browser-demo').addEventListener('click', () => run(async () => { const url = `http://127.0.0.1:${location.port}/browser-demo/editor?id=101`; $('#browser-url').value = url; await api('/api/browser/open', { url }); await poll(); toast('本地演示已打开，不会操作真实店铺'); }));
  $('#browser-demo-recipe').addEventListener('click', () => { renderRecipe(demoRecipe()); changed(); $('#browser-capture-id').value = 'DEMO-101'; toast('已载入演示配置，真实妙手页面需重新选取'); });
  $('#browser-save-recipe').addEventListener('click', () => run(async () => { const saved = await api('/api/browser/recipe', values()); renderRecipe(saved); dirty = false; toast('网页操作流程已保存'); }));
  $('#browser-repair').addEventListener('click', () => run(async () => { const job = status?.jobs.find(job => job.status === 'paused'); if (!job) throw new Error('没有暂停任务'); await api('/api/browser/repair', { jobId: job.id, recipe: values() }); dirty = false; await poll(); toast('位置已校准，可以继续任务'); }));
  $('#browser-add-step').addEventListener('click', () => { const updated = values(); updated.steps.unshift({ type: 'click', label: '前置点击' }); renderRecipe(updated); changed(); });
  $('#browser-recipe-name').addEventListener('input', changed); $('#browser-shop-text').addEventListener('input', changed);
  $('#browser-capture').addEventListener('click', () => run(async () => {
    if (state.dirty) throw new Error('请先保存商品编辑');
    const result = await api('/api/browser/capture', { recipe: values(), expectedText: $('#browser-capture-id').value, category: $('#browser-capture-category').value });
    await reload(); state.selected.add(result.product.id); items.set(result.product.id, { productId: result.product.id, url: result.editorUrl, expectedText: result.expectedText }); renderItems(); selectProduct(result.product.id, true); showView('products'); toast('商品已读入，请生成场景图并保存草稿，再返回浏览器助手');
  }));
  $('#browser-add-products').addEventListener('click', () => run(async () => {
    if (state.dirty) throw new Error('请先保存商品编辑'); await reload();
    const selected = state.products.filter(product => state.selected.has(product.id)); if (!selected.length) throw new Error('请先在商品工作台勾选商品');
    for (const product of selected) if (!items.has(product.id)) items.set(product.id, { productId: product.id, url: product.sourceUrl || '', expectedText: product.sku || String(product.erpSource?.detailId || '') });
    renderItems(); changed();
  }));
  $('#browser-refresh-products').addEventListener('click', () => run(async () => { await reload(); renderItems(); changed(); }));
  $('#browser-refresh').addEventListener('click', () => run(poll));
  $('#browser-run').addEventListener('click', () => run(async () => {
    if (state.dirty) throw new Error('请先保存商品编辑');
    if (!$('#browser-images-reviewed').checked) throw new Error('请先逐件检查图片、商品链接和目标店铺并勾选确认');
    await reload();
    const rows = [...items.values()].map(row => { const product = state.products.find(product => product.id === row.productId); if (!product?.processedImage) throw new Error('请先为每件商品生成并保存场景图'); return { ...row, revision: product.revision }; });
    submittedRequestId ||= crypto.randomUUID();
    await api('/api/browser/jobs', { recipe: values(), requestId: submittedRequestId, items: rows, imagesReviewed: true, pauseBeforePublish: $('#browser-pause-publish').checked }); dirty = false; await poll(); toast('任务已开始，操作浏览器会逐件上传与保存图片');
  }));
  renderRecipe(recipe); renderItems();
  api('/api/browser/status').then(data => { status = data; if (data.recipe) renderRecipe(data.recipe); poll(); }).catch(error => { $('#browser-run-note').textContent = error.message; });
}
