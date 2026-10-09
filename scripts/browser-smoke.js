import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'browser-ui-smoke-'));
const executablePath = process.env.BROWSER_TEST_EXECUTABLE || (process.platform === 'linux' ? '/usr/bin/chromium' : '');
const browserOptions = { headless: true, ...(executablePath ? { executablePath } : { channel: process.platform === 'win32' ? 'msedge' : 'chromium' }) };
const server = createServer({ dataDir: directory, publishEnv: {}, sceneEnv: {}, browserEnv: { BROWSER_HEADLESS: 'true', ...(executablePath ? { BROWSER_EXECUTABLE_PATH: executablePath } : { BROWSER_CHANNEL: browserOptions.channel }) } });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(browserOptions);
  const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: '▣ 浏览器操作助手' }).click();
  await page.getByRole('button', { name: '体验本地演示', exact: true }).click();
  await page.locator('#browser-status').filter({ hasText: '云端测试浏览器' }).waitFor();
  await page.getByRole('button', { name: '载入演示配置', exact: true }).click();
  await page.getByRole('button', { name: '保存流程', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '网页操作流程已保存');
  await page.locator('.browser-extract > summary').click();
  await page.getByRole('button', { name: '读取当前商品到工作台', exact: true }).click();
  await page.locator('#products-view:not([hidden])').waitFor();
  await page.getByRole('button', { name: '生成场景图', exact: true }).click();
  await page.locator('#processed-preview:not([hidden])').waitFor();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent === '草稿已保存');
  await page.getByRole('button', { name: '▣ 浏览器操作助手' }).click();
  await page.getByRole('button', { name: '刷新图片与版本', exact: true }).click();
  await page.locator('#browser-images-reviewed').check();
  await page.getByRole('button', { name: '开始网页操作任务', exact: true }).click();
  await page.getByRole('button', { name: '我已处理页面，继续', exact: true }).waitFor();
  await page.getByRole('button', { name: '我已处理页面，继续', exact: true }).click();
  await page.locator('#browser-jobs .workflow-job-heading strong').filter({ hasText: '网页流程完成' }).waitFor();
  const remote = await (await fetch(base + '/browser-demo/api/product?id=101')).json();
  const local = await (await fetch(base + '/api/state')).json();
  assert.equal(remote.savedImage, local.products[0].processedImage);
  assert.equal(remote.publishCount, 1); assert.equal(remote.saveCount, 1);
  assert.ok(remote.savedImage.length > 1000);
  // The workflow editor also supports changing action types without a JS error.
  await page.getByRole('button', { name: '＋ 前置点击步骤', exact: true }).click();
  await page.locator('#browser-step-type-0').selectOption('wait');
  await page.locator('#browser-step-type-0').selectOption('pause');
  await page.locator('#browser-step-type-0').selectOption('fill');
  await page.locator('#browser-step-value-0').fill('example');
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.ARTIFACT_DIR) {
    await mkdir(process.env.ARTIFACT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, 'browser-assistant-desktop.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, 'browser-assistant-mobile.png'), fullPage: true });
  console.log('Browser UI: read → compose actual scene PNG → upload → save → manual review → publish verified; desktop/mobile, no page errors. No real store requests.');
} finally {
  if (browser) await browser.close(); await server.browserAssistant.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
