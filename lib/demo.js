import { deflateSync } from 'node:zlib';
import { COMMON_PREFIX, TEMU_PREFIX, PUBLISH_PATH } from './miaoshou.js';

// A small original illustration for the isolated demo; no external images or APIs.
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function chunk(type, bytes) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}
export function demoPng() {
  const size = 320, rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = y * (size * 3 + 1) + 1 + x * 3;
    const body = x >= 108 && x <= 212 && y >= 74 && y <= 265, cap = x >= 120 && x <= 200 && y >= 48 && y < 74;
    const highlight = body && x < 128;
    rows.set(cap ? [40, 62, 54] : highlight ? [107, 156, 123] : body ? [64, 111, 92] : [245, 245, 240], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export function createDemo() {
  const savePath = TEMU_PREFIX + 'demo_shop_save', common = new Map(), shops = new Map();
  for (const [id, title, categoryName] of [[101, '演示保温杯', '厨房用品'], [102, '演示桌面收纳盒', '办公用品']]) {
    common.set(id, { ossMd5: 'demo-version-1', info: { commonCollectBoxDetailId: id, title, itemNum: 'DEMO-' + id, categoryName, notesText: '演示资料，不代表真实商品或店铺', imgUrls: ['https://demo.invalid/source.png', 'https://demo.invalid/detail.png'], sourceList: [{ sourceItemUrl: 'https://demo.invalid/product/' + id }], colorMap: { green: { imgUrl: 'https://demo.invalid/green.png' } }, skuMap: { ';green;': { itemNum: 'DEMO-' + id, price: '19.90', stock: 20, packageLength: 20, packageWidth: 10, packageHeight: 10, weight: 0.3 } } } });
  }
  let nextId = 1001;
  const maps = new Map();
  const success = data => new Response(JSON.stringify({ result: 'success', code: '200', data }), { headers: { 'Content-Type': 'application/json' } });
  const failure = () => new Response(JSON.stringify({ result: 'fail', code: 'demoInvalid', reason: 'Demo contract mismatch' }), { status: 400 });
  return {
    env: { MIAOSHOU_AUTH_MODE: 'signed', MIAOSHOU_APP_KEY: 'demo-app', MIAOSHOU_APP_SECRET: 'demo-local-signing', MIAOSHOU_BASE_URL: 'https://demo.invalid', MIAOSHOU_SUCCESS_CODE: '200', MIAOSHOU_WRITE_ENABLED: 'true', MIAOSHOU_SHOP_SAVE_PATH: savePath, ERP_PUBLISH_ENABLED: 'true', IMAGE_PUBLIC_BASE_URL: 'https://demo.invalid' },
    image: 'data:image/png;base64,' + demoPng().toString('base64'),
    async fetch(url, options = {}) {
      const u = new URL(url);
      if (u.hostname !== 'demo.invalid') return failure();
      const data = JSON.parse(options.body || '{}'), endpoint = u.pathname;
      if (endpoint === COMMON_PREFIX + 'get_common_collect_box_list') return success({ total: common.size, detailList: [...common.entries()].slice((data.pageNo - 1) * data.pageSize, data.pageNo * data.pageSize).map(([id, record]) => ({ commonCollectBoxDetailId: id, title: record.info.title, sourceList: record.info.sourceList, status: 'noClaimed' })) });
      if (endpoint === COMMON_PREFIX + 'get_common_collect_box_detail') { const record = common.get(data.commonCollectBoxDetailId); return record ? success({ ossMd5: record.ossMd5, editCommonCollectBoxDetail: record.info }) : failure(); }
      if (endpoint === COMMON_PREFIX + 'edit_common_collect_box_detail') {
        const record = common.get(data.commonCollectBoxDetailId);
        if (!record || record.ossMd5 !== data.ossMd5) return failure();
        record.info = structuredClone(data.editCommonCollectBoxDetail); record.ossMd5 += '-updated'; return success({ ossMd5: record.ossMd5 });
      }
      if (endpoint === COMMON_PREFIX + 'claimed') {
        const map = {};
        for (const row of data.detailSerialNumberPlatformList || []) { if (row.platform !== 'pddkj' || !common.has(row.detailId)) return failure(); if (!maps.has(row.detailId)) maps.set(row.detailId, nextId++); map[row.detailId] = maps.get(row.detailId); }
        return success({ platformCollectBoxDetailIdMap: { pddkj: map } });
      }
      if (endpoint === TEMU_PREFIX + 'get_shop_collect_item_info') {
        const key = `${data.detailId}:${data.shopId}`;
        if (!shops.has(key)) {
          const commonId = [...maps.entries()].find(([, value]) => value === data.detailId)?.[0], record = common.get(commonId);
          if (!record) return failure();
          shops.set(key, { detailId: data.detailId, shopId: data.shopId, cid: 55, title: record.info.title, imgUrls: [...record.info.imgUrls], outerPackageImgUrls: ['https://demo.invalid/package.png'], outerPackageShape: 0, outerPackageType: 0, isBasePlate: 0, editModel: 0, productOriginCountry: 'CN', productOriginProvince: '浙江', attributes: [], saleAttributes: [], goodsLayerDecorationReqs: [{ type: 'text', content: { text: '演示商品资料' } }], skuMap: { ';green;': { itemNum: record.info.itemNum, price: 19.9, stock: 20, length: '20.5', width: '10', height: '10', weight: 300 } }, preservedExtraField: { demo: true } });
        }
        return success({ shopCollectItemInfo: shops.get(key) });
      }
      if (endpoint === TEMU_PREFIX + 'get_category_attribute_rules') return success({ productAttributeRules: [], saleAttributeRules: [] });
      if (endpoint === TEMU_PREFIX + 'get_item_options') return success({ outerPackageShapeOptions: [{ key: 0 }], outerPackageTypeOptions: [{ key: 0 }] });
      if (endpoint === savePath) { const key = `${data.detailId}:${data.shopId}`; if (!shops.has(key)) return failure(); shops.set(key, structuredClone(data.shopCollectItemInfo)); return success({}); }
      if (endpoint === PUBLISH_PATH) return data.detailIds?.every(id => data.shopIds?.every(shopId => shops.has(`${id}:${shopId}`))) ? success({}) : failure();
      return failure();
    },
  };
}
