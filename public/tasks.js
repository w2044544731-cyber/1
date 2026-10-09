export const STORAGE_KEY = 'simple-todo-v1';
export function loadTasks(storage) {
  try {
    const data = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(data) ? data.filter(task => task && typeof task.id === 'string' && typeof task.text === 'string' && typeof task.done === 'boolean') : [];
  } catch { return []; }
}
export function saveTasks(storage, tasks) { storage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }
export function addTask(tasks, text, id = crypto.randomUUID()) {
  const cleaned = text.trim();
  return cleaned ? [...tasks, { id, text: cleaned.slice(0, 200), done: false }] : tasks;
}
export function toggleTask(tasks, id) { return tasks.map(task => task.id === id ? { ...task, done: !task.done } : task); }
export function removeTask(tasks, id) { return tasks.filter(task => task.id !== id); }
