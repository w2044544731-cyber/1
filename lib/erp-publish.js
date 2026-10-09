import { createHash } from 'node:crypto';
import { AppError } from './store.js';
import { createMiaoshouClient, signedMode, signedConfiguration } from './miaoshou.js';

export const PUBLISH_PATH = '/open/v1/product/collect_box/pddkj/move_collect/save_move_collect_task';
const required = ['ERP_API_BASE_URL', 'ERP_COOKIE', 'ERP_TIMER_TOKEN', 'ERP_PUBLISH_SUCCESS_CODE'];
function baseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url;
  } catch { return null; }
}
export function publisherConfiguration(env = process.env) {
  if (signedMode(env)) {
    const config = signedConfiguration(env), missing = [...config.missing];
    if (env.ERP_PUBLISH_ENABLED !== 'true') missing.push('ERP_PUBLISH_ENABLED=true');
    return { configured: !missing.length, missing, auth: config.auth, scope: 'erp_existing_records', localChangesUploaded: false };
  }
  const missing = required.filter(name => !env[name]?.trim());
  if (env.ERP_API_BASE_URL && !baseUrl(env.ERP_API_BASE_URL)) missing.push('ERP_API_BASE_URL（须为 HTTPS 基础域名，不能含路径、凭证或查询参数）');
  if (env.ERP_PUBLISH_ENABLED !== 'true') missing.push('ERP_PUBLISH_ENABLED=true');
  return { configured: missing.length === 0, missing, scope: 'erp_existing_records', localChangesUploaded: false };
}
function ids(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200 || value.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new AppError(`${name} 须为 1–200 个正整数 ID，不能使用 SKU 或商品链接`);
  if (new Set(value).size !== value.length) throw new AppError(`${name} 不能包含重复 ID`);
  return [...value].sort((a,b) => a-b);
}
export function publishPayload(data) {
  return { shopIds: ids(data.shopIds, 'shopIds'), detailIds: ids(data.detailIds, 'detailIds') };
}
export function payloadFingerprint(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
export function publishPreview(data, env = process.env) {
  const payload = publishPayload(data);
  return {
    method: 'POST', path: PUBLISH_PATH, payload, ...publisherConfiguration(env),
    explanation: '发布妙手采集箱中的现有商品。本地编辑和场景图不会由此接口上传；返回成功不等于 Temu 已上架。',
  };
}
async function responseData(response) {
  let size = 0, text = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64_000) throw new Error('Response too large');
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export function createPublisher({ env = process.env, fetchImpl = fetch } = {}) {
  const signed = createMiaoshouClient({ env, fetchImpl });
  return {
    configuration: () => publisherConfiguration(env),
    preview: data => publishPreview(data, env),
    async submit(payload) {
      if (signedMode(env)) {
        try {
          const data = await signed.request(PUBLISH_PATH, publishPayload(payload), { write: true, publish: true });
          return { status: 'accepted', code: String(data.code), message: '发布任务已接受；最终 Temu 上架结果待确认' };
        } catch (error) {
          if (error.status === 501) throw error;
          return { status: error.outcome === 'rejected' ? 'rejected' : 'unknown', code: error.code || '', message: error.outcome === 'rejected' ? '妙手拒绝发布请求，请核对参数和授权' : '发布结果未知，请在妙手核对；不自动重试' };
        }
      }
      if (!publisherConfiguration(env).configured) throw new AppError('发布接口未配置完整，请先配置基础域名、Cookie、timerToken、成功结果码和启用开关', 501);
      const url = new URL(PUBLISH_PATH, baseUrl(env.ERP_API_BASE_URL));
      url.searchParams.set('timerToken', env.ERP_TIMER_TOKEN);
      try {
        const response = await fetchImpl(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: env.ERP_COOKIE },
          body: JSON.stringify(publishPayload(payload)), redirect: 'error', signal: AbortSignal.timeout(20_000),
        });
        const data = await responseData(response);
        // Never return arbitrary upstream messages, headers or echoed credentials.
        const rawCode = String(data?.code ?? '');
        const code = /^[A-Za-z0-9_-]{1,64}$/.test(rawCode) && ![env.ERP_COOKIE, env.ERP_TIMER_TOKEN].some(secret => secret && rawCode.includes(secret)) ? rawCode : '';
        if (response.ok && data?.result === 'success' && String(data.code) === env.ERP_PUBLISH_SUCCESS_CODE && !data.reason) {
          return { status: 'accepted', code, message: '发布请求已被接口接受；未确认 Temu 上架结果' };
        }
        if ([400,401,403,422].includes(response.status)) return { status: 'rejected', code, message: '接口拒绝请求，请核对授权和参数；未确认上架' };
        if (response.ok && data?.reason && String(data.code) !== env.ERP_PUBLISH_SUCCESS_CODE) return { status: 'rejected', code, message: '接口返回业务错误；请在妙手核对具体原因' };
        return { status: 'unknown', code, message: '接口结果无法确认，请在妙手核对任务；不要重复提交' };
      } catch {
        // A timeout or redirect error does not prove that the remote task was not created.
        return { status: 'unknown', code: '', message: '网络或响应异常，是否已创建任务未知；请在妙手核对，不自动重试' };
      }
    },
  };
}
