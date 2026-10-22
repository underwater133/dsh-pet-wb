#!/usr/bin/env node
/**
 * 把桌宠挂到 WorkBuddy 的 hooks 上（写 `~/.workbuddy/settings.json`）。
 *
 * 做三件事，每一件都可逆：
 *   1. 备份：先把原文件复制成 `settings.json.dsh-pet-backup-<时间戳>`（不覆盖任何已有备份）；
 *   2. 幂等安装：先摘掉本脚本以前写进去的条目（按命令里是否含 `workbuddy-hook.mjs` 认），
 *      再按事件表重新写一遍 —— 所以重复执行不会翻倍，改过事件表重跑一次就同步了；
 *   3. 只动 `hooks` 一个键：文件里其它内容原样保留（键序、缩进风格可能被 JSON 重排，
 *      但值不变；介意的话用 `--print` 先看一眼）。
 *
 * 用法：
 *   node scripts/install-workbuddy-hooks.mjs            # 安装 / 更新
 *   node scripts/install-workbuddy-hooks.mjs --uninstall # 只摘掉桌宠的条目
 *   node scripts/install-workbuddy-hooks.mjs --print     # 只打印将写入的 JSON，不落盘
 *   node scripts/install-workbuddy-hooks.mjs --settings <path>  # 指定 settings.json
 *
 * ⚠ 装完必须**完全退出** WorkBuddy 再启动：hook 配置是启动时读取并缓存的，点关闭按钮
 *   只是关窗口（它有常驻能力），热改无效。部分版本还会要求先在 /hooks 面板里审核
 *   外部改动才会生效。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 认领标记：命令里含它就算"桌宠写的"，重装/卸载只动这些 */
const MARKER = 'workbuddy-hook.mjs';

/** 本脚本同目录的 hook 投递脚本（绝对路径写进 settings，避免依赖 cwd） */
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), MARKER);

/**
 * 安装哪些事件 —— 只装**已被实测证实会触发**的那几个（少即是稳）：
 * 多写一个引擎不认识的事件名，风险是整份 hooks 配置被拒（症状是"什么都不触发"，极难排查）；
 * 而少写的那些，语义上都能被下面这套覆盖：
 *   - PermissionDenied：用户拒了权限后 agent 会立刻调下一个工具 → PreToolUse 覆盖
 *   - PostToolUseFailure：单次工具失败不改变档位，终局由 Stop 覆盖
 *   - Elicitation / SubagentStop / PreCompact：不影响"在思考/在干活/在等你/干完了"这四态
 */
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];

/** 不需要 matcher 的生命周期事件 */
const PLAIN_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];

/** hook 脚本的调用命令：用当前 node 的绝对路径（hook 链里 PATH 不可知） */
function hookCommand() {
  const node = process.execPath.replace(/\\/g, '/');
  const script = HOOK_SCRIPT.replace(/\\/g, '/');
  return `"${node}" "${script}"`;
}

function defaultSettingsPath() {
  const home = process.env.WORKBUDDY_HOME?.trim() || join(homedir(), '.workbuddy');
  return join(home, 'settings.json');
}

function parseArgs(argv) {
  const options = { uninstall: false, print: false, settings: defaultSettingsPath() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--print') options.print = true;
    else if (arg === '--settings') options.settings = String(argv[++i] ?? '');
    else if (arg.startsWith('--settings=')) options.settings = arg.slice('--settings='.length);
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 这条 hook 是不是桌宠写的 */
function isOurs(hook) {
  return Boolean(hook && typeof hook.command === 'string' && hook.command.includes(MARKER));
}

/** 摘掉全部桌宠条目（幂等），顺带清掉因此变空的数组，让用户的 settings 保持干净 */
function stripOurs(hooks) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) {
        kept.push(entry);
        continue;
      }
      const survivors = entry.hooks.filter((hook) => !isOurs(hook));
      removed += entry.hooks.length - survivors.length;
      if (survivors.length > 0) kept.push({ ...entry, hooks: survivors });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return removed;
}

/** 按事件表写入桌宠条目 */
function installOurs(hooks) {
  const command = hookCommand();
  let added = 0;
  for (const event of TOOL_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
    list.push({ matcher: '.*', hooks: [{ type: 'command', command, timeout: 5 }] });
    added += 1;
  }
  for (const event of PLAIN_EVENTS) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = []);
    list.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    added += 1;
  }
  return added;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('*/')[0]
        .replace(/^#![^\n]*\n/, ''),
    );
    return 0;
  }
  if (!existsSync(HOOK_SCRIPT)) {
    console.error(`找不到 hook 脚本：${HOOK_SCRIPT}`);
    return 1;
  }

  let settings = {};
  if (existsSync(options.settings)) {
    let text;
    try {
      text = readFileSync(options.settings, 'utf8');
      settings = JSON.parse(text);
    } catch {
      console.error(`无法解析 ${options.settings}：它必须是合法 JSON（带注释的版本请先去掉注释）`);
      return 1;
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      console.error(`${options.settings} 的顶层不是对象，放弃写入`);
      return 1;
    }
  } else if (!options.print) {
    console.error(`找不到 ${options.settings}：WorkBuddy 至少需要启动过一次`);
    return 1;
  }

  const hooks =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const removed = stripOurs(hooks);
  const added = options.uninstall ? 0 : installOurs(hooks);
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;

  const output = `${JSON.stringify(settings, null, 2)}\n`;

  if (options.print) {
    console.log(output);
    return 0;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backup = `${options.settings}.dsh-pet-backup-${stamp}`;
  copyFileSync(options.settings, backup);
  writeFileSync(options.settings, output, 'utf8');

  console.log('');
  console.log(options.uninstall ? '已卸载桌宠 hooks。' : '已安装桌宠 hooks。');
  console.log(`  配置文件    ${options.settings}`);
  console.log(`  备份        ${backup}`);
  console.log(`  摘掉旧条目  ${removed} 条`);
  if (!options.uninstall) {
    console.log(` 写入新条目  ${added} 条（${[...TOOL_EVENTS, ...PLAIN_EVENTS].length} 个事件）`);
    console.log(`  hook 命令  ${hookCommand()}`);
  }
  console.log('');
  console.log('下一步：');
  console.log('  1. 完全退出 WorkBuddy 再启动（关窗口不算退出；hook 配置是启动时缓存的）');
  console.log('     部分版本还需要先在 /hooks 面板里审核一次外部改动才会生效');
  console.log('  2. 起桌宠：node lib/standalone.js --host workbuddy');
  console.log('  3. 在 WorkBuddy 里打开一个工作目录随便发一句，桌宠应该立刻有反应');
  console.log('');
  console.log(`回滚：把 ${backup} 覆盖回 ${options.settings}，或加 --uninstall 重跑一次`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
