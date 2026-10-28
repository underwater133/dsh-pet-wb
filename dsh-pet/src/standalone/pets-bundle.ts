/**
 * 桌宠配置页的浏览器产物：从磁盘读 `lib/settings-client.js`（tsdown 的第 4 个入口）。
 *
 * 为什么不把 React 打包进 Node 侧的 bundle：那份产物由 DSH 与独立模式共用，塞入 react-dom
 * 会让宿主侧的图表凭空多出几百 KB；而这一份只在本机页面上跑，按需读一次即可。
 * 必须始终成立：文件缺失时显式回 503 并给出可操作提示，绝不返回空白脚本。
 * @module dsh-pet/src/standalone/pets-bundle
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 产物文件名（与 tsdown 的 entry 同名，同为 ESM 产物目录的兄弟）。 */
export const PETS_BUNDLE_FILE = 'settings-client.js';

/** 读到的产物内容；成功后缓存，失败不缓存（换机器/重新构建后能自愈）。 */
let cached = '';

/**
 * 取浏览器产物正文。
 * @returns 产物源码；读不到返回 null（调用方回 503）。
 */
export function petsBundle(): string | null {
  if (cached) return cached;
  try {
    cached = readFileSync(join(dirname(fileURLToPath(import.meta.url)), PETS_BUNDLE_FILE), 'utf8');
  } catch {
    return null;
  }
  return cached || null;
}
