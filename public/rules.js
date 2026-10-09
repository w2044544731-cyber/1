export function editRules(product, { prefix = '', suffix = '', markup = 0, stock = '' } = {}) {
  const percent = Number(markup);
  if (!Number.isFinite(percent) || percent <= -100 || percent > 1000) throw new Error('价格调整比例须大于 -100%，且不超过 1000%');
  if (stock !== '' && (!Number.isInteger(Number(stock)) || Number(stock) < 0)) throw new Error('统一库存须为非负整数');
  return {
    title: `${prefix}${product.title}${suffix}`.trim(),
    price: product.price == null ? null : Math.round(product.price * (1 + percent / 100) * 100) / 100,
    stock: stock === '' ? product.stock : Number(stock),
  };
}
