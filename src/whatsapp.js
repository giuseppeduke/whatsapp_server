// Manejo de la conexión con WhatsApp (Baileys): QR, reconexión, eventos y acciones.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import * as baileysModule from 'baileys';
import { Store } from './store.js';

// Compatibilidad ESM/CJS entre versiones de Baileys
const B = baileysModule.makeWASocket ? baileysModule : baileysModule.default;
const makeWASocket = B.makeWASocket || B.default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
} = B;

export class WhatsApp {
  constructor({ dataDir, logger, webhookUrl, webhookSecret }) {
    this.dataDir = dataDir;
    this.authDir = path.join(dataDir, 'auth');
    this.logger = logger;
    this.webhookUrl = webhookUrl;
    this.webhookSecret = webhookSecret;
    this.store = new Store(dataDir, logger);

    this.sock = null;
    this.status = 'starting'; // starting | qr | connecting | open | closed | logged_out
    this.qr = null; // string crudo
    this.qrDataUrl = null; // imagen base64
    this.me = null;
    this.retries = 0;
    this.sentCache = new Map(); // id -> message (para reintentos de descifrado)
  }

  async start() {
    fs.mkdirSync(this.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* usa la versión por defecto de Baileys */
    }

    this.status = 'connecting';
    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.logger.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
      browser: Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      markOnlineOnConnect: false, // así el celular sigue recibiendo notificaciones
      syncFullHistory: false,
      getMessage: async (key) => this.sentCache.get(key.id),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        this.status = 'qr';
        this.logger.info('Nuevo QR disponible: abrí /qr para escanearlo');
      }

      if (connection === 'open') {
        this.status = 'open';
        this.qr = null;
        this.qrDataUrl = null;
        this.retries = 0;
        this.me = sock.user;
        this.logger.info({ me: sock.user?.id }, 'WhatsApp conectado');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        this.logger.warn({ code, err: lastDisconnect?.error?.message }, 'Conexión cerrada');

        if (code === DisconnectReason.loggedOut) {
          this.status = 'logged_out';
          await this._wipeSession();
          setTimeout(() => this.start().catch((e) => this.logger.error(e)), 1000);
          return;
        }

        this.status = 'closed';
        const delay =
          code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2000 * 2 ** this.retries++);
        setTimeout(() => this.start().catch((e) => this.logger.error(e)), delay);
      }
    });

    // Historial inicial
    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
      for (const c of chats) this.store.upsertChat(c);
      for (const c of contacts) this.store.upsertContact(c);
      for (const m of messages) this.store.addMessage(m);
    });

    sock.ev.on('chats.upsert', (chats) => chats.forEach((c) => this.store.upsertChat(c)));
    sock.ev.on('chats.update', (updates) => updates.forEach((u) => this.store.updateChat(u)));
    sock.ev.on('chats.delete', (ids) => this.store.deleteChats(ids));
    sock.ev.on('contacts.upsert', (cs) => cs.forEach((c) => this.store.upsertContact(c)));
    sock.ev.on('contacts.update', (cs) => cs.forEach((c) => this.store.upsertContact(c)));

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        const simple = this.store.addMessage(msg);
        if (!simple) continue;
        if (msg.pushName && !simple.fromMe && !simple.chatId.endsWith('@g.us')) {
          this.store.upsertContact({ id: simple.chatId, notify: msg.pushName });
        }
        if (type === 'notify') {
          this._webhook({ event: 'message', message: simple });
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (u.update?.status != null) {
          this._webhook({ event: 'message.status', key: u.key, status: u.update.status });
        }
      }
    });
  }

  async _wipeSession() {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch (err) {
      this.logger.error({ err }, 'No se pudo borrar la sesión');
    }
    this.store.clear();
    this.me = null;
  }

  async _webhook(payload) {
    if (!this.webhookUrl) return;
    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.webhookSecret ? { 'x-webhook-secret': this.webhookSecret } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Webhook falló');
    }
  }

  // ---------- Helpers ----------
  isReady() {
    return this.status === 'open' && !!this.sock;
  }

  assertReady() {
    if (!this.isReady()) {
      const err = new Error(`WhatsApp no está conectado (estado: ${this.status}). Escaneá el QR en /qr`);
      err.status = 503;
      throw err;
    }
  }

  // Acepta "5491122334455", "+54 9 11 2233-4455" o un JID completo
  toJid(input) {
    if (!input) {
      const err = new Error('Falta el número o chatId');
      err.status = 400;
      throw err;
    }
    const s = String(input).trim();
    if (s.includes('@')) return jidNormalizedUser ? jidNormalizedUser(s) : s;
    const digits = s.replace(/\D/g, '');
    if (digits.length < 8) {
      const err = new Error(`Número inválido: ${input}`);
      err.status = 400;
      throw err;
    }
    return `${digits}@s.whatsapp.net`;
  }

  // ---------- Acciones ----------
  getStatus() {
    return {
      status: this.status,
      connected: this.isReady(),
      hasQr: !!this.qr,
      me: this.me ? { id: this.me.id, name: this.me.name } : null,
    };
  }

  async checkNumber(number) {
    this.assertReady();
    const digits = String(number).replace(/\D/g, '');
    const [result] = (await this.sock.onWhatsApp(digits)) || [];
    return { number: digits, exists: !!result?.exists, jid: result?.jid || null };
  }

  async requestPairingCode(phone) {
    if (this.isReady()) {
      const err = new Error('Ya está conectado');
      err.status = 409;
      throw err;
    }
    if (!this.sock) {
      const err = new Error('Socket no iniciado todavía, reintentá en unos segundos');
      err.status = 503;
      throw err;
    }
    const code = await this.sock.requestPairingCode(String(phone).replace(/\D/g, ''));
    return { code };
  }

  _remember(sent) {
    if (sent?.key?.id && sent.message) {
      this.sentCache.set(sent.key.id, sent.message);
      if (this.sentCache.size > 500) this.sentCache.delete(this.sentCache.keys().next().value);
    }
    if (sent) this.store.addMessage(sent);
  }

  async sendText(to, text, { quotedId } = {}) {
    this.assertReady();
    if (!text) {
      const err = new Error('Falta "text"');
      err.status = 400;
      throw err;
    }
    const jid = this.toJid(to);
    const opts = {};
    if (quotedId) {
      const q = (this.store.messages.get(jid) || []).find((m) => m.id === quotedId);
      if (q) opts.quoted = { key: q.key, message: { conversation: q.text || '' } };
    }
    const sent = await this.sock.sendMessage(jid, { text }, opts);
    this._remember(sent);
    return { id: sent?.key?.id, chatId: jid };
  }

  async sendMedia(to, { type, url, caption, fileName, mimetype, ptt }) {
    this.assertReady();
    const allowed = ['image', 'video', 'audio', 'document', 'sticker'];
    if (!allowed.includes(type)) {
      const err = new Error(`"type" debe ser uno de: ${allowed.join(', ')}`);
      err.status = 400;
      throw err;
    }
    if (!url) {
      const err = new Error('Falta "url"');
      err.status = 400;
      throw err;
    }
    const jid = this.toJid(to);
    const content = { [type]: { url } };
    if (caption && ['image', 'video', 'document'].includes(type)) content.caption = caption;
    if (type === 'document') {
      content.fileName = fileName || 'archivo';
      content.mimetype = mimetype || 'application/octet-stream';
    }
    if (type === 'audio') {
      content.mimetype = mimetype || 'audio/mp4';
      if (ptt) content.ptt = true;
    }
    if (mimetype && !content.mimetype) content.mimetype = mimetype;
    const sent = await this.sock.sendMessage(jid, content);
    this._remember(sent);
    return { id: sent?.key?.id, chatId: jid };
  }

  async sendPresence(to, state = 'composing') {
    this.assertReady();
    const jid = this.toJid(to);
    await this.sock.sendPresenceUpdate(state, jid);
    return { chatId: jid, state };
  }

  // Marca el chat como LEÍDO: manda el "visto" de los últimos mensajes y sincroniza el estado del chat
  async markChatRead(chatId) {
    this.assertReady();
    const jid = this.toJid(chatId);
    const incoming = this.store.lastIncoming(jid, 20);
    if (incoming.length) {
      await this.sock.readMessages(incoming.map((m) => m.key));
    }
    const last = this.store.lastMessage(jid);
    if (last) {
      await this.sock.chatModify(
        { markRead: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
        jid
      );
    }
    this.store.setUnread(jid, 0);
    return { chatId: jid, unread: false, receiptsSent: incoming.length };
  }

  // Marca el chat como NO LEÍDO (el puntito verde en el celular)
  async markChatUnread(chatId) {
    this.assertReady();
    const jid = this.toJid(chatId);
    const last = this.store.lastMessage(jid);
    if (!last) {
      const err = new Error(
        'No tengo mensajes guardados de ese chat todavía. WhatsApp necesita el último mensaje para marcarlo como no leído.'
      );
      err.status = 409;
      throw err;
    }
    await this.sock.chatModify(
      { markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      jid
    );
    this.store.setUnread(jid, -1);
    return { chatId: jid, unread: true };
  }

  // Marca mensajes puntuales como leídos (por id)
  async markMessagesRead(chatId, ids = []) {
    this.assertReady();
    const jid = this.toJid(chatId);
    const list = this.store.messages.get(jid) || [];
    const keys = ids.map((id) => list.find((m) => m.id === id)?.key || { id, remoteJid: jid, fromMe: false });
    if (!keys.length) {
      const err = new Error('Falta "ids"');
      err.status = 400;
      throw err;
    }
    await this.sock.readMessages(keys);
    return { chatId: jid, read: keys.length };
  }

  async logout() {
    try {
      if (this.sock) await this.sock.logout();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Error en logout, borro la sesión igual');
      await this._wipeSession();
      setTimeout(() => this.start().catch((e) => this.logger.error(e)), 1000);
    }
    return { ok: true };
  }
}
