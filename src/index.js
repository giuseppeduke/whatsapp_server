import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import { WhatsApp } from './whatsapp.js';
import { qrPage } from './qr-page.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
let API_KEY = process.env.API_KEY;
if (!API_KEY) {
  API_KEY = crypto.randomBytes(24).toString('hex');
  logger.warn(`API_KEY no configurada. Generé una temporal (cambia en cada reinicio): ${API_KEY}`);
}

const wa = new WhatsApp({
  dataDir: DATA_DIR,
  logger,
  webhookUrl: process.env.WEBHOOK_URL,
  webhookSecret: process.env.WEBHOOK_SECRET,
});

const app = express();
app.use(express.json({ limit: '2mb' }));

// Wrapper para manejar errores async
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Públicos ----------
app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: wa.status }));

// ---------- Auth ----------
function auth(req, res, next) {
  const header = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const key = header || req.query.key;
  const a = Buffer.from(String(key || ''));
  const b = Buffer.from(API_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'API key inválida. Usá el header x-api-key o ?key=' });
}

// Página para escanear el QR (abrir en el navegador: /qr?key=TU_API_KEY)
app.get('/qr', auth, (req, res) => res.type('html').send(qrPage(String(req.query.key || ''))));

// "read" | "unread" | "none" (acepta también leido / no_leido)
function parseMark(value) {
  if (value == null || value === '') return 'none';
  const v = String(value).toLowerCase().trim().replace(/[\s-]/g, '_');
  if (['read', 'leido', 'leído', 'visto'].includes(v)) return 'read';
  if (['unread', 'no_leido', 'no_leído', 'noleido', 'sin_leer'].includes(v)) return 'unread';
  if (['none', 'no', 'false'].includes(v)) return 'none';
  const err = new Error('"mark" debe ser "read", "unread" o "none"');
  err.status = 400;
  throw err;
}

async function applyMark(jid, mark) {
  if (mark === 'read') {
    await wa.markChatRead(jid);
    return 'read';
  }
  if (mark === 'unread') {
    const prev = wa.store.chats.get(jid)?.unreadCount || 0;
    await wa.markChatUnread(jid);
    if (prev > 0) wa.store.setUnread(jid, prev); // conservamos el contador
    return 'unread';
  }
  return null;
}

const api = express.Router();
api.use(auth);

// Estado / sesión
api.get('/status', (_req, res) => res.json(wa.getStatus()));
api.get('/qr', (_req, res) =>
  res.json({ status: wa.status, qr: wa.qr, image: wa.qrDataUrl, connected: wa.isReady() })
);
api.post('/pairing-code', h(async (req, res) => res.json(await wa.requestPairingCode(req.body.phone))));
api.post('/logout', h(async (_req, res) => res.json(await wa.logout())));

// Webhook: estado y prueba
api.get('/webhook', (_req, res) => res.json(wa.getWebhookInfo()));
api.post('/webhook/test', h(async (_req, res) => res.json(await wa.testWebhook())));

// Contactos
api.get('/contacts', (_req, res) => res.json(wa.store.listContacts()));
api.get('/contacts/:number/exists', h(async (req, res) => res.json(await wa.checkNumber(req.params.number))));

// Chats
api.get('/chats', (req, res) => {
  const onlyUnread = req.query.unread === 'true' || req.query.unread === '1';
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  res.json(wa.store.listChats({ onlyUnread, limit }));
});
api.get('/chats/:chatId/messages', h(async (req, res) => {
  const jid = wa.toJid(req.params.chatId);
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const mark = parseMark(req.query.mark ?? req.query.tag);
  const messages = wa.store.getMessages(jid, limit);
  const marked = await applyMark(jid, mark);
  res.json({ chatId: jid, mark, marked, messages });
}));
api.post('/chats/:chatId/read', h(async (req, res) => res.json(await wa.markChatRead(req.params.chatId))));
api.post('/chats/:chatId/unread', h(async (req, res) => res.json(await wa.markChatUnread(req.params.chatId))));
api.post(
  '/chats/:chatId/presence',
  h(async (req, res) => res.json(await wa.sendPresence(req.params.chatId, req.body.state)))
);

// Mensajes sin leer.
// mark / tag: "read" = los marca como leídos (manda el visto)
//             "unread" = los deja marcados como no leídos en el celular
//             "none" (por defecto) = no toca nada
async function unreadHandler(req, res) {
  const mark = parseMark(req.body?.mark ?? req.body?.tag ?? req.query.mark ?? req.query.tag);
  const limit = Math.min(Number(req.body?.limit ?? req.query.limit ?? 50), 500);
  const chats = wa.store.listChats({ onlyUnread: true, limit });
  const result = [];
  for (const c of chats) {
    // unreadCount -1 = chat marcado a mano como no leído → devolvemos el último mensaje
    const n = c.unreadCount > 0 ? Math.min(c.unreadCount, 100) : 1;
    const messages = wa.store.lastIncoming(c.id, n);
    let marked;
    try {
      marked = await applyMark(c.id, mark);
    } catch (err) {
      marked = { error: err.message };
    }
    result.push({ chatId: c.id, name: c.name, isGroup: c.isGroup, unreadCount: c.unreadCount, messages, marked });
  }
  res.json({ mark, chats: result.length, messages: result.reduce((s, c) => s + c.messages.length, 0), data: result });
}
api.get('/messages/unread', h(unreadHandler));
api.post('/messages/unread', h(unreadHandler));

api.post(
  '/messages/text',
  h(async (req, res) => res.json(await wa.sendText(req.body.to, req.body.text, { quotedId: req.body.quotedId })))
);
api.post('/messages/media', h(async (req, res) => res.json(await wa.sendMedia(req.body.to, req.body))));
api.post(
  '/messages/read',
  h(async (req, res) => res.json(await wa.markMessagesRead(req.body.chatId, req.body.ids)))
);

app.use('/api', api);

app.get('/', (_req, res) =>
  res.json({ name: 'whatsapp-server', status: wa.status, qr: '/qr?key=API_KEY', docs: 'Ver README.md' })
);

// Errores
app.use((err, _req, res, _next) => {
  const status = err.status || err.output?.statusCode || 500;
  if (status >= 500) logger.error({ err }, 'Error en request');
  res.status(status).json({ error: err.message || 'Error interno' });
});

app.listen(PORT, () => logger.info(`Servidor escuchando en :${PORT} — datos en ${DATA_DIR}`));

wa.start().catch((err) => {
  logger.error({ err }, 'No se pudo iniciar WhatsApp');
});

// Guardar el store antes de apagar (Railway manda SIGTERM en cada deploy)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info(`${sig} recibido, guardando y saliendo`);
    wa.store.flush();
    process.exit(0);
  });
}
