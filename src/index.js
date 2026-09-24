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

const api = express.Router();
api.use(auth);

// Estado / sesión
api.get('/status', (_req, res) => res.json(wa.getStatus()));
api.get('/qr', (_req, res) =>
  res.json({ status: wa.status, qr: wa.qr, image: wa.qrDataUrl, connected: wa.isReady() })
);
api.post('/pairing-code', h(async (req, res) => res.json(await wa.requestPairingCode(req.body.phone))));
api.post('/logout', h(async (_req, res) => res.json(await wa.logout())));

// Contactos
api.get('/contacts', (_req, res) => res.json(wa.store.listContacts()));
api.get('/contacts/:number/exists', h(async (req, res) => res.json(await wa.checkNumber(req.params.number))));

// Chats
api.get('/chats', (req, res) => {
  const onlyUnread = req.query.unread === 'true' || req.query.unread === '1';
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  res.json(wa.store.listChats({ onlyUnread, limit }));
});
api.get('/chats/:chatId/messages', (req, res) => {
  const jid = wa.toJid(req.params.chatId);
  const limit = Math.min(Number(req.query.limit || 50), 500);
  res.json({ chatId: jid, messages: wa.store.getMessages(jid, limit) });
});
api.post('/chats/:chatId/read', h(async (req, res) => res.json(await wa.markChatRead(req.params.chatId))));
api.post('/chats/:chatId/unread', h(async (req, res) => res.json(await wa.markChatUnread(req.params.chatId))));
api.post(
  '/chats/:chatId/presence',
  h(async (req, res) => res.json(await wa.sendPresence(req.params.chatId, req.body.state)))
);

// Mensajes
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
