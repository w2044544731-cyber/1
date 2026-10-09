import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 5)) {
  console.error('Install Node.js 24 LTS (at least 24.5) from https://nodejs.org.'); process.exit(1);
}
const install = process.argv.includes('--install'), demo = process.argv.includes('--demo');
function child(command, args, options = {}) { return spawn(command, args, { stdio: 'inherit', ...options }); }
async function exited(process) { return new Promise(resolve => { process.once('exit', code => resolve(code ?? 1)); process.once('error', error => { console.error(error.message); resolve(1); }); }); }
function open(url) {
  // The only shell command is constant apart from our fixed loopback URL.
  if (process.platform === 'win32') {
    const opener = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { stdio: 'ignore', windowsHide: true });
    opener.on('error', () => console.log('Open the workbench in your browser:', url));
  } else console.log('Workbench address:', url);
}
if (install) {
  const installer = process.platform === 'win32'
    ? child('cmd.exe', ['/d', '/s', '/c', 'npm ci --cache ".local-data/npm-cache"'])
    : child('npm', ['ci', '--cache', '.local-data/npm-cache']);
  const code = await exited(installer);
  if (code === 0) console.log('Ready. Double-click start-windows.bat. Microsoft Edge is used by default.');
  process.exitCode = code;
} else {
  try { await access('node_modules/playwright/package.json'); }
  catch { console.error('Run install-windows.bat first.'); process.exit(1); }
  const port = demo ? '3001' : '3000', url = `http://127.0.0.1:${port}`;
  const healthy = async () => { try { const response = await fetch(url + '/health', { signal: AbortSignal.timeout(1000) }); return (await response.json()).app === 'listing-workbench'; } catch { return false; } };
  if (await healthy()) { open(url); console.log('Workbench is already running.'); }
  else {
    const server = child(process.execPath, ['--use-env-proxy', '--env-file-if-exists=.env', demo ? 'scripts/demo-server.js' : 'server.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: port } });
    const exit = exited(server); let didExit = false; exit.then(() => { didExit = true; });
    let ready = false;
    for (let attempt = 0; attempt < 30 && !didExit; attempt++) {
      if (await healthy()) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!ready) { server.kill(); console.error('Startup failed. Check the error above and whether the port is occupied.'); process.exitCode = 1; }
    else {
      open(url); console.log('Keep this window open. Press Ctrl+C to stop.');
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.kill(signal); });
      process.exitCode = await exit;
    }
  }
}
