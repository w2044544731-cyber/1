import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, image as validateImage } from './store.js';
import { boundedJson } from './miaoshou.js';

const MAX_BYTES = 6_000_000;
function privateHost(host) { return /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(host) || /\.(localhost|local)$/.test(host); }
function publicBase(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !privateHost(url.hostname) ? url.href.replace(/\/$/, '') : ''; } catch { return ''; }
}
function imageEndpoint(value) {
  try { const url = new URL(value || 'https://api.openai.com/v1'); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !privateHost(url.hostname) ? url.href.replace(/\/$/, '') + '/images/edits' : ''; } catch { return ''; }
}
export function createProductImages({ directory, env = process.env, fetchImpl = fetch, demoImage = null }) {
  const allowedHosts = (env.IMAGE_SOURCE_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const mediaDir = path.join(directory, 'media');
  const hostConfiguration = () => ({ configured: Boolean(publicBase(env.IMAGE_PUBLIC_BASE_URL)), missing: publicBase(env.IMAGE_PUBLIC_BASE_URL) ? [] : ['IMAGE_PUBLIC_BASE_URL（可公开访问的 HTTPS 图片地址）'], mode: 'self_hosted', verified: false });
  const aiConfiguration = () => {
    const missing = [];
    if (!env.SCENE_IMAGE_API_KEY?.trim()) missing.push('SCENE_IMAGE_API_KEY');
    if (!imageEndpoint(env.SCENE_IMAGE_BASE_URL)) missing.push('SCENE_IMAGE_BASE_URL');
    if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(env.SCENE_IMAGE_MODEL || 'gpt-image-1')) missing.push('SCENE_IMAGE_MODEL');
    return { configured: !missing.length, missing, provider: 'OpenAI-compatible image edits', model: env.SCENE_IMAGE_MODEL || 'gpt-image-1', verified: false };
  };
  async function source(product) {
    if (demoImage && product.isDemo) return demoImage;
    if (product.sourceImage?.startsWith('data:')) return validateImage(product.sourceImage);
    let url;
    try { url = new URL(product.sourceImage); } catch { throw new AppError('商品原图缺失'); }
    if (url.protocol !== 'https:' || url.username || url.password || privateHost(url.hostname) || !allowedHosts.some(host => host === url.hostname || (host.startsWith('*.') && url.hostname.endsWith(host.slice(1))))) throw new AppError('此图片域名尚未配置读取权限，请设置 IMAGE_SOURCE_HOSTS 或上传本地原图', 501);
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Fetch failed');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new Error('Image too large'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      const mime = bytes[0] === 137 ? 'png' : bytes[0] === 255 ? 'jpeg' : 'webp';
      return validateImage(`data:image/${mime};base64,${bytes.toString('base64')}`);
    } catch { throw new AppError('原图下载失败或格式无效，请上传本地原图', 502); }
  }
  return {
    configuration: () => ({ hosting: hostConfiguration(), imageAi: aiConfiguration(), sourceHostsConfigured: Boolean(allowedHosts.length) }),
    source,
    publicUrl(data) {
      if (!hostConfiguration().configured) throw new AppError('图片托管地址未配置，不能将本地图片提交到妙手', 501);
      validateImage(data);
      if (!data.startsWith('data:image/png;base64,')) throw new AppError('工作流输出须为 PNG');
      const hash = createHash('sha256').update(Buffer.from(data.split(',')[1], 'base64')).digest('hex');
      return `${publicBase(env.IMAGE_PUBLIC_BASE_URL)}/media/${hash}.png`;
    },
    async host(data) {
      const url = this.publicUrl(data), name = url.split('/').pop(), bytes = Buffer.from(data.split(',')[1], 'base64');
      await mkdir(mediaDir, { recursive: true });
      try { await writeFile(path.join(mediaDir, name), bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return url;
    },
    async readMedia(name) {
      if (!/^[a-f0-9]{64}\.png$/.test(name)) throw new AppError('图片不存在', 404);
      try { return await readFile(path.join(mediaDir, name)); } catch (error) { if (error.code === 'ENOENT') throw new AppError('图片不存在', 404); throw error; }
    },
    async verifyHosted(url) {
      if (demoImage) return;
      const base = publicBase(env.IMAGE_PUBLIC_BASE_URL);
      if (!base || !url.startsWith(base + '/media/') || !/^[a-f0-9]{64}\.png$/.test(url.split('/').pop())) throw new AppError('图片不属于已配置托管地址');
      try {
        const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error('Unavailable');
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new Error('Large image'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks), filename = url.split('/').pop();
        if (createHash('sha256').update(bytes).digest('hex') + '.png' !== filename) throw new Error('Different image');
      } catch { throw new AppError('公网图片无法读取或内容不匹配，已停止写入；请检查 HTTPS 托管与反向代理', 502); }
    },
    async edit(product, input = {}) {
      if (!aiConfiguration().configured) throw new AppError('AI 图像编辑待配置：' + aiConfiguration().missing.join('、'), 501);
      const prompt = String(input.prompt || '').trim();
      if (!prompt || prompt.length > 4000) throw new AppError('请填写 1–4000 字的场景编辑提示词');
      const original = await source(product), [prefix, data] = original.split(',');
      const mime = prefix.match(/^data:(image\/(?:png|jpeg|webp));base64$/)?.[1];
      if (!mime) throw new AppError('原图格式无效');
      const form = new FormData();
      form.set('model', env.SCENE_IMAGE_MODEL || 'gpt-image-1');
      form.set('prompt', 'Replace only the background. Preserve the product identity, shape, color, texture, logos and proportions exactly. Do not add accessories, text or claims. Scene: ' + prompt);
      form.set('image', new Blob([Buffer.from(data, 'base64')], { type: mime }), 'product.' + mime.split('/')[1]);
      form.set('n', '1'); form.set('size', '1024x1024'); form.set('output_format', 'png');
      try {
        const response = await fetchImpl(imageEndpoint(env.SCENE_IMAGE_BASE_URL), { method: 'POST', headers: { Authorization: `Bearer ${env.SCENE_IMAGE_API_KEY}` }, body: form, redirect: 'error', signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new AppError('图像服务拒绝请求，请核对模型、权限与兼容格式', 502);
        const result = await boundedJson(response, 8_100_000), output = result?.data?.[0]?.b64_json;
        if (typeof output !== 'string') throw new AppError('图像服务须返回 data[0].b64_json 的 PNG；未保存图片', 502);
        if (output.includes(env.SCENE_IMAGE_API_KEY)) throw new AppError('图像响应含授权信息，已阻止保存', 502);
        return { processedImage: validateImage('data:image/png;base64,' + output), background: 'ai', model: env.SCENE_IMAGE_MODEL || 'gpt-image-1' };
      } catch (error) { if (error instanceof AppError) throw error; throw new AppError('图像编辑请求或响应异常；不会自动重试收费请求', 502); }
    },
  };
}
