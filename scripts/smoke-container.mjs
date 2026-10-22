import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] ?? 'mcp-client-demo:verify';
const name = `mcp-smoke-${randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base, cookie = '';
async function start(demo = false) {
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::3333', '-v', `${volume}:/app/.data`, image,
    ...(demo ? ['node', 'dist/server/index.js', '--demo'] : []));
  base = `http://${docker('port', name, '3333/tcp')}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Container did not become ready');
}
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-mcp-workbench': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  assert.ok(response.ok, `API ${path}: ${response.status}`);
  return response.json();
}
try {
  await start();
  assert.equal((await api('config')).demo, false);
  assert.deepEqual((await api('profiles')).profiles, []);
  const html = await (await fetch(base)).text();
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.ok((await fetch(`${base}${asset}`)).ok);
  assert.equal(docker('exec', name, 'id', '-u'), '1000');
  const saved = [];
  for (const transport of ['streamable-http', 'sse']) {
    const { profile } = await api('profiles/save', {
      name: transport, transport,
      url: `http://127.0.0.1:3333/demo/${transport === 'sse' ? 'sse' : 'mcp'}`,
      credentials: { token: 'smoke-only-token', headers: {} },
    });
    saved.push(profile);
  }
  docker('rm', '-f', name);
  cookie = '';
  await start(true);
  assert.equal((await api('profiles')).profiles.length, 2);
  for (const profile of saved) {
    const loaded = await api('profiles/credentials', { id: profile.id, revision: profile.revision });
    assert.equal(loaded.credentials.token, 'smoke-only-token');
    const { connection } = await api('connect', { profileId: profile.id });
    assert.ok(connection.tools.some(t => t.name === 'echo'));
    await api('call', { connectionId: connection.id, name: 'echo', arguments: { message: `container-${profile.transport}` } });
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await api('state')).run;
      if (run.status !== 'running') break;
      await delay(50);
    }
    assert.equal(run.status, 'success');
    assert.deepEqual(run.result.content, [{ type: 'text', text: `container-${profile.transport}` }]);
  }
  console.log('PASS: production HTML/assets, non-root runtime, clean image, volume persistence, HTTP and SSE tool calls');
} finally {
  try { docker('rm', '-f', name); } catch {}
  try { docker('volume', 'rm', volume); } catch {}
}
