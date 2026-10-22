/**
 * 接线契约：伪 ctx 的 `ctx.on('session/event')` 必须真的接到外部总线。
 *
 * 这一条是整套改造成立的前提——宿主半边（`src/host/index.ts`）全靠这个订阅驱动六档工作状态；
 * 伪 ctx 以前"永不触发"，现在要能被 WorkBuddy 的 hook 喂起来，而且**不该顺便**订阅
 * 别的宿主事件（`agent/error` 等独立模式没有来源）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStandaloneContext, type StandaloneLogger } from '../standalone/context.ts';
import { createSessionEventBus } from './event-bus.ts';

const silentLogger: StandaloneLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

type OnFn = (name: string, handler: (session: unknown, event: unknown) => void) => () => void;

function onOf(options: { sessionEvents?: ReturnType<typeof createSessionEventBus> }): OnFn {
  const context = createStandaloneContext({ port: 3080, logger: silentLogger, ...options });
  return (context.ctx as { on: OnFn }).on;
}

describe('伪 ctx 的事件订阅', () => {
  test('没有外部总线时保持老口径：订阅了也永远收不到（工作状态恒空闲）', () => {
    const on = onOf({});
    let calls = 0;
    const dispose = on('session/event', () => {
      calls += 1;
    });
    assert.equal(typeof dispose, 'function');
    dispose();
    assert.equal(calls, 0);
  });

  test('给了总线：session/event 转发过去，退订后不再收到', () => {
    const bus = createSessionEventBus();
    const on = onOf({ sessionEvents: bus });
    const seen: string[] = [];
    const dispose = on('session/event', (_session, event) => {
      seen.push(String((event as { type?: string }).type));
    });
    bus.emit({ id: 's1' }, { type: 'turn/start' });
    bus.emit({ id: 's1' }, { type: 'tool/call' });
    dispose();
    bus.emit({ id: 's1' }, { type: 'tool/result' });
    assert.deepEqual(seen, ['turn/start', 'tool/call']);
  });

  test('只接管 session/event：agent/error 之类在独立模式下仍是空订阅', () => {
    const bus = createSessionEventBus();
    const on = onOf({ sessionEvents: bus });
    let calls = 0;
    on('agent/error', () => {
      calls += 1;
    });
    bus.emit({ id: 's1' }, { type: 'agent/error' });
    assert.equal(calls, 0);
    assert.equal(bus.size(), 0, '不该有任何订阅者被挂上总线');
  });

  test('订阅者抛错被总线隔离，不会打断其余订阅者', () => {
    const errors: unknown[] = [];
    const bus = createSessionEventBus((error) => errors.push(error));
    const on = onOf({ sessionEvents: bus });
    const seen: string[] = [];
    on('session/event', () => {
      throw new Error('bad subscriber');
    });
    on('session/event', (_s, event) => seen.push(String((event as { type: string }).type)));
    bus.emit({ id: 's1' }, { type: 'turn/end' });
    assert.deepEqual(seen, ['turn/end']);
    assert.equal(errors.length, 1);
  });
});
