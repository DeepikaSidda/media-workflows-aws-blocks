/**
 * End-to-end tests — media workflow API via the same typed client the frontend uses.
 * Run:  npm run test:e2e
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// ─── Setup (don't touch) ─────────────────────────────────────────────────────
test.before(async () => {
  if (!(await isServerRunning())) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }
  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;
  for (let i = 0; i < 30; i++) {
    try {
      await authApi.getAuthState();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid); } catch { /* ignore */ }
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('unauthenticated uploads are rejected', async () => {
  await assert.rejects(() => api.uploadImage('x.png', 'image/png', ''));
});

test('unauthenticated listJobs is rejected', async () => {
  await assert.rejects(() => api.listJobs());
});
