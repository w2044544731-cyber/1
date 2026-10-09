import { demoPng } from './demo.js';

// Original local training page, unrelated to Miaoshou's live DOM or endpoints.
export function createBrowserDemo() {
  const products = new Map([['101', { id: '101', title: '演示保温杯', sku: 'DEMO-101', category: '厨房用品' }], ['102', { id: '102', title: '演示桌面收纳盒', sku: 'DEMO-102', category: '办公用品' }]]);
  const image = demoPng();
  return {
    image,
    request(path, method, input) {
      if (path === '/browser-demo/api/product' && method === 'GET') {
        const product = products.get(input.get('id') || '101');
        return product ? { status: 200, data: product } : { status: 404, data: { error: '演示商品不存在' } };
      }
      if (method !== 'POST') return { status: 405, data: { error: '方法无效' } };
      const product = products.get(String(input.id));
      if (!product) return { status: 404, data: { error: '演示商品不存在' } };
      if (path === '/browser-demo/api/save') {
        if (typeof input.image !== 'string' || !input.image.startsWith('data:image/png;base64,')) return { status: 400, data: { error: '请先上传场景图' } };
        product.savedImage = input.image; product.saveCount = (product.saveCount || 0) + 1;
        return { status: 200, data: { message: '图片已保存' } };
      }
      if (path === '/browser-demo/api/publish') {
        if (!product.savedImage) return { status: 409, data: { error: '先保存商品' } };
        product.publishCount = (product.publishCount || 0) + 1;
        return { status: 200, data: { message: '发布任务已提交' } };
      }
      return { status: 404, data: { error: '资源不存在' } };
    },
  };
}
