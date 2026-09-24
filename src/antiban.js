// Protección anti-baneo: hace que los envíos se parezcan a los de una persona
// y frena los patrones que WhatsApp suele marcar como spam.
//
// - Cola única: los mensajes salen de a uno, nunca en paralelo.
// - Pausas aleatorias (distribución normal) entre envíos + extra para chats nuevos.
// - Límites por minuto / hora / día (y calentamiento opcional para números nuevos).
// - "Escribiendo…" antes de cada mensaje, con duración según el largo del texto.
// - Tope de mensajes idénticos y de chats nuevos (gente que nunca te escribió) por día.
// - Monitor de riesgo: si WhatsApp empieza a dar señales (desconexiones 401/403/463,
//   envíos fallidos) baja la velocidad y, si es crítico, pausa los envíos.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(v).toLowerCase()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Número aleatorio con distribución normal (Box-Muller), recortado a [min, max]
function gaussian(min, max) {
  const mean = (min + max) / 2;
  const sd = (max - min) / 4;
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + z * sd));
}

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

export function antibanConfigFromEnv(env = process.env) {
  return {
    enabled: bool(env.ANTIBAN_ENABLED, true),
    minDelayMs: num(env.ANTIBAN_MIN_DELAY_MS, 2000),
    maxDelayMs: num(env.ANTIBAN_MAX_DELAY_MS, 6000),
    newChatExtraMs: num(env.ANTIBAN_NEW_CHAT_EXTRA_MS, 4000),
    maxPerMinute: num(env.ANTIBAN_MAX_PER_MINUTE, 8),
    maxPerHour: num(env.ANTIBAN_MAX_PER_HOUR, 120),
    maxPerDay: num(env.ANTIBAN_MAX_PER_DAY, 800),
    maxNewChatsPerDay: num(env.ANTIBAN_MAX_NEW_CHATS_PER_DAY, 20),
    maxIdenticalPerHour: num(env.ANTIBAN_MAX_IDENTICAL_PER_HOUR, 5),
    typing: bool(env.ANTIBAN_TYPING, true),
    warmup: bool(env.ANTIBAN_WARMUP, false),
    quietHours: env.ANTIBAN_QUIET_HOURS ?? '0-7', // horas locales con envíos más lentos ("" para desactivar)
    timezone: env.ANTIBAN_TZ || env.TZ || 'America/Argentina/Buenos_Aires',
    maxQueueWaitMs: num(env.ANTIBAN_MAX_QUEUE_WAIT_MS, 120_000),
  };
}

// Calentamiento de números nuevos: día 1 = 20 mensajes, x1.8 por día, libre desde el día 8
const WARMUP = [20, 36, 65, 117, 210, 378, 680];

export class AntiBan {
  constructor({ dataDir, logger, config = antibanConfigFromEnv() }) {
    this.cfg = config;
    this.logger = logger;
    this.file = path.join(dataDir, 'antiban.json');
    this.queue = Promise.resolve();
    this.pending = 0;
    this.lastSentAt = 0;
    this.sent = []; // timestamps (ms) de la última hora
    this.identical = new Map(); // hash -> [timestamps]
    this.risk = 0;
    this.riskUpdatedAt = Date.now();
    this.events = [];
    this.connectedAt = 0;
    this.state = { firstSeen: null, day: null, sentToday: 0, newChatsToday: [] };
    try {
      this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      /* primera vez */
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch (err) {
      this.logger.warn({ err: err.message }, 'antiban: no se pudo guardar el estado');
    }
  }

  _today() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.cfg.timezone }).format(new Date());
  }

  _localHour() {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: this.cfg.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())
    );
  }

  _rollDay() {
    const today = this._today();
    if (this.state.day !== today) {
      this.state.day = today;
      this.state.sentToday = 0;
      this.state.newChatsToday = [];
      this._save();
    }
  }

  // ---------- Riesgo ----------
  _decayRisk() {
    const hours = (Date.now() - this.riskUpdatedAt) / 3_600_000;
    if (hours > 0) {
      this.risk = Math.max(0, this.risk - hours * 10); // baja 10 puntos por hora sin problemas
      this.riskUpdatedAt = Date.now();
    }
  }

  _addRisk(points, reason) {
    this._decayRisk();
    this.risk = Math.min(100, this.risk + points);
    this.events.unshift({ at: new Date().toISOString(), points, reason, risk: Math.round(this.risk) });
    if (this.events.length > 30) this.events.pop();
    if (points >= 20) this.logger.warn({ reason, risk: Math.round(this.risk) }, 'antiban: señal de riesgo');
  }

  riskLevel() {
    this._decayRisk();
    if (this.risk >= 85) return 'critical';
    if (this.risk >= 60) return 'high';
    if (this.risk >= 30) return 'medium';
    return 'low';
  }

  // Multiplicadores según riesgo: [pausas, límites]
  _riskFactors() {
    return { low: [1, 1], medium: [2, 0.5], high: [5, 0.2], critical: [Infinity, 0] }[this.riskLevel()];
  }

  onConnectionOpen() {
    this.connectedAt = Date.now();
    if (!this.state.firstSeen) {
      this.state.firstSeen = new Date().toISOString();
      this._save();
    }
  }

  onDisconnect(code) {
    const points = { 401: 60, 403: 40, 463: 25, 440: 10, 500: 10, 411: 15 }[code] ?? 3;
    this._addRisk(points, `desconexión ${code ?? 'desconocida'}`);
  }

  onSendError(err) {
    const code = err?.output?.statusCode || err?.data?.code || err?.status;
    this._addRisk(code === 463 ? 25 : 20, `envío fallido: ${err?.message || code}`);
  }

  // ---------- Límites ----------
  _limits() {
    const [, lim] = this._riskFactors();
    let perDay = this.cfg.maxPerDay;
    if (this.cfg.warmup && this.state.firstSeen) {
      const day = Math.floor((Date.now() - new Date(this.state.firstSeen).getTime()) / 86_400_000);
      if (day < WARMUP.length) perDay = Math.min(perDay, WARMUP[day]);
    }
    return {
      perMinute: Math.floor(this.cfg.maxPerMinute * lim),
      perHour: Math.floor(this.cfg.maxPerHour * lim),
      perDay: Math.floor(perDay * lim),
      newChatsPerDay: Math.floor(this.cfg.maxNewChatsPerDay * lim),
    };
  }

  _prune() {
    const hourAgo = Date.now() - 3_600_000;
    this.sent = this.sent.filter((t) => t > hourAgo);
    for (const [k, list] of this.identical) {
      const kept = list.filter((t) => t > hourAgo);
      if (kept.length) this.identical.set(k, kept);
      else this.identical.delete(k);
    }
  }

  // Valida antes de encolar (falla rápido con 429/503)
  _check({ jid, text, isNewChat }) {
    this._rollDay();
    this._prune();
    const lim = this._limits();
    if (this.riskLevel() === 'critical') {
      throw httpError(503, 'Envíos pausados: WhatsApp está dando señales de riesgo de bloqueo. Esperá unas horas.', {
        antiban: 'risk_critical',
      });
    }
    if (this.state.sentToday >= lim.perDay) {
      throw httpError(429, `Límite diario alcanzado (${lim.perDay} mensajes).`, { antiban: 'daily_limit' });
    }
    if (this.sent.length >= lim.perHour) {
      const retryAfter = Math.ceil((this.sent[0] + 3_600_000 - Date.now()) / 1000);
      throw httpError(429, `Límite por hora alcanzado (${lim.perHour} mensajes).`, { antiban: 'hourly_limit', retryAfter });
    }
    if (isNewChat && !this.state.newChatsToday.includes(jid) && this.state.newChatsToday.length >= lim.newChatsPerDay) {
      throw httpError(
        429,
        `Límite de chats nuevos por día alcanzado (${lim.newChatsPerDay}). Escribirle a mucha gente que nunca te escribió es lo que más baneos causa.`,
        { antiban: 'new_chats_limit' }
      );
    }
    if (text) {
      const key = crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex');
      const list = this.identical.get(key) || [];
      if (list.length >= this.cfg.maxIdenticalPerHour) {
        throw httpError(
          429,
          `Ya enviaste este mismo texto ${list.length} veces en la última hora. Personalizalo (nombre, detalle del pedido, etc.).`,
          { antiban: 'identical_limit' }
        );
      }
      return key;
    }
    return null;
  }

  _gapMs(isNewChat) {
    const [mult] = this._riskFactors();
    let gap = gaussian(this.cfg.minDelayMs, this.cfg.maxDelayMs) * mult;
    if (isNewChat) gap += this.cfg.newChatExtraMs;
    // Horario nocturno: más lento
    const [from, to] = String(this.cfg.quietHours).split('-').map(Number);
    const h = this._localHour();
    if (Number.isFinite(from) && Number.isFinite(to) && (from <= to ? h >= from && h < to : h >= from || h < to)) gap *= 2;
    // Recién reconectado: arrancar despacio el primer minuto
    if (this.connectedAt && Date.now() - this.connectedAt < 60_000) gap *= 2;
    return gap;
  }

  _typingMs(text) {
    const wpm = Math.min(90, Math.max(20, gaussian(25, 65))); // ~45 palabras por minuto
    const ms = ((text?.length || 20) * 60_000) / (wpm * 5);
    return Math.round(Math.min(8000, Math.max(1200, ms)));
  }

  /**
   * Encola un envío.
   * @param {object} o
   * @param {string} o.jid
   * @param {string} [o.text]       texto (para "escribiendo…" y control de repetidos)
   * @param {boolean} o.isNewChat   true si esa persona nunca te escribió
   * @param {boolean} [o.typing]    mostrar "escribiendo…" (default: config)
   * @param {'composing'|'recording'} [o.presence]
   * @param {(state:string)=>Promise} o.setPresence
   * @param {()=>Promise<any>} o.send
   */
  async run(o) {
    if (!this.cfg.enabled) return { result: await o.send(), antiban: { enabled: false } };

    const hash = this._check(o);
    if (this.pending * this.cfg.maxDelayMs > this.cfg.maxQueueWaitMs) {
      throw httpError(429, 'Hay demasiados mensajes en cola. Reintentá en un minuto.', { antiban: 'queue_full' });
    }

    const enqueuedAt = Date.now();
    this.pending++;
    const job = this.queue.then(async () => {
      try {
        this._check(o); // re-validar: las cosas pudieron cambiar mientras esperaba
        this._prune();

        // Pausa desde el último envío
        const wait = Math.max(0, this.lastSentAt + this._gapMs(o.isNewChat) - Date.now());
        if (wait) await sleep(wait);

        // Límite por minuto
        const lim = this._limits();
        const lastMin = this.sent.filter((t) => t > Date.now() - 60_000);
        if (lastMin.length >= lim.perMinute) await sleep(lastMin[0] + 60_000 - Date.now() + 500);

        // "Escribiendo…"
        let typedMs = 0;
        if ((o.typing ?? this.cfg.typing) && o.setPresence) {
          typedMs = o.text ? this._typingMs(o.text) : Math.round(gaussian(1500, 3500));
          try {
            await o.setPresence(o.presence || 'composing');
            await sleep(typedMs);
            await o.setPresence('paused');
          } catch {
            /* la presencia no es crítica */
          }
        }

        let result;
        try {
          result = await o.send();
        } catch (err) {
          this.onSendError(err);
          throw err;
        }

        const now = Date.now();
        this.lastSentAt = now;
        this.sent.push(now);
        this.state.sentToday++;
        if (o.isNewChat && !this.state.newChatsToday.includes(o.jid)) this.state.newChatsToday.push(o.jid);
        if (hash) this.identical.set(hash, [...(this.identical.get(hash) || []), now]);
        this._save();
        return { result, antiban: { queuedMs: now - enqueuedAt, typingMs: typedMs, newChat: !!o.isNewChat } };
      } finally {
        this.pending--;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  getInfo() {
    this._rollDay();
    this._prune();
    const lim = this._limits();
    const warmupDay = this.state.firstSeen
      ? Math.floor((Date.now() - new Date(this.state.firstSeen).getTime()) / 86_400_000) + 1
      : null;
    return {
      enabled: this.cfg.enabled,
      risk: { score: Math.round(this.risk), level: this.riskLevel(), events: this.events.slice(0, 10) },
      usage: {
        lastMinute: this.sent.filter((t) => t > Date.now() - 60_000).length,
        lastHour: this.sent.length,
        today: this.state.sentToday,
        newChatsToday: this.state.newChatsToday.length,
        queued: this.pending,
      },
      limits: lim,
      warmup: { enabled: this.cfg.warmup, day: warmupDay, linkedSince: this.state.firstSeen },
      config: {
        delayMs: [this.cfg.minDelayMs, this.cfg.maxDelayMs],
        newChatExtraMs: this.cfg.newChatExtraMs,
        maxIdenticalPerHour: this.cfg.maxIdenticalPerHour,
        typing: this.cfg.typing,
        quietHours: this.cfg.quietHours,
        timezone: this.cfg.timezone,
      },
    };
  }
}
