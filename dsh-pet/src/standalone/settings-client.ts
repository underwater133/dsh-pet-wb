/**
 * 独立模式的「桌宠配置」页面：把 DSH 里的同一个 React 设置组件挂到本机页面上。
 *
 * 直接 import `client/settings` 的 `makePetConfigSection`，不重写任何字段：
 * 上游改了大小 / 位置 / 物理 / 字体 / 模型卡片，这里自动跟着变。
 * 不负责页面外观与 HTTP 边界（由 ./pets-view 与 ./server 负责），也不实现配置读写——
 * 组件自己 fetch `/dsh-pet-7340/*`，本文件只做三件它不知道的事：
 *  1. 给同源请求补 `X-DSH-Pet-Token`（DSH 里同源即授权，独立模式要令牌）；
 *  2. 用本地字典提供 `t`（DSH 的 locale 服务在这里不存在）；
 *  3. 把 `petBridge.reload` 接到「重挂一次」上（DSH 里它是让 overlay 容器重渲染）。
 * 必须始终成立：没有令牌时只显示提示、不发任何请求；组件抛错不吞掉控制台信息。
 * @module dsh-pet/src/standalone/settings-client
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { jsx } from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';

import { makePetConfigSection, petBridge, zh } from '../client/settings';
import { flattenConfigPets } from '../shared/config';

/** 令牌：只从地址片段取一次，取完立刻清掉（不进 history、不进 Referer）。 */
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
history.replaceState(null, '', location.pathname);

/** 回 AI 设置页的链接也要带令牌，否则返回后那一页读写会 403。 */
const back = document.getElementById('back-link');
if (back && token) back.setAttribute('href', '/standalone-ai/#token=' + token);

/** 本机页面没有 locale 服务：直接查 `settings.ts` 自带的中文字典。 */
const dictionary = zh as Record<string, string>;
const t = (key: string): string => dictionary[key] ?? key;

/** 只给插件自己的接口补令牌；其它请求原样放行。 */
function withToken(): void {
  const native = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/dsh-pet-7340/')) return native(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('X-DSH-Pet-Token')) headers.set('X-DSH-Pet-Token', token);
    return native(input, { ...init, headers });
  };
}

/** 页面骨架里的提示条：没有令牌 / 挂载失败时用。 */
function tell(message: string): void {
  const box = document.getElementById('pets-notice');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

if (!token) {
  tell('请从桌宠托盘菜单的「打开 AI 设置」进入本页，再从页面上的链接打开桌宠配置，以获得本次运行的访问凭据。');
} else {
  const host = document.getElementById('pets-root');
  if (!host) tell('页面骨架缺失：找不到挂载点。');
  else {
    withToken();
    const Section = makePetConfigSection({ h: jsx, useState, useEffect, useRef, useCallback, t });
    let root = createRoot(host);
    const mount = (): void => {
      root = createRoot(host);
      root.render(jsx(Section, {}));
    };
    petBridge.current = [];
    petBridge.template = undefined;

    /**
     * 把成品聚合喂给桥。DSH 里这一步由 overlay 容器负责，而「添加宠物」要读
     * `petBridge.template` 当模板（缺了它就静默不新增），所以必须有真实值。
     */
    const applyMerged = (merged: Record<string, Record<string, unknown>>): void => {
      petBridge.current = flattenConfigPets(merged);
      const pets = Array.isArray(merged.main?.pets) ? (merged.main.pets as typeof petBridge.current) : [];
      petBridge.template = pets[0];
    };

    /** 兜底拉一次（reload 没带数据时用）。 */
    const prime = async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-pet-7340/config');
        if (res.ok) applyMerged((await res.json()) as Record<string, Record<string, unknown>>);
      } catch {
        // 拉不到就保持空桥：页面照常显示，只是「添加宠物」不可用（不静默丢用户操作）。
      }
    };

    // DSH 里 reload 是让 overlay 容器重渲染；这里没有容器，等价动作是重新挂载一次（会重新拉 /config，
    // 因此「同步」这类不改本地 state 的操作也能立刻反映磁盘上的结果）。放到下一拍，避免在组件自己的
    // 事件处理里同步 unmount 自己。
    petBridge.reload = (merged) => {
      if (merged) applyMerged(merged);
      window.setTimeout(() => {
        root.unmount();
        mount();
      }, 0);
      if (!merged) void prime();
    };

    // 先拿到模板再挂载：用户点「添加宠物」时 petBridge.template 必须已经是真值。
    void prime().finally(() => {
      try {
        mount();
      } catch (error) {
        tell('配置页渲染失败：' + (error instanceof Error ? error.message : String(error)));
      }
    });
  }
}
