#!/usr/bin/env node
/**
 * WorkBuddy hook 薄脚本 —— 挂在 WorkBuddy 的 hooks 上，把"发生了什么"投给本机桌宠。
 *
 * 设计约束（每一条都有原因）：
 * 1. **隐私投影在最上游**：prompt / tool_input / tool_result / last_assistant_message 全部
 *    在这里就地丢弃，只留结构字段（事件名、会话 id、工具名、通知类型、以及"最后一句是不是问句"
 *    这个布尔）。桌宠不需要你的对话内容，也就不该有拿到它的能力。落盘的正文一个字都不留。
 * 2. **fail-open**：桌宠没开、端口没写、超时、任何异常 —— 静默退出码 0。一个状态指示灯
 *    永远不该卡住你正经的工作流（hook 是同步等的）。
 * 3. **绝不写 stdout**：hook 的 stdout 会被 WorkBuddy 当 JSON 决策解析，多打一个字都可能出事。
 * 4. **够快**：一次任务实测 100+ 次 PreToolUse。这里只做"读一个小文件 + 一次 250ms 上限的
 *    POST"，其余一概不做（不查库、不扫目录、不起子进程）。
 *
 * 用法（由 scripts/install-workbuddy-hooks.mjs 写进 ~/.workbuddy/settings.json）：
 *   node workbuddy-hook.mjs
 * 事件名取自 stdin 的 hook_event_name，或 argv[2]（settings 里显式带上更直观）。
 *
 * ⚠ 本脚本必须保持零依赖：它跑在 WorkBuddy 的 hook 链里，工作目录、NODE_PATH 都不可知。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

/** 请求上限：hook 链上绝不允许超过这个时间 */
const TIMEOUT_MS = 250;

/** 载荷上限（防止畸形 stdin 把自己撑爆） */
const MAX_STDIN_BYTES = 1024 * 1024;

/** 退出：永远 0，永远不输出 */
function leave() {
  process.exitCode = 0;
}

/** DSH_HOME（与桌宠自己的口径一致：环境变量优先，否则 ~/.dsh） */
function dshHome() {
  const override = process.env.DSH_HOME;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), '.dsh');
}

/** 读桌宠运行时清单：里面有真实端口与访问令牌（服务端口可能顺延，不能写死 3080） */
function readRuntime() {
  const file = process.env.DSH_PET_WB_RUNTIME || join(dshHome(), 'dsh-pet', 'standalone-runtime.json');
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  const port = Number(parsed?.port);
  const token = typeof parsed?.token === 'string' ? parsed.token : '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('runtime: bad port');
  return { port, token };
}

/** 最后一句是不是问句（问号结尾，允许尾部有引号/括号/空白）：决定"它在等你"还是"它干完了" */
function endsWithQuestion(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return /[?？]["'”’)）\]】]*\s*$/.test(trimmed);
}

/**
 * 投影：白名单重建。
 * @param {Record<string, unknown>} payload WorkBuddy 给的完整 hook 载荷（含正文）
 * @returns 只含结构字段的对象 —— 正文在这一步被彻底丢弃
 */
function project(payload) {
  const event = String(payload?.hook_event_name ?? process.argv[2] ?? '').trim();
  if (!/^[A-Za-z]{3,40}$/.test(event)) return null;
  const sessionId = String(payload?.session_id ?? '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) return null;
  const out = { event, session_id: sessionId, ts: Date.now() };
  if (typeof payload?.tool_name === 'string' && /^[A-Za-z0-9._:[\]-]{1,120}$/.test(payload.tool_name)) {
    out.tool_name = payload.tool_name;
  }
  if (typeof payload?.notification_type === 'string' && /^[A-Za-z_]{1,60}$/.test(payload.notification_type)) {
    out.notification_type = payload.notification_type;
  }
  // 只有 Stop 才需要这个布尔；其余事件连算都不算
  if (event === 'Stop' && endsWithQuestion(payload?.last_assistant_message)) out.ends_with_question = true;
  return out;
}

/** 投递；任何失败都静默（fail-open） */
function deliver(body) {
  let target;
  try {
    target = readRuntime();
  } catch {
    return; // 桌宠没在跑，或运行清单还没写出来
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  /** 计时器必须显式清掉：一个挂着的 setTimeout 会让进程多活 250ms，hook 就真的慢了 */
  let timer = null;
  const finish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    leave();
  };
  const req = request(
    {
      host: '127.0.0.1',
      port: target.port,
      path: '/wb/hook',
      method: 'POST',
      agent: false, // 不复用连接：每次一个短连接，结束即释放，进程才能立刻退出
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        connection: 'close',
        ...(target.token ? { 'x-dsh-pet-token': target.token } : {}),
      },
    },
    (res) => {
      res.resume(); // 丢掉响应体：不解析、不打印
      res.on('end', finish);
      res.on('error', finish);
      finish();
    },
  );
  req.on('error', finish);
  timer = setTimeout(() => {
    timer = null;
    req.destroy();
    leave();
  }, TIMEOUT_MS);
  req.end(payload);
}

/** 主流程：读 stdin → 投影 → 投递。全程同步读，出错就走人 */
function main() {
  let text = '';
  try {
    text = readFileSync(0, 'utf8'); // fd 0 = stdin（WorkBuddy 用管道投递 JSON）
    if (text.length > MAX_STDIN_BYTES) return;
  } catch {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  const projected = project(payload);
  if (!projected) return;
  deliver(projected);
}

try {
  main();
} catch {
  leave();
}
