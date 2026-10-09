import { createHash } from 'node:crypto';
import { AppError } from './store.js';
import { COMMON_DETAIL_PATH, COMMON_SAVE_PATH, CLAIM_PATH, commonDetail } from './collect-box.js';
import { positiveId, TEMU_PREFIX, PUBLISH_PATH, RemoteError } from './miaoshou.js';
import { validateTemuShop } from './temu-validation.js';

export function digest(value) {
  function canonical(value) { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function createWorkflows({ store, client, images, env, demo = false }) {
  let active = false, closed = false;
  const ready = store.recoverWorkflows();
  const scope = digest({ base: env.MIAOSHOU_BASE_URL || 'https://openapi-erp.91miaoshou.com', key: env.MIAOSHOU_APP_KEY || '', demo });
  function configuration() {
    const config = client.configuration(), imageConfig = images.configuration();
    const missing = [...config.missing, ...imageConfig.hosting.missing];
    if (!config.writable) missing.push('MIAOSHOU_WRITE_ENABLED=true');
    if (!config.shopSaveConfigured) missing.push('MIAOSHOU_SHOP_SAVE_PATH（需官方店铺保存接口路径）');
    if (env.ERP_PUBLISH_ENABLED !== 'true') missing.push('ERP_PUBLISH_ENABLED=true');
    return { configured: !missing.length, missing, demo, maxProducts: 20, finalStatusAvailable: false, syncFields: ['primary_image'], validation: 'local_baseline_and_upstream_save' };
  }
  async function preview(input) {
    await ready;
    const shopId = positiveId(input.shopId, '目标店铺 ID');
    if (!Array.isArray(input.products) || !input.products.length || input.products.length > 20 || new Set(input.products.map(x => x?.id)).size !== input.products.length) throw new AppError('每个自动任务选择 1–20 件不同商品');
    const state = await store.list(), blockers = [], items = [];
    for (const selected of input.products) {
      const product = state.products.find(product => product.id === selected?.id);
      if (!product) throw new AppError('所选商品不存在', 404);
      if (product.revision !== selected.revision) throw new AppError('商品版本已变化，请刷新后预览', 409);
      const source = product.erpSource, box = source?.box || 'temu_shop';
      const issues = [];
      if (!source || source.origin !== 'live_read') issues.push('请先从妙手接口读取当前商品；文件导入和离线快照不能直接自动发布');
      if (!demo && product.isDemo) issues.push('演示商品不能向真实店铺发布');
      if (!['common', 'temu_shop'].includes(box)) issues.push('不支持此采集箱类型');
      if (box === 'temu_shop' && source?.shopId !== shopId) issues.push('此店铺副本与目标店铺不一致');
      if (!['ready', 'exported'].includes(product.status)) issues.push('请先保存并审核场景图');
      if (!product.processedImage) issues.push('缺少处理后的主图');
      const sourceKey = `${scope}:${box}:${source?.detailId}:${shopId}`;
      if (state.workflowJobs.some(job => ['queued', 'running'].includes(job.status) && job.items.some(item => item.productId === product.id))) issues.push('已有自动任务正在处理');
      if (state.workflowJobs.some(job => job.items.some(item => item.sourceKey === sourceKey && item.status === 'unknown'))) issues.push('此前远端写入结果未知，请先在妙手核对，不能重复发送');
      const imageHash = product.processedImage ? digest(product.processedImage) : '';
      const previous = state.workflowJobs.flatMap(job => job.items).find(item => item.sourceKey === sourceKey && item.status === 'accepted');
      if (previous?.imageHash === imageHash) issues.push('相同主图已提交此店铺，请核对结果，不能重复发布');
      const base = box === 'common' ? (source?.remoteSync?.commonSnapshot || source?.snapshot) : (source?.remoteSync?.shopSnapshot || source?.snapshot);
      let hostedUrl = '';
      if (product.processedImage && images.configuration().hosting.configured) hostedUrl = images.publicUrl(product.processedImage);
      const item = { productId: product.id, revision: product.revision, title: product.title, box, detailId: source?.detailId, sourceKey, imageHash, snapshotHash: digest(base ?? null), hostedUrl, temuDetailId: source?.remoteSync?.temuDetailId || previous?.temuDetailId || (box === 'temu_shop' ? source?.detailId : null) };
      items.push(item);
      for (const issue of issues) blockers.push({ productId: product.id, title: product.title, message: issue });
    }
    const config = configuration();
    return { ...config, ready: config.configured && !blockers.length, shopId, items, blockers, previewHash: digest({ shopId, items, demo, scope }), note: '仅替换第一张主图；保留其余图片、价格、库存和 SKU。远端保存成功后才提交发布，任务接受不代表已经上架。' };
  }
  async function enqueue(input) {
    await ready;
    if (input.confirmed !== true) throw new AppError('请先核对预览的商品图片与目标店铺');
    const old = (await store.list()).workflowJobs.find(job => job.requestId === input.requestId);
    if (old) {
      if (old.previewHash !== input.previewHash) throw new AppError('此请求 ID 已用于其他预览', 409);
      return { job: old, reused: true };
    }
    const plan = await preview(input);
    if (input.previewHash !== plan.previewHash) throw new AppError('预览已变化，请重新预览后提交', 409);
    if (!plan.ready) throw new AppError('任务暂不能执行：' + [...plan.missing, ...plan.blockers.map(x => x.message)].join('；'), 501);
    const result = await store.reserveWorkflow(plan, input.requestId);
    setImmediate(() => pump().catch(() => {}));
    return { job: result.job, reused: !result.created };
  }
  async function patch(jobId, item, values, sync = null) { return store.changeWorkflow(jobId, values, item.productId, sync); }
  async function stage(jobId, item, phase, action, { write = false } = {}) {
    if (closed) throw new AppError('服务正在停止，后续步骤未执行');
    item.phase = phase; item.message = '处理中';
    item.steps.push({ phase, state: 'running', time: new Date().toISOString() });
    if (write) item.effects.push({ phase, outcome: 'sending' });
    await patch(jobId, item, { phase, message: item.message, steps: item.steps, effects: item.effects });
    try {
      const result = await action();
      item.steps.at(-1).state = 'completed';
      if (write) item.effects.at(-1).outcome = 'accepted';
      await patch(jobId, item, { steps: item.steps, effects: item.effects });
      return result;
    } catch (error) {
      item.steps.at(-1).state = 'failed';
      if (write) item.effects.at(-1).outcome = error instanceof RemoteError ? error.outcome : 'unknown';
      await patch(jobId, item, { steps: item.steps, effects: item.effects });
      throw error;
    }
  }
  function shopInfo(result, detailId, shopId) {
    const info = result?.data?.shopCollectItemInfo;
    if (!info || Array.isArray(info) || typeof info !== 'object' || String(info.detailId) !== String(detailId) || String(info.shopId) !== String(shopId)) throw new AppError('Temu 店铺详情响应缺失或目标不匹配', 502);
    return structuredClone(info);
  }
  async function processItem(job, item) {
    try {
      await patch(job.id, item, { status: 'running' });
      const product = (await store.list()).products.find(product => product.id === item.productId);
      if (!product || product.revision !== item.revision || digest(product.processedImage) !== item.imageHash) throw new AppError('商品已变化，未执行任务', 409);
      const hostedUrl = await stage(job.id, item, 'hosting', async () => { const url = await images.host(product.processedImage); await images.verifyHosted(url); return url; });
      let detailId = item.temuDetailId;
      if (item.box === 'common') {
        const current = await stage(job.id, item, 'read_common', async () => commonDetail(await client.request(COMMON_DETAIL_PATH, { commonCollectBoxDetailId: item.detailId }), item.detailId, env));
        if (digest(current.info) !== item.snapshotHash) throw new AppError('公共采集箱资料已变更，请重新读取当前详情，未覆盖远端修改', 409);
        const edit = structuredClone(current.info); edit.imgUrls = [hostedUrl, ...(Array.isArray(edit.imgUrls) ? edit.imgUrls.slice(1) : [])];
        if (current.info.imgUrls?.[0] !== hostedUrl) await stage(job.id, item, 'save_common', () => client.request(COMMON_SAVE_PATH, { commonCollectBoxDetailId: item.detailId, editCommonCollectBoxDetail: edit, ossMd5: current.ossMd5 }, { write: true }), { write: true });
        const saved = await stage(job.id, item, 'verify_common', async () => commonDetail(await client.request(COMMON_DETAIL_PATH, { commonCollectBoxDetailId: item.detailId }), item.detailId, env));
        if (saved.info.imgUrls?.[0] !== hostedUrl || digest(saved.info.skuMap ?? null) !== digest(current.info.skuMap ?? null)) throw new AppError('公共采集箱换图或 SKU 保留结果未确认，请在妙手核对', 502);
        await patch(job.id, item, {}, { commonSnapshot: saved.info, ossMd5: saved.ossMd5 });
        if (!detailId) {
          const claim = await stage(job.id, item, 'claim', () => client.request(CLAIM_PATH, { detailSerialNumberPlatformList: [{ detailId: item.detailId, platform: 'pddkj', serialNumber: 1 }] }, { write: true }), { write: true });
          const mapped = claim.data?.platformCollectBoxDetailIdMap?.pddkj?.[String(item.detailId)];
          if (!Number.isSafeInteger(mapped) || mapped <= 0) { item.effects.at(-1).outcome = 'unknown'; await patch(job.id, item, { effects: item.effects }); throw new RemoteError('认领响应缺少 Temu 商品 ID 映射，请在妙手核对，不能再次认领', 'unknown'); }
          detailId = mapped; item.temuDetailId = detailId;
          await patch(job.id, item, { temuDetailId: detailId }, { temuDetailId: detailId, shopId: job.shopId });
        }
      }
      const payload = { detailId: positiveId(detailId), shopId: job.shopId };
      const current = await stage(job.id, item, 'read_shop', async () => shopInfo(await client.request(TEMU_PREFIX + 'get_shop_collect_item_info', payload), detailId, job.shopId));
      if (item.box === 'temu_shop' && digest(current) !== item.snapshotHash) throw new AppError('Temu 店铺资料已变化，请重新读取，未覆盖远端修改', 409);
      const info = structuredClone(current); info.imgUrls = [hostedUrl, ...(Array.isArray(info.imgUrls) ? info.imgUrls.slice(1) : [])];
      await stage(job.id, item, 'validate', async () => {
        const rules = await client.request(TEMU_PREFIX + 'get_category_attribute_rules', { cid: positiveId(Number(info.cid), '类目 ID') });
        const options = await client.request(TEMU_PREFIX + 'get_item_options', {});
        const issues = validateTemuShop(info, rules, options);
        if (issues.length) throw new AppError('请在妙手补齐商品资料：' + issues.slice(0, 12).join('；'));
      });
      // Re-read immediately before save; never use a write as a validation call.
      const latest = await stage(job.id, item, 'recheck_shop', async () => shopInfo(await client.request(TEMU_PREFIX + 'get_shop_collect_item_info', payload), detailId, job.shopId));
      if (digest(current) !== digest(latest)) throw new AppError('校验期间店铺商品被修改，已停止保存', 409);
      await stage(job.id, item, 'save_shop', () => client.request(env.MIAOSHOU_SHOP_SAVE_PATH, { ...payload, shopCollectItemInfo: info }, { write: true }), { write: true });
      const saved = await stage(job.id, item, 'verify_shop', async () => shopInfo(await client.request(TEMU_PREFIX + 'get_shop_collect_item_info', payload), detailId, job.shopId));
      if (saved.imgUrls?.[0] !== hostedUrl || digest(saved.skuMap ?? null) !== digest(current.skuMap ?? null)) throw new AppError('店铺换图或 SKU 保留结果未确认，未提交发布', 502);
      await patch(job.id, item, {}, { shopSnapshot: saved, temuDetailId: detailId, shopId: job.shopId, imageUrl: hostedUrl });
      await stage(job.id, item, 'publish', () => client.request(PUBLISH_PATH, { detailIds: [detailId], shopIds: [job.shopId] }, { write: true, publish: true }), { write: true });
      item.status = 'accepted'; item.message = demo ? '演示流程完成；未向真实平台发送请求' : '场景主图已保存，发布任务已接受；最终上架待妙手确认';
      await patch(job.id, item, { status: item.status, phase: 'done', message: item.message }, { syncStatus: 'publish_accepted', lastPublishedImageHash: item.imageHash });
    } catch (error) {
      item.status = error.outcome === 'unknown' || item.effects.some(effect => effect.outcome === 'unknown' || effect.outcome === 'sending') ? 'unknown' : item.effects.length ? 'failed' : 'blocked';
      item.message = error instanceof AppError ? error.message : '任务异常，请核对远端结果';
      await patch(job.id, item, { status: item.status, message: item.message });
    }
  }
  async function pump() {
    await ready;
    if (active || closed) return;
    active = true;
    try {
      let job;
      while (!closed && (job = (await store.list()).workflowJobs.find(job => job.status === 'queued'))) {
        await store.changeWorkflow(job.id, { status: 'running' });
        for (const item of job.items) {
          if (closed || (await store.workflowJob(job.id)).cancelRequested) { item.status = 'blocked'; await patch(job.id, item, { status: 'blocked', message: '已停止剩余商品，未执行写入' }); continue; }
          await processItem(job, item);
        }
        const statuses = job.items.map(item => item.status);
        const status = statuses.includes('unknown') ? 'unknown' : statuses.every(x => x === 'accepted') ? 'accepted' : statuses.includes('accepted') ? 'partial' : statuses.includes('failed') ? 'failed' : 'blocked';
        await store.changeWorkflow(job.id, { status, message: status === 'accepted' ? (demo ? '演示完成' : '发布任务已提交，最终上架待确认') : '请查看逐件商品与步骤记录' });
      }
    } finally { active = false; }
  }
  return { configuration, preview, enqueue, ready, close() { closed = true; } };
}
