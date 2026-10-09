import { AppError } from './store.js';
import { createMiaoshouClient, signedMode, signedConfiguration, assertClean } from './miaoshou.js';
export const DETAILS_PATH = '/open/v1/product/collect_box/pddkj/collect_box/get_shop_collect_item_info';
function baseUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url : null; }
  catch { return null; }
}
function id(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(`${name} 须为正整数 ID`);
  return value;
}
export function detailsPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('请求须包含 detailId 和 shopId');
  const payload = { detailId: id(data.detailId, 'detailId'), shopId: id(data.shopId, 'shopId') };
  // cid intentionally unsupported: this workflow must not silently switch category.
  if (Object.hasOwn(data, 'cid')) throw new AppError('读取商品时不切换类目，请勿传 cid');
  return payload;
}
export function readerConfiguration(env = process.env) {
  if (signedMode(env)) return { ...signedConfiguration(env), path: DETAILS_PATH };
  const names = ['ERP_API_BASE_URL', 'ERP_COOKIE', 'ERP_TIMER_TOKEN', 'ERP_READ_SUCCESS_CODE'];
  const missing = names.filter(name => !env[name]?.trim());
  if (env.ERP_API_BASE_URL && !baseUrl(env.ERP_API_BASE_URL)) missing.push('ERP_API_BASE_URL（须为 HTTPS 基础域名）');
  return { configured: missing.length === 0, missing, path: DETAILS_PATH };
}
function returnedId(value, requested, label) {
  if (value === undefined || value === null || value === '') return;
  if (!/^\d+$/.test(String(value)) || Number(value) !== requested) throw new AppError(`返回的${label}与请求不一致，未导入`, 502);
}
export function normalizeDetails(response, request, { origin = 'offline_response', env = {} } = {}) {
  const payload = detailsPayload(request);
  assertClean(response, env);
  const info = response?.data?.shopCollectItemInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info) || typeof info.title !== 'string') throw new AppError('响应须包含 data.shopCollectItemInfo 和商品标题');
  if (response.reason) throw new AppError('该响应含错误信息，不能导入商品');
  if (response.result !== 'success' || typeof response.code !== 'string') throw new AppError('响应须包含 result=success 和字符串 code');
  if (env.ERP_READ_SUCCESS_CODE && response.code !== env.ERP_READ_SUCCESS_CODE) throw new AppError('响应结果码与配置的读取成功码不一致，未导入', 502);
  function checkKeys(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(cookie|timerToken|appSecret|accessToken|authorization|password)$/i.test(key) && child) throw new AppError('商品详情含授权字段，已阻止保存', 502);
      checkKeys(child);
    }
  }
  checkKeys(info);
  const serialized = JSON.stringify(info);
  if (serialized.length > 2_000_000) throw new AppError('商品详情过大，请拆分处理', 413);
  for (const secret of [env.ERP_COOKIE, env.ERP_TIMER_TOKEN]) {
    if (secret && serialized.includes(JSON.stringify(secret).slice(1, -1))) throw new AppError('响应包含授权信息，已阻止导入', 502);
  }
  returnedId(info.detailId, payload.detailId, '详情 ID'); returnedId(info.shopId, payload.shopId, '店铺 ID');
  if (info.skuMap !== undefined && (!info.skuMap || typeof info.skuMap !== 'object' || Array.isArray(info.skuMap))) throw new AppError('skuMap 格式无效');
  const entries = Object.entries(info.skuMap || {});
  if (entries.some(([,sku]) => !sku || typeof sku !== 'object' || Array.isArray(sku))) throw new AppError('SKU 条目格式无效');
  const sku = entries.length === 1 ? entries[0][1] : null;
  const urls = Array.isArray(info.imgUrls) ? info.imgUrls.filter(url => typeof url === 'string') : [];
  const https = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  };
  const sourceImage = urls.map(https).find(Boolean) || https(sku?.imgUrl) || '';
  const warnings = [];
  if (entries.length > 1) warnings.push(`保留了 ${entries.length} 个 SKU；本地售价和库存留空，不把多规格合并成一项`);
  if (!sourceImage) warnings.push('没有可用 HTTPS 主图，可上传本地商品原图');
  if (origin === 'offline_response') warnings.push('离线导入，未验证此数据来自当前账号或仍为最新版本');
  const texts = Array.isArray(info.goodsLayerDecorationReqs) ? info.goodsLayerDecorationReqs.filter(block => block?.type === 'text').map(block => block.content?.text || '') : [];
  return {
    title: info.title, sku: info.itemNum || sku?.itemNum || '', category: info.cid ? `类目 ${info.cid}` : '',
    price: typeof sku?.price === 'number' ? sku.price : null, stock: Number.isInteger(sku?.stock) ? sku.stock : null,
    currency: 'CNY', // The supplied schema explicitly documents skuMap.price in RMB.
    description: texts.join('\n'), sourceImage, sourceUrl: https(info.outerGoodsUrl),
    erpSource: { ...payload, origin, retrievedAt: new Date().toISOString(), site: String(info.site || ''), skuCount: entries.length, snapshot: structuredClone(info), warnings, syncStatus: 'not_synced' },
  };
}
export function createDetailsReader({ env = process.env, fetchImpl = fetch } = {}) {
  const signed = createMiaoshouClient({ env, fetchImpl });
  return {
    configuration: () => readerConfiguration(env),
    async read(request) {
      const payload = detailsPayload(request);
      if (signedMode(env)) return normalizeDetails(await signed.request(DETAILS_PATH, payload), payload, { origin: 'live_read', env: { ...env, ERP_READ_SUCCESS_CODE: env.MIAOSHOU_SUCCESS_CODE || '200' } });
      if (!readerConfiguration(env).configured) throw new AppError('采集箱读取未配置完整：需要基础域名、Cookie、timerToken 和读取成功码', 501);
      const url = new URL(DETAILS_PATH, baseUrl(env.ERP_API_BASE_URL)); url.searchParams.set('timerToken', env.ERP_TIMER_TOKEN);
      try {
        const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: env.ERP_COOKIE }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new AppError('妙手读取请求失败，请核对账号授权与基础域名', 502);
        let size = 0, text = ''; const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          size += chunk.length; if (size > 2_000_000) throw new AppError('详情响应超过 2 MB', 502);
          text += decoder.decode(chunk, { stream: true });
        }
        const data = JSON.parse(text + decoder.decode());
        if (data.result !== 'success' || data.code !== env.ERP_READ_SUCCESS_CODE || data.reason) throw new AppError('读取结果未满足明确的成功条件，未导入商品', 502);
        return normalizeDetails(data, payload, { origin: 'live_read', env });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('读取网络或响应异常，未保存商品；请核对连接', 502);
      }
    },
    importResponse(response, request) { return normalizeDetails(response, request, { env }); },
  };
}
