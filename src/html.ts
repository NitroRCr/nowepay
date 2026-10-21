const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Auto-submitting form that forwards the payer to an upstream gateway. */
export function autoSubmitForm(action: string, params: Record<string, string>, method: "GET" | "POST" = "POST"): Response {
  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n      ");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>正在跳转支付</title></head>
  <body>
    <form id="pay" method="${method}" action="${escapeHtml(action)}">
      ${inputs}
      <noscript><button type="submit">继续支付</button></noscript>
    </form>
    <p role="status">正在跳转到支付页面…</p>
    <script>document.getElementById("pay").submit();</script>
  </body>
</html>`;
  return new Response(html, { headers: SECURITY_HEADERS });
}

/** Human-readable error page (epay submit endpoints are opened in the browser). */
export function errorPage(message: string, status = 400): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>支付失败</title></head>
  <body><main><h1>支付请求失败</h1><p role="alert">${escapeHtml(message)}</p></main></body>
</html>`;
  return new Response(html, { status, headers: SECURITY_HEADERS });
}
