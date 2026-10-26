#!/usr/bin/env node
/**
 * 独立模式入口：不启动 DSH，直接在本机运行桌宠。
 *
 * 负责把伪 ctx、本机 HTTP 服务与桌面 Helper 串成一条启动路径，并处理收尾与退出码。
 * 不实现路由、配置读取或窗口逻辑，这些都复用插件与宿主半侧的实现。
 * 必须始终成立：服务先监听再 apply，所有退出入口共用同一套收尾流程。
 * @module dsh-pet/src/standalone/cli
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { defaultLog, setDefaultLogger } from '../host/log-file';
import { runCheck, packageVersion } from './check';
import { createStandaloneAi } from './ai-provider';
import { createRequestSecurity } from './request-security';
import { writeStandaloneRuntime } from './runtime-state';
import { createSessionEventBus } from '../workbuddy/event-bus';
import { createWorkBuddyFeed, DEFAULT_IDLE_MS } from '../workbuddy/feed';
import { createHookHandler, WB_HOOK_PATH } from '../workbuddy/hook-receiver';
import {
  createStandaloneContext,
  createStandaloneLogger,
  type RegisteredRoute,
  type StandaloneLogger,
} from './context';
import { configPathsFor, describePets, isDesktopVisible, parseArgs, USAGE, type HostKind } from './options';
import { listenStandaloneServer } from './server';

/** 看门狗时长：`DSH_PET_WB_IDLE_MS` 覆盖（0 = 关闭），缺省 10 分钟 */
function idleMsFromEnv(): number {
  const raw = Number(process.env.DSH_PET_WB_IDLE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_IDLE_MS;
}

/** 启动独立模式：先起服务拿到端口，再 apply（插件据此拼桌面 Helper 的 configUrl）。 */
async function run(logger: StandaloneLogger, options: { port: number; host: HostKind }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);

  // 包内默认配置缺失时宿主半侧每个请求都会失败，先给可操作的诊断。
  if (!existsSync(paths.defaultFile)) {
    logger.error(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
    process.exitCode = 1;
    return;
  }

  const routes: RegisteredRoute[] = [];
  // /shutdown 的回调要在建服务时交出，而收尾函数要在服务之后定义：
  // 用可替换的转发器解耦，让服务构造时只拿到「将来会是谁」。
  let forwardShutdown: (reason: string) => void = () => {};
  const portRef = { value: options.port };
  const ai = createStandaloneAi(home, logger);
  const security = createRequestSecurity();

  // WorkBuddy 宿主：hook → 事件总线 → 插件原有的工作状态聚合（WorkStatusStore）。
  // 插件的宿主半边通过 `ctx.on('session/event')` 拿事件，这里把伪 ctx 的那条"永不触发"
  // 的订阅换成真实总线，因此 host/ 下一个字都不用改。
  const isWorkBuddy = options.host === 'workbuddy';
  const sessionEvents = isWorkBuddy
    ? createSessionEventBus((error: unknown) => {
        logger.warn(`工作状态订阅者抛错（已隔离）：${error instanceof Error ? error.message : String(error)}`);
      })
    : undefined;
  const feed = sessionEvents
    ? createWorkBuddyFeed(sessionEvents, {
        idleMs: idleMsFromEnv(),
        onDrop: (reason: string) => logger.debug(`hook 事件未采用：${reason}`),
      })
    : undefined;

  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    ai,
    sessionEvents,
    authenticatedUrl: security.authenticatedUrl,
    // 托盘退出与 POST /shutdown 走同一条收尾路径。
    shutdown: (reason) => forwardShutdown(reason),
  });
  // hook 投递口挂在服务根上（不在 /dsh-pet-7340 前缀下）：受同一条令牌规则保护，
  // 且必须在 listen 之前进数组 —— 分发是按当前数组实时匹配的，但提前注册更不容易漏。
  if (feed) routes.push({ kind: 'exact', path: WB_HOOK_PATH, handler: createHookHandler(feed) });
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: options.port,
    security,
    ai,
    status: () => ({
      name: 'dsh-pet-standalone',
      pid: process.pid,
      pluginRoot: packageRoot,
      plugin: { root: packageRoot, version: packageVersion(packageRoot) },
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
      // 只有计数，没有任何载荷内容：用来回答"宠物怎么不动了"
      ...(feed ? { workbuddy: feed.stats() } : {}),
    }),
    onShutdown: () => forwardShutdown('POST /shutdown'),
  });
  portRef.value = server.port;
  let releaseRuntime: () => void;
  try {
    releaseRuntime = writeStandaloneRuntime(home, {
      port: server.port,
      token: security.token,
      settingsUrl: security.authenticatedUrl(`http://127.0.0.1:${server.port}`),
      pluginRoot: packageRoot,
    });
  } catch (error) {
    await context.dispose();
    await server.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收尾（${reason}）…`);
    // 先停外部事件源（WorkBuddy 看门狗），再释放插件注册的 effect（停 Helper、清周期定时器），最后关服务。
    try {
      feed?.dispose();
      await context.dispose();
    } finally {
      await server.close();
      releaseRuntime();
    }
    logger.info('已退出。');
  };
  const requestShutdown = (reason: string): void => {
    shutdown(reason)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  forwardShutdown = (reason) => requestShutdown(reason);
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // 这一句里注册路由表、状态仓与桌面 Helper（含 bridge 管道）。
  apply(context.ctx);

  let pets: Record<string, unknown>[] = [];
  let configSource = paths.userFile;
  try {
    pets = flattenPetList(readAllConfig(paths));
    if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
  } catch (error) {
    logger.warn(
      `读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const desktopVisible = pets.filter(isDesktopVisible);
  for (const line of [
    '',
    isWorkBuddy
      ? '===== dsh-pet x WorkBuddy（桌宠跟随 WorkBuddy 的工作状态）====='
      : '===== dsh-pet 独立模式（不需要 DSH）=====',
    `  插件        dsh-pet-wb@${packageVersion(packageRoot)}  ${packageRoot}`,
    `  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
    `  配置        ${configSource}`,
    `  宠物        ${describePets(pets)}`,
    desktopVisible.length === 0
      ? '  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）'
      : `  桌面小窗    ${desktopVisible.length} 只`,
    ai.isReady()
      ? '  AI          本机 API 已启用；自动碎碎念遵循设置页开关'
      : '  AI          未配置或未启用，不发送模型请求；右键“打开 AI 设置”后在本机填写',
    ...(isWorkBuddy
      ? [
          `  hook 入口   POST http://127.0.0.1:${server.port}${WB_HOOK_PATH}（需 x-dsh-pet-token，令牌见运行时文件）`,
          `  工作状态    ${feed?.stats().events ?? 0} 条事件 / ${feed?.stats().sessions ?? 0} 个会话（来自 WorkBuddy hooks）`,
          '  余额        不可用（WorkBuddy 没有公开的余额接口，宿主侧口径保持 unsupported）',
          '  装 hooks    node scripts/install-workbuddy-hooks.mjs（装完完全退出 WorkBuddy 再启动）',
        ]
      : ['  不可用      余额 / 会话工作状态 / DSH 系统通知']),
    '  退出        Ctrl+C、POST /shutdown，或桌面托盘菜单的「退出」',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }
}

/** CLI 入口，返回进程退出码。 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`dsh-pet-standalone: ${parsed.error}\n`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  // 独立模式常常没有终端，日志必须同时落盘；插件会复用同一个 logger。
  const logger = createStandaloneLogger({ file: join(dshHomeDir(), 'dsh-pet', 'logs.txt') });
  // 纯模块没有 ctx.logger，靠默认出口落盘。
  setDefaultLogger(logger);
  if (options.check) return runCheck(logger);
  await run(logger, options);
  return 0;
}

// 本文件就是 bin 指向的可执行入口，因此无条件启动；
// import.meta.main 需要 Node 24+，而 argv[1] 比较在 pnpm 的 bin 符号链接下会判错。
main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    defaultLog(
      'error',
      `dsh-pet-standalone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
