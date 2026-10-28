import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { settingsPage, settingsStyle } from './settings-page.ts';
import { petsViewHtml, petsViewStyle } from './pets-view.ts';

/** 读源码文本：守卫「上游加了新 token / 新字段」这类漂移时，源码本身才是唯一事实。 */
const source = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');

test('桌宠配置是独立路由，AI 设置页只留一个入口链接', () => {
  assert.match(settingsPage, /id="pets-link"/);
  assert.match(settingsPage, /href="\/standalone-ai\/pets"/);
  // 上一版那套手写表单已经删掉：AI 页不许再出现桌宠外观的字段 id
  assert.doesNotMatch(settingsPage, /pets-list|cfg-physics|cfg-gravity|cfg-fontFamily/);
  assert.match(settingsStyle, /\.pets-link/);
});

test('配置页骨架自带挂载点与产物引用，且不内联脚本/样式', () => {
  assert.match(petsViewHtml, /id="pets-root"/);
  assert.match(petsViewHtml, /\/standalone-ai\/pets\.js/);
  assert.match(petsViewHtml, /\/standalone-ai\/pets\.css/);
  assert.match(petsViewHtml, /id="back-link"/);
  assert.doesNotMatch(petsViewHtml, /<style|<script>/);
  assert.doesNotMatch(petsViewHtml, /https?:\/\//);
});

test('主题变量映射覆盖设置组件用到的全部 --dsw-* token', () => {
  // 复用组件的代价就是这套映射：上游新增一个 token 时，这条断言先红，而不是等页面变白。
  const used = new Set(source('../client/settings.ts').match(/--dsw-[a-z0-9-]+/g) ?? []);
  assert.ok(used.size >= 15, '组件里的 token 数量异常：' + used.size);
  const missing = [...used].filter((name) => !petsViewStyle.includes(name));
  assert.deepEqual(missing, [], '样式表缺少这些 token 的映射：' + missing.join(', '));
});

test('挂载器不与 DSH 模块系统耦合，只补令牌与字典', () => {
  const client = source('./settings-client.ts');
  // 复用的是同一个组件，不是复制品：必须从 client/settings 取值
  assert.match(client, /from '\.\.\/client\/settings'/);
  assert.match(client, /makePetConfigSection/);
  // 独立页没有 __ModuleLoader__，不能走 client/index 那套外壳
  assert.doesNotMatch(client, /__ModuleLoader__/);
  // 令牌只从地址片段取，不进任何持久化
  assert.match(client, /location\.hash/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|document\.cookie/);
  // 只给插件接口补头，别的请求原样放行
  assert.match(client, /\/dsh-pet-7340\//);
  assert.match(client, /X-DSH-Pet-Token/);
  // 「添加宠物」读 petBridge.template 当模板：不喂模板就点不出新宠物（曾经的 bug）
  assert.match(client, /flattenConfigPets/);
  assert.match(client, /petBridge\.template\s*=/);
});

test('配置页的 CSP 只对 /standalone-ai/pets* 放开内联样式', () => {
  const server = source('./server.ts');
  // React 的内联 style 与运行时 <style> 需要它；但也只在这一条路由上
  assert.match(server, /pathname\.startsWith\('\/standalone-ai\/pets'\)/);
  assert.match(server, /style-src 'self'\$\{stylePolicy\}/);
});

test('静态资源白名单包含配置页的三个路径', () => {
  const security = source('./request-security.ts');
  for (const path of ['/standalone-ai/pets', '/standalone-ai/pets.js', '/standalone-ai/pets.css']) {
    assert.ok(security.includes("'" + path + "'"), '白名单缺少 ' + path);
  }
});
