/**
 * 极小的会话事件总线 —— 把"外部宿主事件"喂给宿主半边的 `ctx.on('session/event')`。
 *
 * 为什么不直接用 `node:events`：宿主只用到"订阅 + 分发 + 订阅者抛错不影响别人"这三件事，
 * 而 `EventEmitter` 的 `maxListeners`、`'error'` 特殊语义、`once` 等都只会增加心智负担。
 * 这里 20 行足矣，且订阅顺序稳定、分发时快照订阅者（分发途中退订不跳人）。
 */

/** 与 Cordis `ctx.on(name, handler)` 的 handler 签名对齐（宿主把两个参数都当 `any` 用） */
export type SessionEventListener = (session: unknown, event: unknown) => void;

export interface SessionEventBus {
  /** 订阅；返回退订函数（幂等） */
  on(listener: SessionEventListener): () => void;
  /** 分发给全部订阅者：单个订阅者抛错只记录，不影响其余订阅者 */
  emit(session: unknown, event: unknown): void;
  /** 当前订阅者数量（测试与日志用） */
  size(): number;
}

/**
 * 建一个事件总线。
 * @param onError 订阅者抛错时的回调（缺省静默丢弃——事件链路永远不该把宿主进程带崩）
 */
export function createSessionEventBus(onError?: (error: unknown) => void): SessionEventBus {
  const listeners = new Set<SessionEventListener>();
  return {
    on(listener: SessionEventListener): () => void {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
    emit(session: unknown, event: unknown): void {
      // 快照：分发途中有人退订/新订，不影响本次这一轮
      for (const listener of [...listeners]) {
        try {
          listener(session, event);
        } catch (error) {
          onError?.(error);
        }
      }
    },
    size(): number {
      return listeners.size;
    },
  };
}
