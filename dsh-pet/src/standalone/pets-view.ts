/**
 * 独立模式「桌宠配置」页面的骨架：HTML、样式（含 DSH 主题变量映射）。
 *
 * 页面本身不含业务：内容由 `./settings-client` 挂载的 React 组件提供。
 * 与 AI 设置页分开成一个路由，是为了让这一页能单独放开 `style-src 'unsafe-inline'`
 * （React 的内联 style 与运行时注入 <style> 需要它），而带密钥输入的 AI 页维持严格 CSP。
 * 必须始终成立：不内联脚本、不引外部 CDN；主题变量缺失时只是配色回落，不影响可读性。
 * @module dsh-pet/src/standalone/pets-view
 */

/** 桌宠配置页 HTML。 */
export const petsViewHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠配置</title><link rel="stylesheet" href="/standalone-ai/pets.css">
<script src="/standalone-ai/pets.js" defer></script></head><body>
<header class="pets-head"><a id="back-link" class="pets-back" href="/standalone-ai/">← 返回 AI 设置</a>
<h1>桌宠配置</h1>
<p class="pets-sub">与 DSH 里的「桌宠配置」是同一个界面：大小、位置、多开、开关、字体、物理手感都在这里，保存即时生效。</p></header>
<p id="pets-notice" class="pets-notice" role="status" aria-live="polite" hidden></p>
<main id="pets-root"></main>
<noscript>需要启用 JavaScript 才能编辑桌宠配置。</noscript>
</body></html>`;

/**
 * 页面样式：先是 DSH 主题变量的本机映射（组件内部全走 `--dsw-alias-*`），
 * 再是这一页自己的容器与页头。缺变量时组件会退化成浏览器默认色，仍然可读可点。
 */
export const petsViewStyle = `
:root{
  color-scheme:light;
  --pets-ink:#203b4b;--pets-muted:#526a78;--pets-line:#cbdce5;--pets-paper:#fff;--pets-water:#edf5fa;--pets-blue:#12618b;
  /* DSH 语义 token → 本机配色（组件里用到的全集，17 个） */
  --dsw-alias-label-primary:var(--pets-ink);
  --dsw-alias-label-secondary:#3d576a;
  --dsw-alias-label-tertiary:#6a7e8b;
  --dsw-alias-label-caption:#6a7e8b;
  --dsw-alias-label-dimmed:#9aabb6;
  --dsw-alias-bg-layer-1:var(--pets-paper);
  --dsw-alias-border-l1:#dbe7ee;
  --dsw-alias-border-l2:var(--pets-line);
  --dsw-alias-interactive-bg-hover:#eef6fa;
  --dsw-alias-interactive-bg-active:#e4f0f7;
  --dsw-alias-button-info-fill:var(--pets-blue);
  --dsw-alias-button-info-hover:#0b4e73;
  --dsw-alias-state-error-primary:#b42318;
  --dsw-alias-state-error-secondary:#d2564b;
  --dsw-alias-state-success-primary:#1a7f37;
  --dsw-alias-state-business-primary:var(--pets-blue);
  --dsw-alias-tooltip-bg:var(--pets-ink);
  --dsw-focus-ring-color:#3a94c4;
  --dsw-radius-sm:6px;
  --dsw-radius-md:10px;
  --dsw-elevation-prominent:0 8px 30px rgba(32,59,75,.18);
}
*{box-sizing:border-box}
body{margin:0;background:var(--pets-water);color:var(--pets-ink);font:15px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
.pets-head{max-width:720px;margin:0 auto;padding:32px 24px 8px}
.pets-back{display:inline-block;margin-bottom:14px;color:var(--pets-blue);font-size:13px;text-decoration:none}
.pets-back:hover{text-decoration:underline}
.pets-head h1{font-size:26px;line-height:1.3;margin:0 0 8px;font-weight:700;letter-spacing:-.5px}
.pets-sub{font-size:13px;line-height:1.6;color:var(--pets-muted);margin:0}
#pets-root{max-width:720px;margin:0 auto;padding:16px 24px 48px}
.pets-notice{max-width:720px;margin:16px auto 0;padding:12px 14px;border-left:3px solid #c18e36;background:#fff7e7;
  color:#704b13;font-size:13px;line-height:1.6}
#pets-root:empty{min-height:120px}
@media(max-width:560px){.pets-head{padding:20px 16px 4px}#pets-root{padding:12px 16px 32px}.pets-head h1{font-size:22px}}
`;
