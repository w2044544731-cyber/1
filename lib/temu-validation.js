// Local checks cover the supplied contracts. The upstream save remains authoritative.
export function validateTemuShop(info, rulesResponse, optionsResponse) {
  const errors = [], missing = value => value == null || value === '';
  for (const key of ['detailId', 'shopId', 'cid', 'title', 'productOriginCountry', 'outerPackageShape', 'outerPackageType', 'editModel', 'isBasePlate']) {
    if (missing(info[key])) errors.push(`缺少 ${key}`);
  }
  for (const key of ['imgUrls', 'outerPackageImgUrls', 'goodsLayerDecorationReqs']) if (!Array.isArray(info[key]) || !info[key].length) errors.push(`缺少 ${key}`);
  if (['CN', 'CHN'].includes(info.productOriginCountry) && !info.productOriginProvince) errors.push('缺少原产省份 productOriginProvince');
  if (![0, 1, 2].includes(Number(info.isBasePlate))) errors.push('isBasePlate 枚举无效');
  const skus = info.skuMap;
  if (!skus || Array.isArray(skus) || !Object.keys(skus).length) errors.push('缺少完整 SKU');
  for (const [key, sku] of Object.entries(skus || {})) {
    for (const field of ['length', 'width', 'height', 'price', 'weight']) {
      if (!sku || missing(sku[field]) || typeof sku[field] === 'boolean' || !Number.isFinite(Number(sku[field])) || Number(sku[field]) < 0) errors.push(`SKU ${key} 的 ${field} 缺失或无效`);
    }
  }
  const rules = rulesResponse?.data, options = optionsResponse?.data;
  if (!rules || !options) return [...errors, '类目规则或商品选项响应格式不匹配'];
  for (const [field, ruleKey] of [['attributes', 'productAttributeRules'], ['saleAttributes', 'saleAttributeRules']]) {
    if (!Array.isArray(info[field])) { errors.push(`${field} 须为完整数组`); continue; }
    const list = rules[ruleKey] ?? (field === 'attributes' ? rules.attributeRules : undefined);
    if (!Array.isArray(list)) { errors.push(`${ruleKey} 规则未提供，不能确认属性要求`); continue; }
    for (const rule of list) {
      const attr = info[field].find(value => value && (String(value.templatePid ?? '') === String(rule.templatePid ?? '__none') || String(value.pid ?? '') === String(rule.pid ?? '__none') || value.name === rule.name));
      if (rule.required && (!attr || !Array.isArray(attr.values) || !attr.values.length)) errors.push(`必填属性未完成：${rule.name || rule.pid}`);
      // Conditional and category-specific rules are retained for upstream validation; do not fabricate values.
    }
  }
  for (const [field, key] of [['outerPackageShape', 'outerPackageShapeOptions'], ['outerPackageType', 'outerPackageTypeOptions']]) {
    if (Array.isArray(options[key]) && options[key].length && !options[key].some(option => String(option.key ?? option.value) === String(info[field]))) errors.push(`${field} 不在当前平台选项中`);
  }
  return errors;
}
