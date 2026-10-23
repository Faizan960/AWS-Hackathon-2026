import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = 3187 + Math.floor(Math.random() * 700);
const baseUrl = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'actionflow-smoke-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, API_PORT: String(port), ACTIONFLOW_LOCAL_ONLY: '1', ACTIONFLOW_DATA_DIR: dataDir },
  stdio: 'ignore',
});

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${route}: ${response.status} ${payload.error || ''}`);
  return payload;
}

async function main() {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(`API process exited early with code ${child.exitCode}`);
    try {
      const health = await request('/api/health');
      if (health.ok) { ready = true; break; }
    } catch { /* server is still starting */ }
    await delay(250);
  }
  if (!ready) throw new Error('API did not become ready within 20 seconds.');

  const result = await request('/api/assistant', {
    method: 'POST',
    body: JSON.stringify({ message: 'Plan my evening, make a shopping list for dinner, and add a reminder for 7 PM.' }),
  });
  if (result.provider !== 'server-local-agent') throw new Error(`Expected local fallback, got ${result.provider}`);
  if (result.executed.length < 3) throw new Error(`Expected at least 3 executed actions, got ${result.executed.length}`);
  if (!result.state.tasks.length || !result.state.reminders.length || !result.state.shopping.length) {
    throw new Error('Multi-action flow did not update all three collections.');
  }

  const task = result.state.tasks[0];
  const patched = await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
  if (!patched.state.tasks.find(item => item.id === task.id)?.done) throw new Error('Task update did not persist.');
  const reloaded = await request('/api/state');
  if (!reloaded.state.tasks.find(item => item.id === task.id)?.done) throw new Error('Task was not persisted between API requests.');
  await request('/api/reset', { method: 'POST', body: '{}' });
  console.log('ActionFlow smoke test passed: health, multi-action execution, persisted state, task update, and reset.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await delay(300);
  await rm(dataDir, { recursive: true, force: true });
}
