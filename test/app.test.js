import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { addTask, toggleTask, removeTask, loadTasks, saveTasks, STORAGE_KEY } from '../public/tasks.js';

test('tasks can be added, completed, removed without mutating previous state', () => {
  const initial = [];
  const added = addTask(initial, '  第一件事  ', 'one');
  assert.deepEqual(initial, []);
  assert.deepEqual(added, [{ id: 'one', text: '第一件事', done: false }]);
  const completed = toggleTask(added, 'one');
  assert.equal(completed[0].done, true);
  assert.equal(added[0].done, false);
  assert.deepEqual(removeTask(completed, 'one'), []);
  assert.equal(addTask(added, '   ', 'two'), added);
});
test('tasks survive serialization and invalid stored data is handled', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const tasks = addTask([], '<script>alert(1)</script>', 'one');
  saveTasks(storage, tasks);
  assert.deepEqual(loadTasks(storage), tasks);
  values.set(STORAGE_KEY, '{broken');
  assert.deepEqual(loadTasks(storage), []);
  values.set(STORAGE_KEY, '[null,{"text":2}]');
  assert.deepEqual(loadTasks(storage), []);
  assert.deepEqual(loadTasks(null), []);
});
test('HTTP serves the complete application, health check, and safe errors', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const [path, type, marker] of [
    ['/', 'text/html', '今日清单'],
    ['/style.css', 'text/css', '@media'],
    ['/app.js', 'text/javascript', 'text.textContent = task.text'],
    ['/tasks.js', 'text/javascript', 'saveTasks'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).includes(marker));
  }
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/.git/config`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
