/**
 * WorkBuddy 事件喂料器：hook 载荷 → 投影 → 翻译 → 事件总线，外加一条"跑飞看门狗"。
 *
 * 三个职责：
 * 1. **收**：把接收端递进来的原始 JSON 投影成结构载荷（白名单重建，见 mapper.ts）；
 * 2. **发**：翻译成 DSH 会话事件后分发到总线；
 * 3. **兜底**：WorkBuddy 的 hook 是"尽力而为"的——崩溃、强杀、hook 脚本超时都会让
 *    `Stop` 永远不来。没有兜底时，桌宠会永久卡在"这一步正在进行中哦"（这正是 DSH 侧
 *    当年修过的坑）。所以每条非终态事件都重挂一个计时器，到点没后续就把该会话
 *    当作 aborted 收掉，回空闲。
 *
 * 本模块不做 HTTP（见 ./hook-receiver），也不做状态聚合（在宿主半边的 WorkStatusStore）。
 */
import type { SessionEventBus } from './event-bus';
import { mapHookEvent, projectHookPayload } from './mapper';

/** 空闲多久没有新事件就认定这一轮跑飞了（毫秒） */
export const DEFAULT_IDLE_MS = 10 * 60_000;

/** 喂料器的运行时读数（挂在 `/health` 上，便于排查"宠物怎么不动了"） */
export interface WorkBuddyFeedStats {
  /** 成功收下的 hook 事件数 */
  events: number;
  /** 被丢弃的载荷数（投影失败 / 事件不关心） */
  dropped: number;
  /** 见过的会话数 */
  sessions: number;
  /** 最近一次成功收下的事件时间（毫秒）；从未收到为 null */
  lastEventAt: number | null;
}

export interface WorkBuddyFeedOptions {
  /** 看门狗时长；<= 0 关闭看门狗（测试用） */
  idleMs?: number;
  /** 时钟（测试注入） */
  now?: () => number;
  /** 丢弃/异常的原因回调（写日志用；不传则静默） */
  onDrop?: (reason: string) => void;
}

export interface WorkBuddyFeed {
  /**
   * 收一条原始 hook 载荷。
   * @returns true = 收下并已分发；false = 丢弃（原因经 `onDrop` 报出）
   */
  ingest(raw: unknown): boolean;
  stats(): WorkBuddyFeedStats;
  /** 清掉全部看门狗（进程退出时调用，避免定时器拖住事件循环） */
  dispose(): void;
}

/**
 * 建一个喂料器。
 * @param bus 事件总线（宿主半边已经订阅它）
 * @param options 看门狗时长、时钟与丢弃回调
 */
export function createWorkBuddyFeed(bus: SessionEventBus, options: WorkBuddyFeedOptions = {}): WorkBuddyFeed {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? ((): number => Date.now());
  const watchdog = new Map<string, ReturnType<typeof setTimeout>>();
  /** 见过的会话（与看门狗无关：idleMs = 0 关掉看门狗时也要能统计） */
  const seenSessions = new Set<string>();
  const stats: WorkBuddyFeedStats = { events: 0, dropped: 0, sessions: 0, lastEventAt: null };
  let disposed = false;

  const drop = (reason: string): false => {
    stats.dropped += 1;
    options.onDrop?.(reason);
    return false;
  };

  /** 撤掉某会话的看门狗（终态、错误、退出都会走这里） */
  const disarm = (sessionId: string): void => {
    const timer = watchdog.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    watchdog.delete(sessionId);
  };

  /**
   * 给某会话挂一个"到点收工"计时器。
   * 每次非终态事件都重挂（覆盖上一次），所以它衡量的是"这段时间内一点动静都没有"。
   */
  const arm = (sessionId: string): void => {
    if (!(idleMs > 0)) return;
    disarm(sessionId);
    const timer = setTimeout(() => {
      watchdog.delete(sessionId);
      if (disposed) return;
      // 当作 aborted 收掉：宿主的 turn/end 分支会清空该会话，回落到空闲
      bus.emit({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'aborted' } }, seq: now() });
      options.onDrop?.(`会话 ${sessionId} 静默超过 ${Math.round(idleMs / 1000)}s，已收工回空闲`);
    }, idleMs);
    // 不拖住事件循环：进程该退就退
    (timer as { unref?: () => void }).unref?.();
    watchdog.set(sessionId, timer);
  };

  return {
    ingest(raw: unknown): boolean {
      if (disposed) return false;
      const payload = projectHookPayload(raw);
      if (!payload) return drop('载荷投影失败（缺事件名或会话 id 非法）');
      const mapped = mapHookEvent(payload, now());
      if (!mapped) return drop(`事件 ${payload.event} 不影响工作状态`);
      stats.events += 1;
      stats.lastEventAt = now();
      seenSessions.add(mapped.session.id);
      stats.sessions = seenSessions.size;
      for (const event of mapped.events) bus.emit(mapped.session, event);
      // 终态（turn/end）由宿主自己清理条目，看门狗必须撤掉；其余状态重挂
      if (mapped.events.some((event) => event.type === 'turn/end')) disarm(mapped.session.id);
      else arm(mapped.session.id);
      return true;
    },
    stats(): WorkBuddyFeedStats {
      return { ...stats };
    },
    dispose(): void {
      disposed = true;
      for (const timer of watchdog.values()) clearTimeout(timer);
      watchdog.clear();
    },
  };
}
