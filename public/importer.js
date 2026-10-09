function normalize(product, sourceUrl = '') {
  const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
  let image = product.sourceImage || product.imageUrl || product.image || '';
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url || image.contentUrl || '';
  return {
    title: product.title || product.name || '', sku: product.sku || '', description: product.description || '',
    price: product.price ?? offer.price ?? offer.lowPrice ?? null, currency: product.currency || offer.priceCurrency || 'USD',
    stock: product.stock ?? null, category: product.category || '', sourceImage: image,
    sourceUrl: sourceUrl || product.sourceUrl || product.url || '',
    processedImage: product.processedImage || '', background: product.background || '', isDemo: Boolean(product.isDemo),
  };
}
export function parseImport(text, sourceUrl = '') {
  if (!text.trim()) throw new Error('请粘贴商品 JSON 或商品页面 HTML');
  let data;
  try { data = JSON.parse(text); } catch {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const products = [];
    function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if ([node['@type']].flat().includes('Product')) products.push(normalize(node, sourceUrl));
      else Object.values(node).forEach(walk);
    }
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(script.textContent)); } catch { /* Other invalid metadata is not a product. */ }
    }
    if (!products.length) throw new Error('没有找到 Product 结构化数据；可手动填写，或导入 ERP 的 JSON 导出文件');
    return products;
  }
  if (!data || typeof data !== 'object') throw new Error('JSON 须为商品对象、商品数组或 {"products": [...]}');
  const records = Array.isArray(data) ? data : data.products || [data];
  if (!Array.isArray(records) || !records.length || records.some(p => !p || typeof p !== 'object' || Array.isArray(p))) throw new Error('商品数组格式无效');
  return records.map(product => normalize(product, sourceUrl));
}

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV 须包含表头和商品记录');
  const aliases = {
    title: ['title', 'name', '商品名称', '商品标题', '标题'], sku: ['sku', 'SKU', '商品编码', '货号'],
    description: ['description', '商品描述', '描述'], price: ['price', '售价', '价格'], currency: ['currency', '币种'],
    stock: ['stock', '库存', '库存数量'], category: ['category', '分类', '商品分类'],
    imageUrl: ['imageUrl', 'image', '主图', '图片链接', '主图链接'], sourceUrl: ['sourceUrl', 'url', '商品链接', '来源链接', '采集链接'],
  };
  const header = rows.shift().map(value => value.trim());
  if (!aliases.title.some(alias => header.includes(alias))) throw new Error('没有识别到标题列。请使用 title 或 商品标题 表头');
  return rows.map(cells => {
    const product = {};
    for (const [key, names] of Object.entries(aliases)) {
      const index = header.findIndex(name => names.includes(name));
      if (index >= 0) product[key] = cells[index];
    }
    return normalize(product);
  });
}
