# Contrato IPC nativo ↔ UI v1

Status: Normativo
Fonte: `05-client-architecture.md` e `specs/auth.md`, `audio.md`,
`rtc-signaling.md`, `screen-share.md`.

Envelope bidirecional: `{ "v": 1, "op": "namespace.action", "data": {} }`.
React usa `window.chrome.webview.postMessage`; o host responde com
`PostWebMessageAsJson`. Token é write-only para a UI.

| Op | Direção | Data |
|---|---|---|
| `auth.persist_token` | UI→Native | `{ token }` |
| `auth.clear_token` | UI→Native | `{}` |
| `auth.state_changed` | Native→UI | `{ state: "logged_out"|"connecting"|"logged_in", user? }` |
| `rtc.peer.create` | UI→Native | `{ peer_user_id, polite }` |
| `rtc.peer.close` | UI→Native | `{ peer_user_id }` |
| `rtc.peer.handle_offer` | UI→Native | `{ peer_user_id, sdp }` |
| `rtc.peer.handle_answer` | UI→Native | `{ peer_user_id, sdp }` |
| `rtc.peer.handle_ice` | UI→Native | `{ peer_user_id, candidate }` |
| `rtc.peer.connection_state_changed` | Native→UI | `{ peer_user_id, state }` |
| `audio.set_muted` | UI→Native | `{ muted }` |
| `audio.set_deafened` | UI→Native | `{ deafened }` |
| `audio.set_input_device` | UI→Native | `{ device_id }` |
| `audio.set_output_device` | UI→Native | `{ device_id }` |
| `audio.capture_error` | Native→UI | `{ code: "permission_denied"|"no_device" }` |
| `audio.local_speaking_changed` | Native→UI | `{ speaking }` |
| `audio.peer_speaking_changed` | Native→UI | `{ peer_user_id, speaking }` |
| `screen.enumerate_sources` | UI→Native | `{}` |
| `screen.sources` | Native→UI | `{ sources: [{ id, type, title, thumbnail_png_base64 }] }` |
| `screen.publish_start` | UI→Native | `{ source_id }` |
| `screen.publish_stop` | UI→Native | `{}` |
| `screen.source_ended` | Native→UI | `{ source_id }` |
| `error` | Native→UI | `{ code, message }` |

O host valida o payload e nunca executa uma operação RTC ou de captura a
partir de dados não reconhecidos.

