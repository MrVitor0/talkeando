# 🦜 Talkeando (Tupi)

> **High-Performance, Self-Hosted Real-Time Voice, Video & Text Community Platform**

[![Rust](https://img.shields.io/badge/backend-Rust%20%7C%20Axum-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/frontend-React%20%7C%20TypeScript-blue.svg)](https://reactjs.org/)
[![.NET](https://img.shields.io/badge/desktop-.NET%206%20WPF-purple.svg)](https://dotnet.microsoft.com/)
[![WebRTC](https://img.shields.io/badge/media-WebRTC%20Mesh-green.svg)](https://webrtc.org/)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

Talkeando is a modern, privacy-focused, Discord-inspired community platform designed for high fidelity, ultra-low latency communication. It combines a blazing fast Rust backend, an interactive React frontend, and a native Windows desktop client with native game capture, AI noise reduction, push-to-talk, and an integrated YouTube music bot.

---

## ✨ Features

- 🎙️ **Ultra-Low Latency Voice Chat**: Peer-to-peer WebRTC audio mesh with RNNoise ML noise suppression and automatic gain control.
- ⌨️ **Push-to-Talk (PTT) & Voice Modes**: Switch between Voice Activity, Push-to-Talk (with custom keybindings and silent operation), or Toggle mode.
- 🖥️ **Fullscreen Game & Screen Sharing**: High-FPS screen capture (including borderless/fullscreen games) with dedicated system loopback audio.
- 📹 **Live Webcams & Video Stages**: Synchronized video tiles with camera previews and device selectors.
- 🎵 **Integrated YouTube Music Bot**: Stream high-quality 48kHz audio directly into voice channels via chat commands (`/play`, `/pause`, `/resume`, `/stop`).
- ⚙️ **Audio & Video Settings**: Seamless in-app input/output device switching (`setSinkId`), per-user volume boost, and live microphone testing.
- 💬 **Rich Text Channels & Media**: Markdown support, Discord-compatible emojis, rich embeds, and instant file attachments.
- 🔄 **In-App Auto-Updates**: Seamless background download and one-click silent installer restart.
- 🛡️ **Secure Session Storage**: Uses Windows DPAPI to securely store session tokens locally on the client.

---

## 🏗️ Architecture

```
talkeando/
├── client/
│   ├── native/
│   │   ├── Talkeando.Client/       # .NET 6 WPF native shell & WebView2 host
│   │   └── Talkeando.Client.Tests/ # Unit tests (DPAPI, IPC, updater)
│   └── ui/                         # React 18 + TypeScript + Vite UI bundle
├── server/                         # Rust (Axum, Tokio, SQLx, WebSocket signaling)
├── music-bot/                      # Node.js + yt-dlp + ffmpeg + wrtc music streaming bot
├── infra/                          # Docker Compose definitions (PostgreSQL, coturn, production)
├── scripts/                        # Development helpers, build scripts & Discord importer
└── SDD/                            # System Design Documents and Architecture Decisions (ADRs)
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites

Ensure you have the following installed on your machine:
- **Rust** (`cargo` 1.75+)
- **.NET 6 SDK** (or later)
- **Node.js** (v18+) & **npm**
- **Docker** & **Docker Compose** (for PostgreSQL)

---

### 1. Start PostgreSQL Database

```bash
cd infra
docker compose up -d postgres
```
*Postgres is mapped to port `5434` to avoid collisions with local default instances.*

---

### 2. Configure & Launch the Backend

```bash
cd server
cp .env.example .env
```

Bootstrap the initial owner account and community:
```bash
cargo run --bin talkeando-server -- bootstrap-owner --username admin --password adminpass123 --display-name Admin
```

Start the API and WebSocket server:
```bash
cargo run --bin talkeando-server
```
*The server listens on `http://127.0.0.1:8080` by default.*

---

### 3. Build the Web UI

```bash
cd client/ui
npm install
npm run build
```

---

### 4. Run the Native Desktop Client

```bash
cd client/native/Talkeando.Client
dotnet run
```

---

## 🧪 Running Tests

### Backend Unit & Integration Tests
```bash
cd server
cargo test
```

### Native Client Tests
```bash
cd client/native/Talkeando.Client.Tests
dotnet test
```

---

## 📦 Production Deployment

Production deployments are orchestrated via Docker Compose:

```bash
cd infra
docker compose -f docker-compose.production.yml up -d --build
```

Services included:
- `tupi-server`: Production Rust backend binary.
- `tupi-music-bot`: Containerized music bot with `yt-dlp` and `ffmpeg`.
- `coturn`: TURN/STUN server for WebRTC NAT traversal.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!
Feel free to open an issue or submit a pull request.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
