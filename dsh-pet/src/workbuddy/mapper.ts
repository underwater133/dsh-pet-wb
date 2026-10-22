/**
 * WorkBuddy hook 载荷 → DSH 会话事件（纯函数，零 I/O，好单测）。
 *
 * 为什么要有这一层：宿主半边（`src/host/index.ts`）只认 DSH 的 `session/event` 形状，
 * 六档工作状态的全部聚合逻辑（多会话优先级仲裁、终态过期清理、任务详情文案跟随）
 * 都挂在 `reduceWorkStatus` 与 `WorkStatusStore` 上。与其给 WorkBuddy 另写一套状态机，
 * 不如把 hook 事件**翻译成 DSH 形状**——下游一行不用改，两套宿主也不会各自漂移。
 *
 * 档位对应（顺序与 `assets/config.jsonc` 的 `animations.events.workStatus` 严格一致）：
 *   UserPromptSubmit                    → turn/start          → 0 thinking
 *   PreToolUse                          → tool/call           → 1 working
 *   PostToolUse / PostToolUseFailure    → tool/result         → 2 result
 *   PermissionRequest / Elicitation     → approval/asked      → 3 waiting
 *   Notification(idle_prompt)           → approval/asked      → 3 waiting（干完一轮在等你）
 *   Stop                                → turn/end completed  → 4 success
 *   Stop（以问句结尾）                   → turn/end blocked    → 3 waiting（它在问你）
 *   Stop 之外的失败/会话结束             → turn/end aborted    → 清空回空闲
 *
 * **只做结构翻译**：本模块不认识任何正文（prompt / tool_input / 消息体），
 * 上游 hook 脚本已在最靠近宿主的位置把它们丢掉，这里再做一次白名单投影。
 */

/** WorkBuddy（CodeBuddy 同源）hook 事件的名称；只列本模块关心的那些 */
export type WorkBuddyHookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Elicitation'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionEnd';

/**
 * 投影后的 hook 载荷 —— **只有结构字段，没有正文**。
 *
 * 这既是 hook 脚本发给本机服务的 wire 契约，也是本模块的输入契约：
 * 任何多出来的键（prompt / tool_input / last_assistant_message …）都会被
 * `projectHookPayload` 丢掉，不会进入状态机、更不会落盘。
 */
export interface WorkBuddyHookPayload {
  /** 事件名（`hook_event_name`，兼容简写 `event`） */
  event: string;
  /** WorkBuddy 会话 id —— 多会话并行时用它做仲裁键（DSH 侧叫 session id） */
  sessionId: string;
  /** 工具名（仅 PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest） */
  toolName?: string;
  /** 通知类型（仅 Notification）：`idle_prompt` = agent 空闲在等你 */
  notificationType?: string;
  /** `Stop` 时由 hook 脚本本地判定：最后一句是否以问号结尾（正文不出来，只出布尔） */
  endsWithQuestion?: boolean;
  /** 事件时间戳（毫秒），缺失时由接收端补 */
  ts?: number;
}

/** 与 DSH `session/event` 对齐的事件形状（只声明宿主真正读到的字段） */
export interface HostSessionEvent {
  type: string;
  data?: Record<string, unknown>;
  seq?: number;
}

/** 与 DSH 会话对象对齐（宿主读 `session.header.id ?? session.id`） */
export interface HostSessionLike {
  id: string;
}

/** 一次 hook 翻译出的结果：会话 + 一个或多个事件 */
export interface MappedHook {
  session: HostSessionLike;
  events: HostSessionEvent[];
}

/** 载荷大小上限（字节）：投影后的载荷只有几十字节，超过这个量必然是不该收的东西 */
export const MAX_HOOK_PAYLOAD_BYTES = 4096;

/** 会话 id 允许的字符集：WorkBuddy 用 uuid v4，放宽到常见 id 形态但不接受分隔符/空白 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 工具名只保留可打印安全字符（用于日志与"是不是在问用户"的判定，不落正文） */
function safeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return undefined;
  return /^[A-Za-z0-9._:[\]-]+$/.test(trimmed) ? trimmed : undefined;
}

/**
 * 把任意输入投影成 `WorkBuddyHookPayload`：**白名单重建**，一个多余字段都不留。
 *
 * @param raw hook 脚本 POST 上来的 JSON（也可能是别人手动构造的，一律不信）
 * @returns 合法载荷；认不出（缺事件名 / 会话 id 非法 / 不是对象）→ null
 */
export function projectHookPayload(raw: unknown): WorkBuddyHookPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const event = String(source.event ?? source.hook_event_name ?? '').trim();
  if (!/^[A-Za-z]{3,40}$/.test(event)) return null;
  const sessionId = String(source.session_id ?? source.sessionId ?? '').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const notificationType =
    typeof source.notification_type === 'string' && /^[A-Za-z_]{1,60}$/.test(source.notification_type)
      ? source.notification_type
      : undefined;
  const ts = Number(source.ts);
  return {
    event,
    sessionId,
    toolName: safeToolName(source.tool_name ?? source.toolName),
    notificationType,
    endsWithQuestion: source.ends_with_question === true ? true : undefined,
    ts: Number.isFinite(ts) && ts > 0 ? ts : undefined,
  };
}

/**
 * `ask_user_question` 这类工具名在不同宿主里写法不同（DSH: `ask_user_question`，
 * WorkBuddy: `AskUserQuestion` / `askUserQuestion`）。统一成宿主认识的规范名，
 * 这样"模型在等用户选择题答复"能被识别成 waiting，而不是当成普通干活。
 */
function normalizeToolName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return /^ask[-_]?user[-_]?question$/i.test(name) ? 'ask_user_question' : name;
}

/**
 * 单个 hook 事件 → DSH 会话事件。
 *
 * 返回值语义：
 * - `null`：这个事件不影响工作状态（如 SessionStart、SubagentStop、非 idle 的通知）；
 * - `events` 为空数组的情形不存在：要么 null，要么至少一条。
 *
 * @param payload 已投影的载荷
 * @param seq 事件序号（宿主用于同档位内的"最近优先"仲裁；缺省用时间戳，天然单调）
 */
export function mapHookEvent(payload: WorkBuddyHookPayload, seq?: number): MappedHook | null {
  const session: HostSessionLike = { id: payload.sessionId };
  const stamp = seq ?? payload.ts;
  const emit = (type: string, data?: Record<string, unknown>): MappedHook => ({
    session,
    events: [stamp === undefined ? { type, data } : { type, data, seq: stamp }],
  });

  switch (payload.event) {
    case 'UserPromptSubmit':
      // 一轮开始：宿主据此清掉上一轮的任务文案，档位回 thinking
      return emit('turn/start', { source: { kind: 'user' } });

    case 'PreToolUse':
      return emit('tool/call', { name: normalizeToolName(payload.toolName) });

    case 'PostToolUse':
    case 'PostToolUseFailure':
      // 单次工具失败不直接判 error：agent 通常会换路重试，终局由 Stop 决定
      return emit('tool/result', { name: normalizeToolName(payload.toolName) });

    case 'PermissionRequest':
    case 'Elicitation':
      return emit('approval/asked', { name: normalizeToolName(payload.toolName) });

    case 'PermissionDenied':
      // 用户拒绝了权限请求：agent 会继续走别的路，回到 working 而不是停在 waiting
      return emit('tool/call', { name: normalizeToolName(payload.toolName) });

    case 'Notification':
      // idle_prompt = 干完一轮在等你；其余通知（auth_success 等）不进状态机
      return payload.notificationType === 'idle_prompt' ? emit('approval/asked', { kind: 'idle' }) : null;

    case 'Stop':
      // 以问句收尾 = 它在问你，等答复；否则本轮真的干完了
      return emit('turn/end', { reason: { kind: payload.endsWithQuestion === true ? 'blocked' : 'completed' } });

    case 'SessionEnd':
      // 会话结束（关窗/登出）：aborted → 宿主把该会话条目清掉，回空闲
      return emit('turn/end', { reason: { kind: 'aborted' } });

    default:
      // SessionStart / SubagentStop / 未知事件：不动档位
      return null;
  }
}
