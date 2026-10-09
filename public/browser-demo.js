const $ = selector => document.querySelector(selector);
const id = new URLSearchParams(location.search).get('id') || '101';
let replacement = '';
async function post(path, data) { const response = await fetch('/browser-demo/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, id }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
async function start() {
  const response = await fetch('/browser-demo/api/product?id=' + encodeURIComponent(id)); const product = await response.json();
  if (!response.ok) { $('#identity').textContent = product.error; return; }
  $('#identity').textContent = '商品识别：' + product.sku;
  for (const field of ['title', 'sku', 'category']) $('#' + field).value = product[field];
}
$('#upload').addEventListener('change', async () => {
  const file = $('#upload').files[0]; if (!file) return;
  replacement = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
  $('#replacement').src = replacement; $('#replacement').hidden = false;
  $('#save-result').textContent = ''; $('#publish-result').textContent = '';
});
$('#save').addEventListener('click', async () => { try { $('#save-result').textContent = (await post('save', { image: replacement })).message; } catch (error) { $('#save-result').textContent = error.message; } });
$('#publish').addEventListener('click', async () => { try { $('#publish-result').textContent = (await post('publish', {})).message; } catch (error) { $('#publish-result').textContent = error.message; } });
start().catch(error => { $('#identity').textContent = error.message; });
