FROM node:22-bookworm-slim

# Install build tools required for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build

VOLUME ["/app/data", "/app/cache/tts"]
EXPOSE 3000

CMD ["npm", "start"]