FROM node:22-slim

# git es necesario: Baileys instala libsignal desde GitHub
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/index.js"]
