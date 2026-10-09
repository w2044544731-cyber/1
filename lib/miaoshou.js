import { createHmac } from 'node:crypto';
import { AppError } from './store.js';

export const COMMON_PREFIX = '/open/v1/product/common_collect_box/common_collect_box/';
export const TEMU_PREFIX = '/open/v1/product/collect_box/pddkj/collect_box/';
export const PUBLISH_PATH = '/open/v1/product/collect_box/pddkj/move_collect/save_move_collect_task';
const paths = new Set([
  ...['get_common_collect_box_list', 'get_common_collect_box_detail', 'edit_common_collect_box_detail', 'claimed'].map(x => COMMON_PREFIX + x),
  ...['get_shop_collect_item_info', 'get_site_collect_item_info', 'get_category_attribute_rules', 'get_item_options'].map(x => TEMU_PREFIX + x),
  PUBLISH_PATH,
]);
export function positiveId(value, label = 'ID') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError(`${label} 须为正整数`);
  return value;
}
export function httpsBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url : null;
  } catch { return null; }
}
export function signRequest(secret, path, timestamp, key, body) {
  return createHmac('sha256', secret).update(secret + path + timestamp + key + body + secret, 'utf8').digest('hex');
}
export function signedMode(env) { return env.MIAOSHOU_AUTH_MODE === 'signed' || Boolean(env.MIAOSHOU_APP_KEY || env.MIAOSHOU_APP_SECRET); }
export function signedConfiguration(env = process.env) {
  const missing = ['MIAOSHOU_APP_KEY', 'MIAOSHOU_APP_SECRET'].filter(name => !env[name]?.trim());
  if (!httpsBase(env.MIAOSHOU_BASE_URL || 'https://openapi-erp.91miaoshou.com')) missing.push('MIAOSHOU_BASE_URL（HTTPS 基础域名）');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.MIAOSHOU_SUCCESS_CODE || '200')) missing.push('MIAOSHOU_SUCCESS_CODE');
  const shopSavePath = env.MIAOSHOU_SHOP_SAVE_PATH || '';
  const savePathValid = shopSavePath.startsWith(TEMU_PREFIX) && /^[a-z][a-z0-9_]*$/.test(shopSavePath.slice(TEMU_PREFIX.length)) && !paths.has(shopSavePath);
  return { configured: !missing.length, missing, auth: 'hmac_sha256', writable: env.MIAOSHOU_WRITE_ENABLED === 'true', shopSaveConfigured: savePathValid, baseUrl: '妙手开放平台', verified: false };
}
export async function boundedJson(response, limit = 2_000_000) {
  let size = 0, text = ''; const decoder = new TextDecoder();
  if (!response.body) throw new Error('Empty response');
  for await (const chunk of response.body) {
    size += chunk.length; if (size > limit) throw new Error('Response too large');
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export function assertClean(value, env = {}) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 2_000_000) throw new AppError('商品详情超过 2 MB', 413);
  function walk(object) {
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      if (/^(cookie|timer_?token|app_?secret|access_?token|authorization|password|x-sign)$/i.test(key) && child) throw new AppError('响应含授权字段，已阻止保存', 502);
      walk(child);
    }
  }
  walk(value);
  for (const key of ['MIAOSHOU_APP_SECRET', 'MIAOSHOU_APP_KEY', 'ERP_COOKIE', 'ERP_TIMER_TOKEN']) {
    if (env[key] && serialized.includes(JSON.stringify(env[key]).slice(1, -1))) throw new AppError('响应包含授权信息，已阻止保存', 502);
  }
}
export class RemoteError extends AppError {
  constructor(message, outcome, code = '') { super(message, 502); this.outcome = outcome; this.code = code; }
}
export function createMiaoshouClient({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  return {
    configuration: () => signedConfiguration(env),
    async request(path, payload, { write = false, publish = false } = {}) {
      const config = signedConfiguration(env);
      if (!config.configured) throw new AppError('妙手签名连接待配置：' + config.missing.join('、'), 501);
      if (!paths.has(path) && !(config.shopSaveConfigured && path === env.MIAOSHOU_SHOP_SAVE_PATH)) throw new AppError('未配置此妙手接口契约', 501);
      if (write && (publish ? env.ERP_PUBLISH_ENABLED !== 'true' : !config.writable)) throw new AppError(publish ? '发布开关尚未开启' : '妙手写入开关尚未开启', 501);
      const body = JSON.stringify(payload), timestamp = String(Math.floor(now() / 1000));
      const headers = { 'Content-Type': 'application/json', 'x-app-key': env.MIAOSHOU_APP_KEY, 'x-timestamp': timestamp, 'x-sign': signRequest(env.MIAOSHOU_APP_SECRET, path, timestamp, env.MIAOSHOU_APP_KEY, body) };
      let response, data;
      try {
        response = await fetchImpl(new URL(path, env.MIAOSHOU_BASE_URL || 'https://openapi-erp.91miaoshou.com'), { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
        data = await boundedJson(response);
      } catch { throw new RemoteError(write ? '远端写入结果未知，请先在妙手核对；不会自动重试' : '妙手读取网络或响应异常', write ? 'unknown' : 'read_error'); }
      let code = String(data?.code ?? '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || [env.MIAOSHOU_APP_KEY, env.MIAOSHOU_APP_SECRET].some(secret => secret && code.includes(secret))) code = '';
      if (response.ok && data?.result === 'success' && String(data.code) === (env.MIAOSHOU_SUCCESS_CODE || '200') && !data.reason) {
        try { assertClean(data.data ?? {}, env); } catch { throw new RemoteError('响应含授权信息或超出限制，未保存；请核对远端结果', write ? 'unknown' : 'read_error'); }
        return data;
      }
      const rejected = [400, 401, 403, 409, 422].includes(response.status) || (response.ok && (data?.result === 'fail' || Boolean(data?.reason)));
      throw new RemoteError(rejected ? '妙手拒绝请求，请核对授权、字段和接口成功码' : '妙手结果无法确认，请在后台核对', write ? (rejected ? 'rejected' : 'unknown') : 'read_error', code);
    },
  };
}
