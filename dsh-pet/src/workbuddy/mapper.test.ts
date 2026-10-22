/**
 * hook → 会话事件的翻译契约（provider 无关，纯函数）。
 *
 * 钉住三件事：
 *   ① 每一种 WorkBuddy hook 都落到**预期的那一档**（档位索引与 assets/config.jsonc 的
 *      animations.events.workStatus 严格一致，错位就会放错动画）；
 *   ② **隐私**：投影后的载荷里不允许出现 prompt / tool_input / 正文任何形态（逐字段断言，不靠"看起来"）；
 *   ③ 失败口径：认不出的载荷一律 null / false，绝不猜一个状态塞给宠物。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mapHookEvent, projectHookPayload, MAX_HOOK_PAYLOAD_BYTES } from './mapper.ts';

/** 造一份"WorkBuddy 真实会发"的完整载荷（正文故意放敏感串，用于验证它们不会漏出去） */
function payloadOf(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: 'b1f0c5f2-2d6a-4a3e-9f31-8a6f0b7c1d22',
    transcript_path: '/home/u/.workbuddy/projects/x/y.jsonl',
    cwd: '/home/u/code/demo',
    permission_mode: 'default',
    prompt: 'SECRET_PROMPT_不要外传',
    tool_input: { command: 'rm -rf /' },
    last_assistant_message: '要不要我继续？',
    ...extra,
  };
}

describe('projectHookPayload —— 白名单投影（隐私边界）', () => {
  test('正文类字段一个都留不下来', () => {
    const projected = projectHookPayload(payloadOf('Stop'));
    assert.ok(projected);
    const wire = JSON.stringify(projected);
    for (const secret of ['SECRET_PROMPT', 'rm -rf', 'transcript_path', 'last_assistant_message', '要不要我继续']) {
      assert.equal(wire.includes(secret), false, `投影结果不该包含 ${secret}`);
    }
  });

  test('结构字段保留：会话 id、工具名、通知类型、问句布尔', () => {
    const projected = projectHookPayload(
      payloadOf('PreToolUse', { tool_name: 'Bash', notification_type: 'idle_prompt' }),
    );
    assert.deepEqual(projected, {
      event: 'PreToolUse',
      sessionId: 'b1f0c5f2-2d6a-4a3e-9f31-8a6f0b7c1d22',
      toolName: 'Bash',
      notificationType: 'idle_prompt',
      endsWithQuestion: undefined,
      ts: undefined,
    });
  });

  test('非法输入一律拒绝（不是对象 / 缺事件名 / 会话 id 带分隔符）', () => {
    assert.equal(projectHookPayload(null), null);
    assert.equal(projectHookPayload('string'), null);
    assert.equal(projectHookPayload([]), null);
    assert.equal(projectHookPayload({ session_id: 'abc' }), null);
    assert.equal(projectHookPayload({ hook_event_name: 'Stop' }), null);
    assert.equal(projectHookPayload({ hook_event_name: 'Stop', session_id: '../etc/passwd' }), null);
    assert.equal(projectHookPayload({ hook_event_name: 'Stop', session_id: 'a'.repeat(200) }), null);
  });

  test('时间戳：合法数字留下，垃圾丢掉', () => {
    assert.equal(projectHookPayload(payloadOf('Stop', { ts: 1755000000000 }))?.ts, 1755000000000);
    assert.equal(projectHookPayload(payloadOf('Stop', { ts: 'now' }))?.ts, undefined);
    assert.equal(projectHookPayload(payloadOf('Stop', { ts: -1 }))?.ts, undefined);
  });

  test('载荷上限是给接收端用的常量，必须小于服务端的 1MiB 缓冲上限', () => {
    assert.ok(MAX_HOOK_PAYLOAD_BYTES > 0 && MAX_HOOK_PAYLOAD_BYTES < 1024 * 1024);
  });
});

describe('mapHookEvent —— 六档档位对应', () => {
  const session = { id: 'b1f0c5f2-2d6a-4a3e-9f31-8a6f0b7c1d22' };
  const map = (event: string, extra: Record<string, unknown> = {}) =>
    mapHookEvent(projectHookPayload(payloadOf(event, extra))!, 7);

  test('UserPromptSubmit → turn/start（0 思考）', () => {
    assert.deepEqual(map('UserPromptSubmit')?.events, [
      { type: 'turn/start', data: { source: { kind: 'user' } }, seq: 7 },
    ]);
  });

  test('PreToolUse → tool/call（1 工作）', () => {
    const mapped = map('PreToolUse', { tool_name: 'Bash' });
    assert.equal(mapped?.session.id, session.id);
    assert.deepEqual(mapped?.events, [{ type: 'tool/call', data: { name: 'Bash' }, seq: 7 }]);
  });

  test('PostToolUse / PostToolUseFailure → tool/result（2 整理）', () => {
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      assert.deepEqual(
        map(event, { tool_name: 'Edit' })?.events.map((e) => e.type),
        ['tool/result'],
        event,
      );
    }
  });

  test('PermissionRequest / Elicitation → approval/asked（3 等待）', () => {
    for (const event of ['PermissionRequest', 'Elicitation']) {
      assert.deepEqual(
        map(event)?.events.map((e) => e.type),
        ['approval/asked'],
        event,
      );
    }
  });

  test('Notification：idle_prompt → 等待；其它类型不进状态机', () => {
    assert.deepEqual(
      map('Notification', { notification_type: 'idle_prompt' })?.events.map((e) => e.type),
      ['approval/asked'],
    );
    assert.equal(map('Notification', { notification_type: 'auth_success' }), null);
  });

  test('Stop：普通收尾 → completed（4 成功）；以问句结尾 → blocked（3 等待）', () => {
    assert.deepEqual(map('Stop')?.events, [{ type: 'turn/end', data: { reason: { kind: 'completed' } }, seq: 7 }]);
    // 问句判定发生在 hook 脚本里（正文不出本机），线上只会送来这个布尔
    assert.deepEqual(map('Stop', { ends_with_question: true })?.events, [
      { type: 'turn/end', data: { reason: { kind: 'blocked' } }, seq: 7 },
    ]);
  });

  test('正文即便被硬塞进来也不参与判定：投影层不读 last_assistant_message', () => {
    // 只给正文、不给布尔 → 按"干完了"处理，绝不为了让文案更准去解析正文
    assert.deepEqual(map('Stop', { last_assistant_message: '要我继续吗？' })?.events, [
      { type: 'turn/end', data: { reason: { kind: 'completed' } }, seq: 7 },
    ]);
  });

  test('SessionEnd → aborted（清空该会话，回空闲）', () => {
    assert.deepEqual(map('SessionEnd')?.events, [{ type: 'turn/end', data: { reason: { kind: 'aborted' } }, seq: 7 }]);
  });

  test('SessionStart / SubagentStop / 未知事件 → 不动档位', () => {
    for (const event of ['SessionStart', 'SubagentStop', 'Whatever']) {
      assert.equal(map(event), null, event);
    }
  });

  test('工具名归一：AskUserQuestion → ask_user_question（宿主据此判 waiting）', () => {
    assert.deepEqual(map('PreToolUse', { tool_name: 'AskUserQuestion' })?.events[0]?.data, {
      name: 'ask_user_question',
    });
    assert.deepEqual(map('PreToolUse', { tool_name: 'askUserQuestion' })?.events[0]?.data, {
      name: 'ask_user_question',
    });
  });

  test('缺 seq → 用载荷时间戳兜底（同档位内仍能比"谁更新"）', () => {
    const mapped = mapHookEvent(projectHookPayload(payloadOf('PreToolUse', { ts: 1234 }))!);
    assert.equal(mapped?.events[0]?.seq, 1234);
  });
});
