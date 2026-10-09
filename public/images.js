export function replaceEdgeBackground(pixels, width, height, background = [255, 255, 255], tolerance = 45) {
  const output = new Uint8ClampedArray(pixels);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let tail = 0;
  function enqueue(index) {
    if (visited[index]) return;
    visited[index] = 1;
    const p = index * 4;
    const transparent = pixels[p + 3] < 10;
    const white = Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) >= 255 - tolerance;
    if (transparent || white) queue[tail++] = index;
  }
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  for (let head = 0; head < tail; head++) {
    const index = queue[head], p = index * 4, x = index % width, y = Math.floor(index / width);
    output[p] = background[0]; output[p + 1] = background[1]; output[p + 2] = background[2]; output[p + 3] = 255;
    if (x > 0) enqueue(index - 1);
    if (x < width - 1) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y < height - 1) enqueue(index + width);
  }
  // Transparent interiors also get a flat background.
  for (let p = 0; p < output.length; p += 4) {
    if (output[p + 3] < 255) {
      const alpha = output[p + 3] / 255;
      for (let c = 0; c < 3; c++) output[p + c] = Math.round(output[p + c] * alpha + background[c] * (1 - alpha));
      output[p + 3] = 255;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < tail; i++) mask[queue[i]] = 1;
  return { pixels: output, replaced: tail, mask };
}
export async function processImage(source, color, tolerance) {
  const image = new Image();
  if (source.startsWith('https://')) { image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'; }
  const ready = new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('远程图片无法读取（可能有跨域限制）；请下载商品图后从本地上传'));
  });
  image.src = source;
  await ready;
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const result = replaceEdgeBackground(data.data, canvas.width, canvas.height, rgb, tolerance);
  data.data.set(result.pixels);
  context.putImageData(data, 0, 0);
  return { url: canvas.toDataURL('image/png'), replaced: result.replaced, width: canvas.width, height: canvas.height };
}
export function readImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 6_000_000) throw new Error('图片须小于 6 MB');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
export function demoImage() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 480;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ededed'; context.fillRect(0, 0, 480, 480);
  context.fillStyle = '#406f60'; context.fillRect(156, 105, 168, 280);
  context.fillStyle = '#273f37'; context.fillRect(185, 74, 110, 40);
  context.fillStyle = '#ffffff'; context.font = '24px sans-serif'; context.textAlign = 'center'; context.fillText('DEMO', 240, 246);
  return canvas.toDataURL('image/png');
}

export function chooseScene(product) {
  const text = `${product.category} ${product.title}`.toLowerCase();
  if (/厨房|餐|杯|壶|碗|锅|kitchen|cup|bottle/.test(text)) return 'kitchen';
  if (/户外|露营|运动|outdoor|sport/.test(text)) return 'outdoor';
  if (/办公|电脑|键盘|文具|desk|office/.test(text)) return 'desk';
  return 'living';
}
function shape(ctx, color, x, y, w, h) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); }
export function drawScene(ctx, scene, size = 1000) {
  ctx.save(); ctx.scale(size / 1000, size / 1000);
  const gradient = ctx.createLinearGradient(0, 0, 1000, 1000);
  const colors = { kitchen: ['#f3efdf', '#d4d9c7'], living: ['#f0eae1', '#d8c9b4'], desk: ['#e7edf0', '#c7d8dc'], outdoor: ['#d7e4d0', '#9bb394'] };
  const palette = colors[scene] || colors.living;
  gradient.addColorStop(0, palette[0]); gradient.addColorStop(1, palette[1]); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1000, 1000);
  if (scene === 'kitchen') {
    shape(ctx, '#fffdf3', 60, 80, 330, 380); shape(ctx, '#cdd6c4', 215, 80, 10, 380); shape(ctx, '#cdd6c4', 60, 265, 330, 10);
    shape(ctx, '#b1b99f', 720, 160, 280, 450); shape(ctx, '#d8decc', 745, 180, 235, 190); shape(ctx, '#d8decc', 745, 395, 235, 190);
    shape(ctx, '#e9e2d2', 0, 690, 1000, 310); shape(ctx, '#baa888', 0, 688, 1000, 12);
  } else if (scene === 'desk') {
    shape(ctx, '#a0b0b7', 650, 140, 280, 350); shape(ctx, '#f4f6f7', 670, 160, 240, 310);
    shape(ctx, '#607f85', 795, 490, 15, 195); shape(ctx, '#607f85', 740, 665, 125, 16);
    shape(ctx, '#d7be9e', 0, 700, 1000, 300); shape(ctx, '#b18d64', 0, 700, 1000, 10);
  } else if (scene === 'outdoor') {
    ctx.fillStyle = '#839d75'; ctx.beginPath(); ctx.ellipse(890, 200, 200, 290, -.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#adc39a'; ctx.beginPath(); ctx.ellipse(100, 310, 210, 330, .3, 0, Math.PI * 2); ctx.fill();
    shape(ctx, '#b1aa97', 0, 750, 1000, 250); shape(ctx, '#d7cfbb', 0, 740, 1000, 15);
  } else {
    shape(ctx, '#d6c6b2', 100, 180, 230, 300); shape(ctx, '#f8f3e8', 115, 195, 200, 270);
    shape(ctx, '#b7c2a9', 740, 300, 160, 240); shape(ctx, '#9b856c', 775, 525, 95, 150);
    shape(ctx, '#d5bb99', 0, 720, 1000, 280); shape(ctx, '#b79b77', 0, 712, 1000, 8);
  }
  // Soft product contact shadow; scene templates are illustrative, not AI photos.
  ctx.save(); ctx.filter = 'blur(24px)'; ctx.fillStyle = '#26302825'; ctx.beginPath(); ctx.ellipse(500, 820, 240, 30, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.restore();
}
async function loadImage(source) {
  const image = new Image();
  if (source.startsWith('https://')) { image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'; }
  const ready = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片无法读取；远程地址可能限制跨域，请下载后从本地上传')); });
  image.src = source; await ready; return image;
}
export async function composeScene(source, scene, tolerance, customBackground) {
  const image = await loadImage(source);
  const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
  const foreground = document.createElement('canvas');
  foreground.width = Math.max(1, Math.round(image.naturalWidth * scale)); foreground.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = foreground.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0, foreground.width, foreground.height);
  const data = ctx.getImageData(0, 0, foreground.width, foreground.height);
  // Extract only the edge-connected light background; retain foreground colors.
  const result = replaceEdgeBackground(data.data, foreground.width, foreground.height, [255, 0, 255], tolerance);
  let minX = foreground.width, minY = foreground.height, maxX = -1, maxY = -1;
  for (let i = 0; i < data.data.length; i += 4) {
    const replaced = result.mask[i / 4] === 1;
    if (replaced || data.data[i + 3] < 10) data.data[i + 3] = 0;
    if (data.data[i + 3] > 10) {
      const index = i / 4, x = index % foreground.width, y = Math.floor(index / foreground.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) throw new Error('未识别到商品主体；请降低去底强度或使用已有透明底图');
  ctx.putImageData(data, 0, 0);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1000;
  const output = canvas.getContext('2d');
  if (scene === 'custom') {
    if (!customBackground) throw new Error('请先上传场景背景');
    const bg = await loadImage(customBackground); const zoom = Math.max(1000 / bg.naturalWidth, 1000 / bg.naturalHeight);
    const w = bg.naturalWidth * zoom, h = bg.naturalHeight * zoom; output.drawImage(bg, (1000 - w) / 2, (1000 - h) / 2, w, h);
  } else drawScene(output, scene);
  const w = maxX - minX + 1, h = maxY - minY + 1, zoom = Math.min(650 / w, 660 / h);
  output.drawImage(foreground, minX, minY, w, h, (1000 - w * zoom) / 2, 825 - h * zoom, w * zoom, h * zoom);
  return { url: canvas.toDataURL('image/png'), replaced: result.replaced, width: 1000, height: 1000 };
}
