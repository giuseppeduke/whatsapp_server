// Store liviano en memoria con persistencia a disco (JSON).
// Baileys ya no trae un store incluido, así que guardamos chats, contactos
// y los últimos mensajes de cada chat para poder listar y marcar leído/no leído.
import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES_PER_CHAT = Number(process.env.MAX_MESSAGES_PER_CHAT || 100);

const toNumber = (v) => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Desenvuelve mensajes efímeros / view once / editados
export function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message ||
      m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m || {};
}

export function getMessageType(message) {
  const m = unwrapMessage(message);
  const keys = Object.keys(m).filter((k) => k !== 'messageContextInfo');
  return keys[0] || 'unknown';
}

export function getMessageText(message) {
  const m = unwrapMessage(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentMessage?.fileName ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.reactionMessage?.text ||
    m.locationMessage?.name ||
    m.contactMessage?.displayName ||
    ''
  );
}

// Versión simple y serializable de un WAMessage
export function simplifyMessage(msg) {
  const ts = toNumber(msg.messageTimestamp);
  return {
    id: msg.key?.id,
    chatId: msg.key?.remoteJid,
    chatIdAlt: msg.key?.remoteJidAlt || undefined,
    fromMe: !!msg.key?.fromMe,
    participant: msg.key?.participant || undefined,
    pushName: msg.pushName || undefined,
    timestamp: ts,
    date: ts ? new Date(ts * 1000).toISOString() : undefined,
    type: getMessageType(msg.message),
    text: getMessageText(msg.message),
    // Guardamos la key completa: la necesitamos para marcar leído / no leído
    key: {
      id: msg.key?.id,
      remoteJid: msg.key?.remoteJid,
      fromMe: !!msg.key?.fromMe,
      participant: msg.key?.participant || undefined,
    },
  };
}

export class Store {
  constructor(dataDir, logger) {
    this.file = path.join(dataDir, 'store.json');
    this.logger = logger;
    this.chats = new Map(); // jid -> { id, name, unreadCount, timestamp, archived, pinned }
    this.contacts = new Map(); // jid -> { id, name, notify, verifiedName, lid, phoneNumber }
    this.messages = new Map(); // jid -> [simplifiedMessage]
    this._dirty = false;
    this._load();
    this._timer = setInterval(() => this.flush(), 10_000);
    this._timer.unref();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const c of raw.chats || []) this.chats.set(c.id, c);
      for (const c of raw.contacts || []) this.contacts.set(c.id, c);
      for (const [jid, list] of Object.entries(raw.messages || {})) this.messages.set(jid, list);
      this.logger.info({ chats: this.chats.size }, 'Store cargado desde disco');
    } catch (err) {
      this.logger.warn({ err }, 'No se pudo cargar el store, arranco vacío');
    }
  }

  flush() {
    if (!this._dirty) return;
    try {
      const data = {
        chats: [...this.chats.values()],
        contacts: [...this.contacts.values()],
        messages: Object.fromEntries(this.messages),
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger.error({ err }, 'Error guardando store');
    }
  }

  clear() {
    this.chats.clear();
    this.contacts.clear();
    this.messages.clear();
    this._dirty = true;
    this.flush();
  }

  // ---------- Chats ----------
  upsertChat(chat) {
    if (!chat?.id) return;
    const prev = this.chats.get(chat.id) || { id: chat.id, unreadCount: 0 };
    const next = { ...prev };
    if (chat.name) next.name = chat.name;
    if (chat.unreadCount != null) next.unreadCount = chat.unreadCount;
    if (chat.conversationTimestamp != null) next.timestamp = toNumber(chat.conversationTimestamp);
    if (chat.archived != null) next.archived = !!chat.archived;
    if (chat.pinned != null) next.pinned = toNumber(chat.pinned);
    this.chats.set(chat.id, next);
    this._dirty = true;
  }

  updateChat(update) {
    if (!update?.id) return;
    const prev = this.chats.get(update.id) || { id: update.id, unreadCount: 0 };
    const next = { ...prev };
    if (update.unreadCount != null) {
      // Baileys manda deltas positivos cuando llegan mensajes nuevos,
      // y 0 / -1 como valor absoluto (leído / marcado no leído)
      next.unreadCount =
        update.unreadCount > 0
          ? Math.max(prev.unreadCount || 0, 0) + update.unreadCount
          : update.unreadCount;
    }
    if (update.name) next.name = update.name;
    if (update.conversationTimestamp != null) next.timestamp = toNumber(update.conversationTimestamp);
    if (update.archived != null) next.archived = !!update.archived;
    if (update.pinned != null) next.pinned = toNumber(update.pinned);
    this.chats.set(update.id, next);
    this._dirty = true;
  }

  deleteChats(ids) {
    for (const id of ids) {
      this.chats.delete(id);
      this.messages.delete(id);
    }
    this._dirty = true;
  }

  setUnread(jid, count) {
    const prev = this.chats.get(jid) || { id: jid };
    this.chats.set(jid, { ...prev, unreadCount: count });
    this._dirty = true;
  }

  listChats({ onlyUnread = false, limit = 100 } = {}) {
    let list = [...this.chats.values()].map((c) => {
      const msgs = this.messages.get(c.id) || [];
      const last = msgs[msgs.length - 1];
      const contact = this.contacts.get(c.id);
      return {
        ...c,
        name: c.name || contact?.name || contact?.notify || contact?.verifiedName || undefined,
        isGroup: c.id.endsWith('@g.us'),
        timestamp: Math.max(c.timestamp || 0, last?.timestamp || 0),
        lastMessage: last
          ? { id: last.id, fromMe: last.fromMe, text: last.text, type: last.type, timestamp: last.timestamp }
          : undefined,
        unread: (c.unreadCount || 0) !== 0,
      };
    });
    if (onlyUnread) list = list.filter((c) => c.unread);
    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return list.slice(0, limit);
  }

  // ---------- Contactos ----------
  upsertContact(contact) {
    if (!contact?.id) return;
    const prev = this.contacts.get(contact.id) || { id: contact.id };
    const next = { ...prev };
    for (const k of ['name', 'notify', 'verifiedName', 'lid', 'phoneNumber']) {
      if (contact[k]) next[k] = contact[k];
    }
    this.contacts.set(contact.id, next);
    this._dirty = true;
  }

  listContacts() {
    return [...this.contacts.values()].sort((a, b) =>
      (a.name || a.notify || a.id).localeCompare(b.name || b.notify || b.id)
    );
  }

  // ---------- Mensajes ----------
  addMessage(msg) {
    const jid = msg.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return null;
    // Ignorar mensajes de protocolo (receipts, revoke, etc.)
    const type = getMessageType(msg.message);
    if (!msg.message || type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return null;

    const simple = simplifyMessage(msg);
    const list = this.messages.get(jid) || [];
    const idx = list.findIndex((m) => m.id === simple.id);
    if (idx >= 0) list[idx] = simple;
    else list.push(simple);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    this.messages.set(jid, list);

    if (!this.chats.has(jid)) this.upsertChat({ id: jid, unreadCount: 0 });
    const chat = this.chats.get(jid);
    if (simple.timestamp > (chat.timestamp || 0)) chat.timestamp = simple.timestamp;
    if (!chat.name && !jid.endsWith('@g.us') && !simple.fromMe && simple.pushName) chat.name = simple.pushName;

    this._dirty = true;
    return simple;
  }

  getMessages(jid, limit = 50) {
    const list = this.messages.get(jid) || [];
    return list.slice(-limit);
  }

  lastMessage(jid) {
    const list = this.messages.get(jid) || [];
    return list[list.length - 1];
  }

  // Últimos mensajes entrantes (para mandar el "visto")
  lastIncoming(jid, n = 20) {
    const list = this.messages.get(jid) || [];
    return list.filter((m) => !m.fromMe).slice(-n);
  }
}
