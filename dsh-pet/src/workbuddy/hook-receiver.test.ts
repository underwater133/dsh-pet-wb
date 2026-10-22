/**
 * 接收端契约：`POST /wb/hook` 的行为边界。
 *
 * 它跑在 WorkBuddy 的 hook 链上，所以每一条都关乎"会不会拖慢/搞崩别人的任务"：
 *   - 非 POST → 405；坏 JSON → 400；超大载荷 → 413；都不该抛；
 *   - 认得出的事件 → 200 `{ok:true, accepted:true}`，并已分发到总线；
 *   - 不关心的事件（SessionStart）→ 200 `{ok:true, accepted:false}`（丢弃不是错误，
 *     hook 脚本据此安心退出，不会把 WorkBuddy 那边标成失败）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSessionEventBus } from './event-bus.ts';
import { createWorkBuddyFeed } from './feed.ts';
import { createHookHandler, WB_HOOK_PATH } from './hook-receiver.ts';

/** 起一个只挂 hook 处理函数的真 HTTP 服务，返回 base url 与收下的事件 */
async function startHarness(): Promise<{
  url: string;
  seen: Array<{ type: string; sessionId: string }>;
  close: () => Promise<void>;
}> {
  const bus = createSessionEventBus();
  const seen: Array<{ type: string; sessionId: string }> = [];
  bus.on((session, event) => {
    seen.push({ type: String((event as { type: string }).type), sessionId: String((session as { id: string }).id) });
  });
  const feed = createWorkBuddyFeed(bus, { idleMs: 0 });
  const handler = createHookHandler(feed, { timeoutMs: 500 });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${WB_HOOK_PATH}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        feed.dispose();
        server.close(() => resolve());
      }),
  };
}

const SESSION = 'b1f0c5f2-2d6a-4a3e-9f31-8a6f0b7c1d22';

describe('POST /wb/hook', () => {
  test('认得出的事件：200 + 已分发', async () => {
    const harness = await startHarness();
    try {
      const res = await fetch(harness.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: '正文不该被用' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, accepted: true });
      assert.deepEqual(harness.seen, [{ type: 'turn/start', sessionId: SESSION }]);
    } finally {
      await harness.close();
    }
  });

  test('不关心的事件：200 + accepted:false（丢弃不是失败）', async () => {
    const harness = await startHarness();
    try {
      const res = await fetch(harness.url, {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: SESSION }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, accepted: false });
      assert.equal(harness.seen.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('GET → 405；坏 JSON → 400；都带结构化原因', async () => {
    const harness = await startHarness();
    try {
      const get = await fetch(harness.url);
      assert.equal(get.status, 405);
      assert.equal((await get.json()).ok, false);

      const bad = await fetch(harness.url, { method: 'POST', body: '{ not json' });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).reason, /JSON/);
    } finally {
      await harness.close();
    }
  });

  test('超大载荷 → 413（不接受"先收下来再说"）', async () => {
    const harness = await startHarness();
    try {
      const res = await fetch(harness.url, {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, blob: 'x'.repeat(8192) }),
      });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).ok, false);
    } finally {
      await harness.close();
    }
  });

  test('会话 id 非法 → accepted:false（投影层就挡掉，不进状态机）', async () => {
    const harness = await startHarness();
    try {
      const res = await fetch(harness.url, {
        method: 'POST',
        body: JSON.stringify({ hook_event_name: 'Stop', session_id: '../../etc/passwd' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, accepted: false });
      assert.equal(harness.seen.length, 0);
    } finally {
      await harness.close();
    }
  });

  test('连续多条：顺序与最终档位都对（thinking → working → result → success）', async () => {
    const harness = await startHarness();
    try {
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        await fetch(harness.url, {
          method: 'POST',
          body: JSON.stringify({ hook_event_name: event, session_id: SESSION, tool_name: 'Bash' }),
        });
      }
      assert.deepEqual(
        harness.seen.map((item) => item.type),
        ['turn/start', 'tool/call', 'tool/result', 'turn/end'],
      );
    } finally {
      await harness.close();
    }
  });
});
