/**
 * 喂料器契约：投影 → 翻译 → 分发，以及"跑飞看门狗"。
 *
 * 看门狗这条不是锦上添花：WorkBuddy 的 hook 是尽力而为的，崩溃/强杀/脚本超时都会让 `Stop`
 * 永远不来，桌宠就会永久停在"这一步正在进行中哦"（DSH 侧当年踩过同一个坑）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionEventBus } from './event-bus.ts';
import { createWorkBuddyFeed } from './feed.ts';

const SESSION = 'b1f0c5f2-2d6a-4a3e-9f31-8a6f0b7c1d22';

function hookOf(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { hook_event_name: event, session_id: SESSION, ...extra };
}

/** 收下来的事件（按到达顺序） */
function collect(bus: ReturnType<typeof createSessionEventBus>) {
  const seen: Array<{ type: string; data?: Record<string, unknown>; sessionId: string }> = [];
  bus.on((session, event) => {
    const s = session as { id?: string };
    const e = event as { type: string; data?: Record<string, unknown> };
    seen.push({ type: e.type, data: e.data, sessionId: String(s?.id ?? '') });
  });
  return seen;
}

describe('createWorkBuddyFeed', () => {
  test('hook → 会话事件：会话 id 原样透传，事件按顺序到达', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const feed = createWorkBuddyFeed(bus, { idleMs: 60_000, now: () => 1000 });

    assert.equal(feed.ingest(hookOf('UserPromptSubmit')), true);
    assert.equal(feed.ingest(hookOf('PreToolUse', { tool_name: 'Bash' })), true);
    assert.equal(feed.ingest(hookOf('PostToolUse', { tool_name: 'Bash' })), true);
    feed.dispose();

    assert.deepEqual(
      seen.map((item) => item.type),
      ['turn/start', 'tool/call', 'tool/result'],
    );
    assert.equal(seen[1]?.data?.name, 'Bash');
    assert.ok(seen.every((item) => item.sessionId === SESSION));
  });

  test('Stop 之后看门狗必须撤掉：不能过一会儿又自己"收工"一次', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const feed = createWorkBuddyFeed(bus, { idleMs: 1000, now: () => 1000 });
    feed.ingest(hookOf('PreToolUse'));
    feed.ingest(hookOf('Stop'));
    t.mock.timers.tick(10_000);
    feed.dispose();
    assert.deepEqual(
      seen.map((item) => item.type),
      ['tool/call', 'turn/end'],
    );
    assert.deepEqual(seen[1]?.data, { reason: { kind: 'completed' } });
  });

  test('看门狗兜底：静默超过 idleMs 自动按 aborted 收工（防永久卡在 working）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const dropped: string[] = [];
    const feed = createWorkBuddyFeed(bus, { idleMs: 1000, now: () => 1000, onDrop: (r) => dropped.push(r) });
    feed.ingest(hookOf('PreToolUse'));
    t.mock.timers.tick(999);
    assert.equal(seen.length, 1, '没到点不该收工');
    t.mock.timers.tick(2);
    feed.dispose();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]?.data, { reason: { kind: 'aborted' } });
    assert.match(dropped.join('\n'), /静默超过/);
  });

  test('每个新事件都重挂看门狗（衡量的是"连续静默"而不是"距离上一个终态"）', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const feed = createWorkBuddyFeed(bus, { idleMs: 1000, now: () => 1000 });
    feed.ingest(hookOf('PreToolUse'));
    t.mock.timers.tick(800);
    feed.ingest(hookOf('PostToolUse'));
    t.mock.timers.tick(800);
    assert.equal(seen.filter((item) => item.type === 'turn/end').length, 0, '中途有事件就不该收工');
    t.mock.timers.tick(300);
    feed.dispose();
    assert.equal(seen.filter((item) => item.type === 'turn/end').length, 1);
  });

  test('丢弃口径：认不出的载荷不进总线，但也不抛（hook 链不能被它带崩）', () => {
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const feed = createWorkBuddyFeed(bus, { idleMs: 0 });
    assert.equal(feed.ingest({ nope: 1 }), false);
    assert.equal(feed.ingest(hookOf('SessionStart')), false);
    assert.equal(feed.ingest(undefined), false);
    feed.dispose();
    assert.equal(seen.length, 0);
    assert.deepEqual(feed.stats(), { events: 0, dropped: 3, sessions: 0, lastEventAt: null });
  });

  test('统计：事件数、会话数、最近事件时间', () => {
    const bus = createSessionEventBus();
    const feed = createWorkBuddyFeed(bus, { idleMs: 0, now: () => 4242 });
    feed.ingest(hookOf('UserPromptSubmit'));
    feed.ingest(hookOf('PreToolUse'));
    feed.ingest({ hook_event_name: 'PreToolUse', session_id: 'other-session' });
    const stats = feed.stats();
    feed.dispose();
    assert.equal(stats.events, 3);
    assert.equal(stats.sessions, 2);
    assert.equal(stats.lastEventAt, 4242);
    assert.equal(stats.dropped, 0);
  });

  test('订阅者抛错不影响其它订阅者（宿主的两个 effect 各自独立）', () => {
    const errors: unknown[] = [];
    const bus = createSessionEventBus((error) => errors.push(error));
    const seen = collect(bus);
    bus.on(() => {
      throw new Error('boom');
    });
    const feed = createWorkBuddyFeed(bus, { idleMs: 0 });
    feed.ingest(hookOf('PreToolUse'));
    feed.dispose();
    assert.equal(seen.length, 1, '好的订阅者照常收到');
    assert.equal(errors.length, 1);
  });

  test('dispose 之后不再收，也不再挂定时器', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bus = createSessionEventBus();
    const seen = collect(bus);
    const feed = createWorkBuddyFeed(bus, { idleMs: 1000, now: () => 1000 });
    feed.ingest(hookOf('PreToolUse'));
    feed.dispose();
    assert.equal(feed.ingest(hookOf('PostToolUse')), false);
    t.mock.timers.tick(5000);
    assert.equal(seen.length, 1);
  });
});
