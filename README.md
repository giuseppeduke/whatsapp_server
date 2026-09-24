# WhatsApp Server (QR + API REST)

Servidor Node.js que vincula una cuenta de WhatsApp escaneando un QR (como WhatsApp Web) y expone una API REST para:

- Listar chats y contactos
- Leer mensajes de un chat
- Enviar texto, imágenes, videos, audios y documentos
- **Marcar chats como leídos / no leídos**
- Recibir mensajes entrantes por webhook

Usa [Baileys](https://github.com/WhiskeySockets/Baileys) (conexión por WebSocket, sin navegador), así que es liviano y corre bien en Railway.

> ⚠️ No es la API oficial de WhatsApp. Usalo con un número que no te importe arriesgar y evitá mandar mensajes masivos a gente que no te escribió: WhatsApp puede banear el número.

---

## Correr local

```bash
cp .env.example .env      # editá API_KEY
npm install
node --env-file=.env src/index.js
```

Abrí `http://localhost:3000/qr?key=TU_API_KEY` y escaneá con el celular (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).

---

## Deploy en Railway + GitHub

1. **Subí el repo a GitHub**
   ```bash
   git init && git add . && git commit -m "WhatsApp server"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/whatsapp-server.git
   git push -u origin main
   ```
2. En [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → elegí el repo. Railway detecta el `Dockerfile` y `railway.json` solos.
3. **Volume (obligatorio)**: en el servicio → clic derecho / *Add Volume* → mount path **`/data`**. Sin esto se pierde la sesión en cada deploy y tenés que volver a escanear el QR.
4. **Variables** (pestaña *Variables*):
   | Variable | Valor |
   |---|---|
   | `API_KEY` | una clave larga (ej: `openssl rand -hex 24`) |
   | `WEBHOOK_URL` | opcional, tu endpoint para mensajes entrantes |
   | `WEBHOOK_SECRET` | opcional |
5. **Settings → Networking → Generate Domain**.
6. Abrí `https://TU-APP.up.railway.app/qr?key=TU_API_KEY` y escaneá el QR.

Cada `git push` a `main` redeploya automáticamente y la sesión se mantiene gracias al volume.

> Dejá **1 sola réplica**: dos instancias con la misma sesión se desconectan entre sí.

---

## API

Todas las rutas `/api/*` requieren la API key en el header `x-api-key` (o `Authorization: Bearer ...`).

Los números van con código de país, sin `+` ni espacios (se limpian igual). Ej. Argentina celular: `5491122334455`. También podés pasar el `chatId` completo (`5491122334455@s.whatsapp.net`, grupos `...@g.us`).

### Sesión
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Healthcheck (público) |
| GET | `/qr?key=API_KEY` | Página con el QR |
| GET | `/api/status` | Estado de la conexión |
| GET | `/api/qr` | QR en JSON (`qr` crudo + `image` base64) |
| POST | `/api/pairing-code` | Alternativa al QR: `{ "phone": "5491122334455" }` → código de 8 dígitos |
| POST | `/api/logout` | Desvincula y genera un QR nuevo |

### Chats y contactos
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/chats?unread=true&limit=50` | Lista de chats (ordenados por último mensaje) |
| GET | `/api/chats/:chatId/messages?limit=50` | Últimos mensajes del chat |
| POST | `/api/chats/:chatId/read` | **Marca el chat como leído** (manda el visto) |
| POST | `/api/chats/:chatId/unread` | **Marca el chat como no leído** |
| POST | `/api/chats/:chatId/presence` | `{ "state": "composing" \| "paused" \| "recording" }` |
| GET | `/api/contacts` | Contactos conocidos |
| GET | `/api/contacts/:number/exists` | Verifica si el número tiene WhatsApp |

### Mensajes
| Método | Ruta | Body |
|---|---|---|
| POST | `/api/messages/text` | `{ "to": "5491122334455", "text": "Hola!", "quotedId": "opcional" }` |
| POST | `/api/messages/media` | `{ "to": "...", "type": "image\|video\|audio\|document\|sticker", "url": "https://...", "caption": "...", "fileName": "factura.pdf", "mimetype": "application/pdf" }` |
| POST | `/api/messages/read` | `{ "chatId": "...", "ids": ["MSG_ID_1", "MSG_ID_2"] }` |

### Ejemplos

```bash
URL=https://TU-APP.up.railway.app
KEY=TU_API_KEY

# Enviar mensaje
curl -X POST $URL/api/messages/text -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"to":"5491122334455","text":"Hola desde la API 👋"}'

# Chats sin leer
curl "$URL/api/chats?unread=true" -H "x-api-key: $KEY"

# Marcar leído / no leído
curl -X POST $URL/api/chats/5491122334455/read   -H "x-api-key: $KEY"
curl -X POST $URL/api/chats/5491122334455/unread -H "x-api-key: $KEY"
```

### Webhook

Si configurás `WEBHOOK_URL`, por cada mensaje nuevo se manda un `POST`:

```json
{
  "event": "message",
  "message": {
    "id": "3EB0...",
    "chatId": "5491122334455@s.whatsapp.net",
    "fromMe": false,
    "pushName": "Juan",
    "timestamp": 1758650000,
    "type": "conversation",
    "text": "Hola!"
  }
}
```

También llega `{ "event": "message.status", ... }` cuando cambia el estado (entregado / leído) de un mensaje enviado.

---

## Notas

- **Historial**: el servidor guarda los últimos `MAX_MESSAGES_PER_CHAT` mensajes por chat desde que se vincula (más lo que WhatsApp sincronice al conectar). Para marcar un chat como *no leído* WhatsApp necesita conocer el último mensaje, así que chats sin mensajes guardados devuelven `409`.
- **IDs `@lid`**: WhatsApp está migrando a identificadores privados (`...@lid`). Algunos chats pueden aparecer con ese formato; usá el `chatId` tal cual te lo devuelve `/api/chats`.
- Si WhatsApp cambia el protocolo y deja de conectar, actualizá Baileys: `npm update baileys` y redeploy.
