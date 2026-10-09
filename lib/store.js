import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
function number(value, name, integer = false) {
  if (value === '' || value == null) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || (integer && !Number.isInteger(result))) throw new AppError(`${name}须为非负${integer ? '整数' : '数字'}`);
  return result;
}
export function image(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 8_000_000) throw new AppError('图片过大，请使用小于 6 MB 的图片');
  if (/^https:\/\//.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new AppError('图片 URL 无效'); }
    if (url.username || url.password) throw new AppError('图片 URL 不能包含账号');
    return url.href;
  }
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new AppError('仅支持 PNG、JPEG、WebP 图片或 HTTPS 图片地址');
  const bytes = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new AppError('图片内容与格式不匹配');
  return value;
}
function scenePlan(value) {
  if (!value) return null;
  if (typeof value !== 'object' || value.kind !== 'text_only' || !['kitchen','living','desk','outdoor'].includes(value.scene) || typeof value.prompt !== 'string' || !value.prompt.trim()) throw new AppError('文字场景方案格式无效');
  return { kind: 'text_only', scene: value.scene, reason: clean(value.reason,600), prompt: clean(value.prompt,4000), model: clean(value.model,100), createdAt: clean(value.createdAt,40) };
}
function fields(data) {
  const sourceUrl = clean(data.sourceUrl, 2000);
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch { throw new AppError('来源链接无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('来源链接须为不含账号的 HTTPS 地址');
  }
  const currency = clean(data.currency || 'USD', 3).toUpperCase();
  if (!['USD', 'CNY', 'EUR', 'GBP'].includes(currency)) throw new AppError('暂支持 USD、CNY、EUR、GBP');
  const processedImage = image(data.processedImage);
  if (processedImage && !processedImage.startsWith('data:image/png;base64,')) throw new AppError('处理图须为本地 PNG');
  return {
    title: clean(data.title, 200), sku: clean(data.sku, 80), description: clean(data.description, 5000),
    category: clean(data.category, 100), price: number(data.price, '价格'), stock: number(data.stock, '库存', true), currency,
    sourceUrl, sourceImage: image(data.sourceImage || data.imageUrl), processedImage,
    background: clean(data.background, 20), isDemo: Boolean(data.isDemo), scenePlan: scenePlan(data.scenePlan),
  };
}
export function readiness(product) {
  const missing = [];
  if (!product.title) missing.push('标题');
  if (!product.sku && !product.erpSource?.skuCount) missing.push('SKU');
  if (!product.category) missing.push('分类');
  if (!product.erpSource && !(product.price > 0)) missing.push('大于 0 的价格');
  if (!product.erpSource && (!Number.isInteger(product.stock) || product.stock < 0)) missing.push('库存');
  if (!product.processedImage) missing.push('已处理商品图');
  return missing;
}
function csvCell(value) {
  // Spreadsheet formula protection also covers control characters before formulas.
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csv(products) {
  const columns = ['sku', 'title', 'description', 'category', 'price', 'currency', 'stock', 'image_file', 'sourceUrl'];
  return '\ufeff' + [columns.map(csvCell).join(','), ...products.map(p => columns.map(key => csvCell(key === 'image_file' ? `${p.id}.png` : p[key])).join(','))].join('\r\n');
}
export function createStore(directory) {
  let tail = Promise.resolve();
  const filename = path.join(directory, 'products.json');
  async function read() {
    try {
      const state = JSON.parse(await readFile(filename, 'utf8'));
      if (!Array.isArray(state.products) || !Array.isArray(state.events)) throw new Error('invalid');
      if (state.publishJobs === undefined) state.publishJobs = [];
      if (!Array.isArray(state.publishJobs)) throw new Error('invalid publish jobs');
      if (state.workflowJobs === undefined) state.workflowJobs = [];
      if (!Array.isArray(state.workflowJobs)) throw new Error('invalid workflow jobs');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { products: [], events: [], publishJobs: [], workflowJobs: [] };
      throw new AppError('本地数据无法读取，请检查或恢复 products.json；未覆盖原文件', 500);
    }
  }
  function transact(action) {
    const run = tail.then(async () => {
      const state = await read();
      const result = await action(state);
      await mkdir(directory, { recursive: true });
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2));
      await rename(temp, filename);
      return result;
    });
    tail = run.catch(() => {});
    return run;
  }
  function event(state, type, message) {
    state.events.unshift({ id: randomUUID(), type, message, time: new Date().toISOString() });
    state.events = state.events.slice(0, 100);
  }
  function find(state, id) {
    const product = state.products.find(p => p.id === id);
    if (!product) throw new AppError('商品不存在', 404);
    return product;
  }
  function unlocked(state, id) {
    if (state.workflowJobs.some(job => ['queued', 'running'].includes(job.status) && job.items.some(item => item.productId === id))) throw new AppError('此商品正在自动任务中，完成或停止任务后再编辑', 409);
  }
  return {
    async list() { await tail; return read(); },
    recoverWorkflows() {
      return transact(state => {
        for (const job of state.workflowJobs) {
          if (!['queued', 'running'].includes(job.status)) continue;
          for (const item of job.items) {
            if (['queued', 'running'].includes(item.status)) {
              item.status = item.effects?.length ? 'unknown' : 'blocked';
              item.message = item.effects?.length ? '服务中断，已有远端写入记录；请在妙手核对，不自动重试' : '服务重启，未执行远端写入；请重新预览';
            }
          }
          job.status = job.items.some(x => x.status === 'unknown') ? 'unknown' : 'blocked';
          job.message = '服务重启后已停止旧任务，不会重放远端写入';
          job.updatedAt = new Date().toISOString();
        }
      });
    },
    reserveWorkflow(plan, requestId) {
      return transact(state => {
        if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) throw new AppError('自动任务须提供 UUID requestId');
        const old = state.workflowJobs.find(job => job.requestId === requestId);
        if (old) { if (old.previewHash !== plan.previewHash) throw new AppError('同一请求 ID 不能用于不同任务', 409); return { job: old, created: false }; }
        if (state.workflowJobs.length >= 100) throw new AppError('自动任务记录达到 100 条上限，请先备份和核对', 409);
        for (const item of plan.items) {
          const product = find(state, item.productId); unlocked(state, product.id);
          if (product.revision !== item.revision) throw new AppError('商品版本已变化，请重新预览', 409);
          if (state.workflowJobs.some(job => job.items.some(old => (old.productId === product.id || old.sourceKey === item.sourceKey) && old.status === 'unknown'))) throw new AppError('此商品此前远端写入结果未知，请先在妙手核对，不能重新发送', 409);
        }
        const time = new Date().toISOString();
        const job = { id: randomUUID(), requestId, previewHash: plan.previewHash, demo: plan.demo, shopId: plan.shopId, status: 'queued', cancelRequested: false, items: plan.items.map(item => ({ ...item, status: 'queued', phase: 'waiting', message: '等待处理', effects: [], steps: [] })), createdAt: time, updatedAt: time };
        state.workflowJobs.unshift(job); event(state, 'workflow', `${plan.demo ? '演示' : '真实'}自动任务排队：${job.items.length} 件商品`);
        return { job, created: true };
      });
    },
    workflowJob(id) {
      return this.list().then(state => { const job = state.workflowJobs.find(job => job.id === id); if (!job) throw new AppError('自动任务不存在', 404); return job; });
    },
    changeWorkflow(id, patch, productId = null, sourcePatch = null) {
      return transact(state => {
        const job = state.workflowJobs.find(job => job.id === id);
        if (!job) throw new AppError('自动任务不存在', 404);
        const target = productId ? job.items.find(item => item.productId === productId) : job;
        if (!target) throw new AppError('任务商品不存在', 404);
        Object.assign(target, patch); job.updatedAt = new Date().toISOString();
        if (sourcePatch) {
          const product = find(state, productId);
          product.erpSource.remoteSync = { ...product.erpSource.remoteSync, ...sourcePatch };
          product.revision++; product.updatedAt = job.updatedAt;
        }
        return job;
      });
    },
    stopWorkflow(id) { return this.changeWorkflow(id, { cancelRequested: true }); },
    reservePublish({ requestId, fingerprint, payload }) {
      return transact(state => {
        if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(requestId)) throw new AppError('发布请求须提供 UUID requestId');
        const existing = state.publishJobs.find(job => job.requestId === requestId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new AppError('同一 requestId 不能用于不同发布参数', 409);
          return { job: existing, created: false };
        }
        if (state.publishJobs.some(job => job.fingerprint === fingerprint && job.status !== 'rejected')) throw new AppError('相同店铺与商品已有提交记录；请先在妙手核对结果，不能自动重复提交', 409);
        if (state.publishJobs.length >= 200) throw new AppError('发布记录已达本地上限，请先备份并核对历史任务', 409);
        const job = { id: randomUUID(), requestId, fingerprint, payload, status: 'submitting', message: '请求已记录，若服务中断需在妙手核对结果', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        state.publishJobs.unshift(job);
        event(state, 'publish', `记录 ERP 发布请求：${payload.shopIds.length} 家店铺、${payload.detailIds.length} 个采集箱详情（不含本地修改）`);
        return { job, created: true };
      });
    },
    finishPublish(id, result) {
      return transact(state => {
        const job = state.publishJobs.find(job => job.id === id);
        if (!job) throw new AppError('发布记录不存在', 404);
        Object.assign(job, { status: result.status, code: result.code, message: result.message, updatedAt: new Date().toISOString() });
        event(state, 'publish', result.message);
        return job;
      });
    },
    importErp(product) {
      return transact(state => {
        if (state.products.length >= 500) throw new AppError('本地商品达到 500 件上限');
        const source = product.erpSource;
        if (state.products.some(existing => (existing.erpSource?.box || 'temu_shop') === (source.box || 'temu_shop') && existing.erpSource?.detailId === source.detailId && existing.erpSource?.shopId === source.shopId)) throw new AppError('该采集箱详情已导入；未覆盖已有编辑，请先查看原记录', 409);
        const saved = { ...fields(product), erpSource: source, id: randomUUID(), revision: 1, status: 'draft', updatedAt: new Date().toISOString() };
        state.products.unshift(saved);
        event(state, 'import', `导入妙手${source.box === 'common' ? '公共' : '店铺'}采集箱详情 ${source.detailId}；完整原始资料保留`);
        return saved;
      });
    },
    import(items) {
      return transact(state => {
        if (!Array.isArray(items) || !items.length || items.length > 100) throw new AppError('每次导入 1–100 件商品');
        if (state.products.length + items.length > 500) throw new AppError('本地版本最多保存 500 件商品');
        const products = items.map(data => {
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('商品记录须为对象');
          return { ...fields(data), id: randomUUID(), revision: 1, status: 'draft', updatedAt: new Date().toISOString() };
        });
        state.products.unshift(...products);
        event(state, 'import', `导入 ${products.length} 件商品`);
        return products;
      });
    },
    update(id, patch) {
      return transact(state => {
        unlocked(state, id);
        const product = find(state, id);
        if (patch.revision !== product.revision) throw new AppError('商品已被其他操作更新，请刷新后再编辑', 409);
        const next = fields({ ...product, ...patch, isDemo: product.isDemo });
        if (['title','category','description'].some(key => next[key] !== product[key]) && !Object.hasOwn(patch,'scenePlan')) next.scenePlan = null;
        if (next.sourceImage !== product.sourceImage && !Object.hasOwn(patch, 'processedImage')) {
          next.processedImage = ''; next.background = '';
        }
        Object.assign(product, next, { status: 'draft', revision: product.revision + 1, updatedAt: new Date().toISOString() });
        event(state, 'edit', `保存「${product.title || '未命名商品'}」`);
        return product;
      });
    },
    review(id, revision) {
      return transact(state => {
        unlocked(state, id);
        const product = find(state, id);
        if (revision !== product.revision) throw new AppError('商品版本已变化，请刷新', 409);
        const missing = readiness(product);
        if (missing.length) throw new AppError(`请补充：${missing.join('、')}`);
        Object.assign(product, { status: 'ready', revision: product.revision + 1, updatedAt: new Date().toISOString() });
        event(state, 'review', `「${product.title}」审核通过`);
        return product;
      });
    },
    remove(id, revision) {
      return transact(state => {
        unlocked(state, id);
        const product = find(state, id);
        if (revision !== product.revision) throw new AppError('商品版本已变化，请刷新', 409);
        state.products = state.products.filter(p => p.id !== id);
        event(state, 'delete', `删除「${product.title || '未命名商品'}」`);
        return { ok: true };
      });
    },
    export(ids, format) {
      return transact(state => {
        if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new AppError('请选择 1–100 件商品');
        if (!['json', 'csv'].includes(format)) throw new AppError('请选择 JSON 或 CSV');
        const products = [...new Set(ids)].map(id => { unlocked(state, id); return find(state, id); });
        if (products.some(p => !['ready', 'exported'].includes(p.status) || readiness(p).length)) throw new AppError('只有审核通过的商品可以导出');
        const content = format === 'csv' ? csv(products) : JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), products }, null, 2);
        for (const product of products) Object.assign(product, { status: 'exported', revision: product.revision + 1 });
        event(state, 'export', `导出 ${products.length} 件商品（${format.toUpperCase()}）；尚未上传平台`);
        return { content, format, count: products.length };
      });
    },
  };
}
