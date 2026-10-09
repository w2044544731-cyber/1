import { AppError } from './store.js';
import { COMMON_PREFIX, positiveId, assertClean } from './miaoshou.js';

export const LIST_PATH = COMMON_PREFIX + 'get_common_collect_box_list';
export const COMMON_DETAIL_PATH = COMMON_PREFIX + 'get_common_collect_box_detail';
export const COMMON_SAVE_PATH = COMMON_PREFIX + 'edit_common_collect_box_detail';
export const CLAIM_PATH = COMMON_PREFIX + 'claimed';
export function secureImageUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}
export function commonDetail(response, detailId, env = {}) {
  positiveId(detailId, '公共采集箱 ID'); assertClean(response, env);
  const data = response?.data, info = data?.editCommonCollectBoxDetail;
  if (response?.result !== 'success' || !info || Array.isArray(info) || typeof info !== 'object' || typeof info.title !== 'string' || typeof data.ossMd5 !== 'string' || !data.ossMd5) throw new AppError('公共采集箱详情缺少完整商品或 ossMd5', 502);
  if (info.commonCollectBoxDetailId != null && String(info.commonCollectBoxDetailId) !== String(detailId)) throw new AppError('公共采集箱响应 ID 不匹配', 502);
  return { info: structuredClone(info), ossMd5: data.ossMd5 };
}
export function normalizeCommon(response, detailId, { env = {}, demo = false } = {}) {
  const { info, ossMd5 } = commonDetail(response, detailId, env);
  const skus = Object.values(info.skuMap || {}), one = skus.length === 1 ? skus[0] : null;
  const numeric = value => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    title: info.title, sku: info.itemNum || one?.itemNum || '', description: info.notesText || '',
    category: String(info.categoryName || '公共采集箱商品'), price: one ? numeric(one.price) : null,
    stock: one && Number.isSafeInteger(Number(one.stock)) ? Number(one.stock) : null, currency: 'CNY',
    sourceImage: (info.imgUrls || []).map(secureImageUrl).find(Boolean) || '', sourceUrl: secureImageUrl(info.sourceList?.[0]?.sourceItemUrl), isDemo: demo,
    erpSource: { box: 'common', detailId, origin: 'live_read', retrievedAt: new Date().toISOString(), ossMd5, skuCount: skus.length, snapshot: info, syncStatus: 'not_synced', warnings: skus.length > 1 ? [`原始 ${skus.length} 个 SKU 完整保留；自动流程只替换主图，不改价格或库存`] : ['自动流程只替换主图，价格与库存展示不作为平台写入值'] },
  };
}
export function createCollectBox({ client, env = {}, demo = false, demoImage = '' }) {
  return {
    async list(input = {}) {
      const pageNo = positiveId(input.pageNo ?? 1, '页码'), pageSize = positiveId(input.pageSize ?? 20, '每页数量');
      if (pageSize > 100 || pageNo > 10000) throw new AppError('每页最多 100 件，页码最多 10000');
      const filter = { tabPaneName: 'all' };
      if (input.keyword) filter.sourceItemIdKeyword = String(input.keyword).trim().slice(0, 100);
      const result = await client.request(LIST_PATH, { pageNo, pageSize, filter });
      if (!Array.isArray(result.data?.detailList) || !Number.isSafeInteger(result.data.total) || result.data.total < 0) throw new AppError('公共采集箱列表响应格式不匹配', 502);
      return { pageNo, pageSize, total: result.data.total, records: result.data.detailList.map(row => ({ detailId: positiveId(row.commonCollectBoxDetailId, '返回的商品 ID'), title: String(row.title || ''), thumbnail: secureImageUrl(row.thumbnail), sourceUrl: secureImageUrl(row.sourceList?.[0]?.sourceItemUrl), status: String(row.status || '') })) };
    },
    async read(detailId) { const product = normalizeCommon(await client.request(COMMON_DETAIL_PATH, { commonCollectBoxDetailId: positiveId(detailId) }), detailId, { env, demo }); if (demo && demoImage) product.sourceImage = demoImage; return product; },
  };
}
