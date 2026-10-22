# Sistem Panggil Balik Sekolah" App

A real-time TV call display and spoken announcement system controlled by parents from a Telegram group. Built with Node.js (TypeScript), Express, WebSockets, SQLite, and Google Cloud Text-to-Speech (Free Tier guarded).

---

## 1. Creating the Telegram Bot with BotFather

1. Open Telegram and message **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to name your bot (e.g., `KlinikCeriaCallBot`).
3. Copy the **HTTP API Token** and paste it into `.env` as `TELEGRAM_BOT_TOKEN`.
4. **Disable Privacy Mode** (required if you want the bot to read plain-text names in the group):
   - Send `/mybots` to `@BotFather` -> select your bot -> **Bot Settings** -> **Group Privacy** -> **Turn off**.
5. Add the bot to your parents' Telegram group and promote it or make sure it can read and send messages.
6. Send `/help` in the group. The bot will display the **Current Chat ID** (a negative number like `-1001234567890`). Add this ID to `ALLOWED_CHAT_IDS` in `.env`.

---

## 2. Step-by-Step Google Cloud Text-to-Speech Setup (Free Tier Safe)

Google Cloud TTS gives **1,000,000 characters/month FREE for WaveNet voices** and **4,000,000 characters/month FREE for Standard voices**. This app enforces Standard/WaveNet voices only, caches all generated MP3s on disk, and cuts off at 800,000 characters/month by default.

1. **Create a Project**:
   - Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (e.g., `clinic-tts`).
2. **Enable Billing (Required even for the Free Tier)**:
   - Link a billing account under **Billing**. You will not be charged as long as usage stays inside the monthly free tier.
3. **Set a RM5 Budget Alert**:
   - Go to **Billing -> Budgets & alerts -> Create Budget**.
   - Set the target amount to **MYR 5.00** (RM5) with email notifications at 50%, 90%, and 100%.
4. **Enable the Cloud Text-to-Speech API**:
   - Go to **APIs & Services -> Library**, search for **Cloud Text-to-Speech API**, and click **Enable**.
5. **Create Restricted Credentials (API Key or Service Account)**:
   - **Option A (API Key - Simplest)**:
     1. Go to **APIs & Services -> Credentials -> Create Credentials -> API key**.
     2. Click **Edit API key** -> under **API restrictions**, select **Restrict key** and check **only** `Cloud Text-to-Speech API`. Save.
     3. Paste the key into `.env` as `GOOGLE_TTS_API_KEY`.
   - **Option B (Service Account JSON)**:
     1. Go to **IAM & Admin -> Service Accounts -> Create Service Account**.
     2. Grant no broad roles (TTS synthesize only requires project authentication) -> **Keys -> Add Key -> Create new key (JSON)**.
     3. Save the file as `google-credentials.json` and set `GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json` in `.env`.

---

## 3. Running on Windows, Linux, or Raspberry Pi

### Quick Start (with Demo Mode — no Telegram or Google key needed to test!)
```bash
cp .env.example .env
npm install
npm run demo
