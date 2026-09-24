// Página simple para escanear el QR desde el navegador. Se actualiza sola.
export function qrPage(key) {
  const safeKey = JSON.stringify(key).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhatsApp · Vincular</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f3; --card:#fff; --fg:#1d2320; --muted:#6b736f; --ok:#1f8f5a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111513; --card:#1b201d; --fg:#e8ece9; --muted:#98a19c; --ok:#3cc58a; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); border-radius:16px; padding:28px; max-width:380px; width:100%; text-align:center;
          box-shadow:0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size:20px; margin:0 0 4px; }
  p { color:var(--muted); margin:0 0 20px; font-size:14px; }
  #qr { width:280px; height:280px; max-width:100%; background:#fff; border-radius:8px; display:grid; place-items:center; margin:0 auto; }
  #qr img { width:100%; height:100%; image-rendering:pixelated; }
  .ok { color:var(--ok); font-weight:600; font-size:18px; }
  #st { margin-top:16px; font-size:13px; color:var(--muted); }
</style>
</head>
<body>
<div class="card">
  <h1>Vincular WhatsApp</h1>
  <p>En el celular: WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
  <div id="qr">Cargando…</div>
  <div id="st"></div>
</div>
<script>
  const KEY = ${safeKey};
  const qr = document.getElementById('qr'), st = document.getElementById('st');
  let lastImg = null;
  async function tick() {
    try {
      const r = await fetch('/api/qr', { headers: { 'x-api-key': KEY } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.status);
      if (d.connected) {
        qr.innerHTML = '<span class="ok">✓ Conectado</span>';
        lastImg = null;
      } else if (d.image && d.image !== lastImg) {
        lastImg = d.image;
        qr.innerHTML = '<img alt="QR" src="' + d.image + '">';
      } else if (!d.image) {
        qr.textContent = 'Esperando QR…';
      }
      st.textContent = 'Estado: ' + d.status;
    } catch (e) {
      st.textContent = 'Error: ' + e.message;
    }
  }
  tick(); setInterval(tick, 3000);
</script>
</body>
</html>`;
}
