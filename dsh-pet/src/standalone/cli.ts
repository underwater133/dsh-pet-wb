#!/usr/bin/env node
/**
 * dsh-pet 独立模式入口 —— 不打开 DSH 也能养桌宠。
 *
 * 它把三件事串起来（每一步都复用插件自己的实现，没有第二份业务逻辑）：
 *   1. `./context` 造一个伪 Cordis ctx，把插件的宿主半边（`src/host/index.ts` 的 `apply`）跑起来；
 *   2. `./server` 起一个真正的 `node:http` 服务，把 `apply` 注册的 prefix handler 接上去
 *      （路由表仍然只有插件那一份）；
 *   3. 插件自己的 `launchHelper` 因此照常探测 Electron、按配置拉起透明置顶小窗，
 *      并与宿主经 bridge 管道通信 —— 与 DSH 内运行完全同一条路径。
 *
 * 用法：
 *   npx dsh-pet-standalone              # 插件装好后直接跑（package.json 的 bin）
 *   npm run standalone                  # 仓库里跑（先安装依赖并 npm run build）
 *   node lib/standalone.js --port 3081
 *   node lib/standalone.js --check      # 只体检，不开窗口
 *
 * 独立模式的边界：动画、物理拖拽、右键菜单、多开、自定义素材与宠物种类全部可用；
 * 余额、碎碎念、对话、系统通知依赖 DSH 的凭证/模型/会话，在独立模式下明确不可用
 * （结构化失败 + 日志，不假装成功）。详见 README 的「独立运行（不打开 DSH）」一节。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
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

/**
 * 桌面窗口的前置产物是否齐备。
 *
 * `runtime/electron-helper/shared-core.js` 是 `npm run build:desktop-core` 的**构建产物**
 * （`src/shared` → 全局 `window.PetShared`，不进 git）。从源码直接跑时，如果只做了 `npm run bundle`
 * （只出 `lib/`），`index.html` 里那个 `<script src="./shared-core.js">` 会 404 —— 渲染端随后抛
 * `ReferenceError: BASE is not defined`，表现是**托盘图标在、窗口也在，但屏幕上一个像素都没有**
 * （窗口停在初始 0,0 且从不上报 bounds）。这种静默失败极难自查，所以在启动时就说清楚。
 *
 * 发布版不会命中：`files` 收的整个 `runtime/electron-helper` 目录里已经包含构建好的产物。
 */
function missingDesktopCore(): boolean {
  return !existsSync(join(packageRoot, 'runtime', 'electron-helper', 'shared-core.js'));
}

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger: StandaloneLogger, options: { port: number; host: HostKind }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);

  // 预检：包内默认配置读不到时宿主半边必然每请求失败；早给可操作的诊断，别让用户对着空桌面猜
  if (!existsSync(paths.defaultFile)) {
    logger.error(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
    process.exitCode = 1;
    return;
  }

  const routes: RegisteredRoute[] = [];
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
  });
  // hook 投递口挂在服务根上（不在 /dsh-pet-7340 前缀下）：受同一条令牌规则保护，
  // 且必须在 listen 之前进数组 —— 分发是按当前数组实时匹配的，但提前注册更不容易漏。
  if (feed) routes.push({ kind: 'exact', path: WB_HOOK_PATH, handler: createHookHandler(feed) });
  // /shutdown 的回调要在服务构造时给出去，而停机函数要在服务之后定义：
  // 用一个可替换的转发器解耦（服务构造时只拿到"将来会是谁"）。
  let forwardShutdown: () => void = () => {};
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
    onShutdown: () => forwardShutdown(),
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
    // 先停外部事件源（看门狗定时器），再释放插件注册的 effect（停桌面 Helper、清周期定时器），最后关服务
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
  forwardShutdown = () => requestShutdown('POST /shutdown');
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // 起插件宿主半边：路由表、状态仓、桌面 Helper（含 bridge 管道）都在这一句里
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
  // 白屏预检：窗口会起、托盘图标也在，但渲染端少了共享核心就是一个像素都不画（见 missingDesktopCore）
  if (desktopVisible.length > 0 && missingDesktopCore()) {
    logger.error(
      '桌面窗口的共享核心缺失：runtime/electron-helper/shared-core.js —— 渲染端会白屏（托盘图标在、宠物不出现）。',
    );
    logger.error('修：在本目录执行 npm run build:desktop-core（或完整 npm run build），然后 POST /dsh-pet-7340/reload');
  }
  for (const line of [
    '',
    isWorkBuddy
      ? '===== dsh-pet x WorkBuddy（桌宠跟随 WorkBuddy 的工作状态）====='
      : '===== dsh-pet 独立模式（不需要 DSH）=====',
    `  插件        dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
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
    '  退出        Ctrl+C，或 POST /shutdown',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }
}

/** CLI 入口 */
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
  const logger = createStandaloneLogger();
  if (options.check) return runCheck(logger);
  await run(logger, options);
  return 0;
}

// 本文件就是可执行入口（package.json 的 bin 指向构建产物 lib/standalone.js），
// 因此无条件启动：不做 import.meta.main / argv[1] 比较之类的守卫 ——
// import.meta.main 要 Node 24+，而 argv[1] 比较在 pnpm 的 bin 符号链接下会判错。
main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`dsh-pet-standalone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
