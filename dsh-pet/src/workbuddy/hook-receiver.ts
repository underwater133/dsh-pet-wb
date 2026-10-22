/**
 * hook 接收端：一个只认 `POST /wb/hook` 的本机 HTTP 处理函数。
 *
 * 它刻意做得极其保守——因为它的调用方是 WorkBuddy 的 hook 链，而 hook 在**每一次工具调用**上
 * 都会同步等它：一次任务实测 100+ 次。所以：
 *
 * - **绝不抛**：任何异常都吞掉并回一个结构化的失败（hook 脚本那边还会再兜一层）；
 * - **绝不慢**：正文上限 4 KiB、读完立刻返回，不做任何磁盘/网络 I/O（唯一的 I/O 是投给内存总线）；
 * - **绝不记账**：不把载荷写进任何文件、不打日志正文（载荷本身已经是投影过的结构，正文早在
 *   hook 脚本里就丢了，这里再当成"不可信输入"过一遍白名单）。
 *
 * 鉴权不在这里做：独立模式的 HTTP 边界（`src/standalone/request-security.ts`）已经要求
 * `x-dsh-pet-token`，非公开路由没有令牌一律 403。本文件只负责"内容"这一层。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { WorkBuddyFeed } from './feed';
import { MAX_HOOK_PAYLOAD_BYTES } from './mapper';

/** hook 投递路径（挂在服务根上，不在 `/dsh-pet-7340` 前缀下） */
export const WB_HOOK_PATH = '/wb/hook';

export interface HookReceiverOptions {
  /** 正文上限（字节）；投影后的载荷只有几十字节 */
  maxBytes?: number;
  /** 读正文的超时（毫秒） */
  timeoutMs?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * 读正文（带上限与超时）。
 * @returns 正文；超限/超时/读失败 → null
 */
async function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const read = (async (): Promise<string | null> => {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > maxBytes) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  try {
    // 谁先到用谁：超时那一刻就不再等正文（慢客户端不该拖住 hook 链）
    return await Promise.race([read, guard]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 建一个 hook 处理函数。
 * @param feed 事件喂料器（投影 + 翻译 + 分发）
 * @param options 正文上限与读超时
 */
export function createHookHandler(
  feed: WorkBuddyFeed,
  options: HookReceiverOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_HOOK_PAYLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? 1500;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, reason: 'hook 只接受 POST' });
        return;
      }
      const text = await readBody(req, maxBytes, timeoutMs);
      if (text === null) {
        sendJson(res, 413, { ok: false, reason: '载荷过大或读取超时' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendJson(res, 400, { ok: false, reason: '载荷不是合法 JSON' });
        return;
      }
      const accepted = feed.ingest(parsed);
      // 丢弃不是错误：通知/会话开始这类事件本来就不进状态机，回 200 让 hook 安心退出
      sendJson(res, 200, { ok: true, accepted });
    } catch {
      // 走到这里说明接收端自己有 bug：静默回 500，绝不把异常抛回 hook 链
      if (!res.headersSent && !res.destroyed) sendJson(res, 500, { ok: false, reason: '接收端内部错误' });
    }
  };
}
