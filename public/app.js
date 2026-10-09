import { loadTasks, saveTasks, addTask, toggleTask, removeTask } from './tasks.js';
let storage;
try { storage = window.localStorage; } catch { storage = null; }
let tasks = loadTasks(storage);
const list = document.querySelector('#tasks');
const input = document.querySelector('#task-input');
const status = document.querySelector('#status');
function render() {
  list.replaceChildren();
  document.querySelector('#empty').hidden = tasks.length > 0;
  document.querySelector('#count').textContent = `${tasks.filter(task => !task.done).length} 项待完成`;
  for (const task of tasks) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.addEventListener('change', () => update(toggleTask(tasks, task.id)));
    const text = document.createElement('span');
    text.textContent = task.text;
    if (task.done) row.classList.add('done');
    label.append(checkbox, text);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除：${task.text}`);
    remove.addEventListener('click', () => update(removeTask(tasks, task.id)));
    row.append(label, remove);
    list.append(row);
  }
}
function update(next) {
  tasks = next;
  try { saveTasks(storage, tasks); status.textContent = ''; }
  catch { status.textContent = '浏览器无法保存数据，刷新后本次修改可能丢失。'; }
  render();
}
document.querySelector('#task-form').addEventListener('submit', event => {
  event.preventDefault();
  update(addTask(tasks, input.value));
  input.value = '';
  input.focus();
});
document.querySelector('#clear').addEventListener('click', () => update(tasks.filter(task => !task.done)));
render();
