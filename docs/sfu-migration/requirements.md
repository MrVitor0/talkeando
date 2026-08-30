# Requirements — Migração para SFU (LiveKit)

Formato: cada requisito tem um ID estável (`SFU-FR-###` funcional, `SFU-NFR-###`
não-funcional). Critérios de aceite em estilo EARS ("QUANDO … O SISTEMA DEVE …").
Os passos em `implementation.md` referenciam esses IDs.

Glossário: **room** = canal de voz no LiveKit (nome = `channel_id`). **token** =
JWT de acesso assinado pelo `tupi-server`. **backend de mídia** = `mesh` (atual)
ou `livekit` (alvo). Esta migração é uma substituição limpa: sem flag, sem coexistência — o mesh sai nesta passada.

---

## A. Autorização e entrada na call

### SFU-FR-001 — Token de acesso emitido pelo servidor
O `tupi-server` DEVE expor `POST /api/livekit/token`. QUANDO um usuário
autenticado pede um token para `channel_id` e É membro da comunidade daquele
canal `voice`, O SISTEMA DEVE responder `{ url, token, room }` com um JWT válido
cujo grant tem `room = channel_id`, `roomJoin = true`, `canSubscribe = true`,
`identity = <user_id>`, `name = <display_name>`.
- QUANDO o canal não é `voice` OU o usuário não é membro, O SISTEMA DEVE
  responder `403`.
- QUANDO `mode = "participant"` (default), o grant DEVE ter `canPublish = true`,
  `hidden = false`.
- QUANDO `mode = "spectator"`, o grant DEVE ter `canPublish = false`,
  `hidden = true`.
- O token DEVE expirar em `LIVEKIT_TOKEN_TTL_SECONDS` (default `21600`).

### SFU-FR-002 — Bot autoriza-se pela mesma porta
QUANDO o `music-bot` precisa entrar numa room, O SISTEMA DEVE permitir que ele
obtenha um token (via `POST /api/livekit/token` autenticado com o
`MUSIC_BOT_TOKEN`, OU mintando localmente com `LIVEKIT_API_KEY/SECRET`). O
`identity` do bot DEVE ser `00000000-0000-0000-0000-000000000001`
(`MUSIC_BOT_ID`).

### SFU-FR-003 — Permissão é sempre do `tupi-server`
O LiveKit NÃO DEVE ser fonte de decisão de "quem pode entrar". Toda checagem de
membership/permissão DEVE acontecer no `tupi-server` antes de emitir o token. O
cliente NUNCA recebe `LIVEKIT_API_SECRET`.

---

## B. Ciclo de vida da room / roster

### SFU-FR-010 — Webhook alimenta o estado da call
O `tupi-server` DEVE expor `POST /api/livekit/webhook`, verificar a assinatura
com `LIVEKIT_API_SECRET`, e tratar `participant_joined`, `participant_left`,
`track_published`, `track_unpublished`, `room_finished`. QUANDO um evento chega,
O SISTEMA DEVE atualizar o `CallRegistry` (espelho leve do estado da room).

### SFU-FR-011 — Roster continua vindo do `tupi-server`
QUANDO o `CallRegistry` muda por webhook, O SISTEMA DEVE emitir `voice.roster`
(canal específico) e manter `voice.rooms` (snapshot por-conexão no
`auth`/`bootstrap`) para a comunidade inteira, com o mesmo shape de payload de
hoje. O cliente NÃO fala com o LiveKit para descobrir salas de outros canais.

### SFU-FR-012 — Participantes da call vêm dos eventos da room
Dentro da call em que o cliente está, o roster/tiles DEVEM ser derivados dos
eventos do `Room` do LiveKit (`ParticipantConnected`/`Disconnected`,
`TrackSubscribed`/`Unsubscribed`). Os ops WS `call.join` / `call.leave` /
`call.snapshot` / `call.peer_joined` / `call.peer_left` DEIXAM de existir — a
sidebar de "quem está em qual canal de voz" usa apenas `voice.roster` /
`voice.rooms`.

### SFU-FR-013 — Mover / desconectar membro
`voice.move_member` DEVE continuar funcionando: o alvo recebe `voice.moved` e
reconecta com um token da nova room. `voice.disconnect_member` DEVE chamar a
`RoomService.RemoveParticipant` do LiveKit (humano) e o reset do bot
(`music.command stop`) como hoje.

### SFU-FR-014 — Bot sai quando o último humano sai
QUANDO o último participante não-bot deixa a room (webhook `participant_left`
resultando em roster só com o bot, OU `room_finished`), O SISTEMA DEVE mandar
`music.command stop` para o bot. NÃO DEVE tirar o bot quando quem rodou `/play`
sai mas outros humanos permanecem.

---

## C. Voz e câmera

### SFU-FR-020 — Voz via SFU
Cada participante DEVE publicar 1 track
`microphone` e assinar automaticamente os tracks `microphone` dos demais. Mute
local DEVE ser `setMicrophoneEnabled(false)` sem renegociação visível.

### SFU-FR-021 — RNNoise preservado
O RNNoise (`noiseSuppression.ts`) DEVE continuar sendo aplicado ao mic ANTES da
publicação do track. O SFU não toca no conteúdo do áudio.

### SFU-FR-022 — Deafen
QUANDO o usuário fica "surdo", O SISTEMA DEVE deixar de reproduzir/assinar o
áudio dos demais (comportamento local), sem afetar a publicação do próprio mic.

### SFU-FR-023 — Câmera via SFU com simulcast
QUANDO um participante liga a câmera, O SISTEMA DEVE publicar 1 track `camera`
com simulcast. Assinatura é automática para os demais participantes.

### SFU-FR-024 — Speaking e qualidade vêm do SFU
"Quem está falando" DEVE vir de `RoomEvent.ActiveSpeakersChanged`; a qualidade de
conexão de `RoomEvent.ConnectionQualityChanged`. A amostragem local via
`getStats()` DEVE ser removida no backend `livekit`.

---

## D. Tela (compartilhamento)

### SFU-FR-030 — Publicação da tela
QUANDO um usuário compartilha a tela, O SISTEMA DEVE capturar via a ponte nativa
existente (GDI → shared buffer, inalterada) e publicar um track `screen_share`
com `simulcast` + `dynacast`. QUANDO há áudio de sistema, DEVE publicar também
um track `screen_share_audio` separado.

### SFU-FR-031 — Invariante "0 viewers ⇒ 0 bytes"
QUANDO ninguém assina o track de tela de um publisher, O SISTEMA DEVE fazer o
publisher parar de enviar (via `dynacast` do LiveKit). QUANDO ≥1 assinante
existe, a mídia flui.

### SFU-FR-032 — Assistir / parar de assistir
O toggle "assistir" DEVE ser `publication.setSubscribed(true/false)`. QUANDO um
assinante para e volta a assinar, O SISTEMA DEVE reentregar o vídeo sem exigir
recompartilhamento pelo dono (o bug "não consigo reassistir" NÃO DEVE ocorrer).

### SFU-FR-033 — Newcomer no meio da tela
QUANDO um participante entra numa call onde já há tela sendo compartilhada e
assina, O SISTEMA DEVE entregar o vídeo em ≤2 s (keyframe servido pelo SFU), SEM
causar corte/glitch para os assinantes que já estavam recebendo.

### SFU-FR-034 — Áudio da tela independente do mic
O mute/volume do áudio da tela DEVE ser independente do mic do mesmo usuário
(mantém o comportamento já corrigido no `rtc.ts`: sink separado por dono,
persistido em `tk.screenVolumes`).

### SFU-FR-035 — Simulcast por tamanho de tile
QUANDO um assinante exibe a tela num tile pequeno, O SISTEMA DEVE receber uma
camada de resolução menor; em tela cheia, a camada alta (`adaptiveStream` do
LiveKit).

### SFU-FR-036 — Hover-preview / spectate
QUANDO um usuário faz hover-preview de uma tela num canal que ele NÃO entrou, O
SISTEMA DEVE conectá-lo à room como participant `hidden` (não aparece no roster)
assinando só o track de tela. Ao sair do preview, DEVE desconectar. Se
`hidden` provar inviável, esta é a única feature que PODE ser degradada para
"só quem está na call vê preview" (decisão de produto em `risks.md#5`).

---

## E. Bot de música

### SFU-FR-040 — Bot publica 1 track no SFU
O bot DEVE conectar à room `channel_id` e publicar **um** track de áudio
alimentado pelo feeder de 10 ms existente. O SFU faz o fan-out. O bug "só alguns
ouvem" NÃO DEVE ocorrer.

### SFU-FR-041 — Pipeline de áudio preservado
A fila, o provider chain, yt-dlp/ffmpeg, o feeder de 10 ms, o scorer e o
`MusicStatusReporter` DEVEM permanecer inalterados. Só o **destino** do PCM muda
(SDK do LiveKit em vez de `@roamhq/wrtc`).

### SFU-FR-042 — `music.command` / `music.status` inalterados
Os ops `music.command` (server→bot) e `music.status` (bot→server) e a persistência
do card como `chat.message.created` DEVEM continuar funcionando sem mudança.

### SFU-FR-043 — Newcomer ouve o bot
QUANDO alguém entra numa call onde o bot já toca, O SISTEMA DEVE fazer essa
pessoa ouvir a música (assinatura automática do track do bot).

---

## F. Remoção do mesh (na mesma passada)

> Substituição limpa: não há flag, não há coexistência. O código abaixo sai
> nesta migração.

### SFU-FR-050 — Sinalização RTC removida
O SISTEMA DEVE remover do `tupi-server`: `relay_rtc`, os ops `rtc.offer` /
`rtc.answer` / `rtc.ice` / `rtc.connection_state` / `rtc.turn_credentials`
(`.request`), e os ops `stream.subscribe` / `stream.subscription_requested` /
`stream.unsubscribe` / `stream.unsubscribed` / `stream.publish` /
`stream.published` / `stream.unpublish` / `stream.unpublished`. `routes/turn.rs`
DEVE ser removido. `call.join` / `call.leave` / `call.snapshot` /
`call.peer_joined` / `call.peer_left` DEVEM ser removidos. Os TURN env
(`TURN_SHARED_SECRET` etc.) permanecem só se o coturn ainda for referenciado
pelo `livekit.yaml`.

### SFU-FR-051 — Motor de malha removido
`client/ui/src/rtc.ts` (mesh) DEVE ser deletado — a nova camada LiveKit assume o
nome/API. `client/ui/src/nativeMusic.ts`, as exports `playMusic` / `stopMusic` /
`setMusicPaused` e o handler `music.command` no `App.tsx` DEVEM ser deletados.
`client/native/Talkeando.Client/MusicPlayback.cs` e os cases
`music.play` / `music.pcm` / `music.pause` / `music.stop` no `IpcBridge.cs`
DEVEM ser deletados.

### SFU-FR-052 — `@roamhq/wrtc` fora
O `peer` / `offer` / `iceServers` / `restartPeerIce` / `iceRestartTimers` / o
handling `rtc.*` e o reconcile de `call.snapshot` do `music-bot/index.js` DEVEM
ser removidos, junto com a dependência `@roamhq/wrtc` no `package.json`.

### SFU-FR-053 — Testes reescritos, não quebrados
Todo teste que exercitava o mesh (`server/tests/calls_test.rs` casos de
`rtc.offer forbidden` / `stream.subscribe`; `music-bot/test.js` "per-peer track",
"re-announces call membership", "offers music to every listener"; etc.) DEVE ser
reescrito para o modelo SFU ou removido. Nenhuma suíte fica vermelha ou com
teste ignorado por causa da migração.

### SFU-FR-054 — Documentação atualizada
`README.md` (raiz), `protocol/README.md`, e as memórias
`memory/screen-share-architecture.md`, `memory/voice-roster-and-spectate.md`,
`memory/webcam-architecture.md` DEVEM refletir o SFU.

---

## Não-funcionais

### SFU-NFR-001 — Substituição limpa, suítes verdes
A migração é **um commit**. Ao final: `cargo test` (server), `npm test`
(music-bot), `npm run build` (client/ui) e `dotnet build` (native) DEVEM passar.
Não sobra código do caminho mesh (`grep -r "relay_rtc\|@roamhq/wrtc\|rtc.offer"`
sem resultado funcional). Rollback = reverter o commit.

### SFU-NFR-002 — O agente entrega código; o humano aplica a infra
O agente produz todos os arquivos de código e config (compose, `livekit.yaml`,
Caddyfile, CI). Fora do repo, o humano: cria os GitHub Secrets, sobe a Lightsail
para 4 GB, abre a faixa UDP `50000-50200`, roda o deploy. O SDD lista essas
tarefas explicitamente (ver `README.md`).

### SFU-NFR-003 — Recursos na Lightsail
O box DEVE ir para 4 GB antes de rodar em produção. CPU de forward para 10
pessoas + 2 telas + bot DEVE ficar < 1 vCPU. Uso mensal de banda DEVE ser
monitorado; bitrate de tela DEVE ser limitável no `livekit.yaml` / na publicação
(`~2 Mbps`, `720p`–`1080p`).

### SFU-NFR-004 — Portas UDP isoladas
coturn e LiveKit compartilham o host (`network_mode: host`). As faixas UDP DEVEM
ser disjuntas: coturn `49160-49200`, LiveKit `50000-50200`. Documentar em ambos
os arquivos de config.

### SFU-NFR-005 — Segredos só via CI/env
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` e `LIVEKIT_URL` DEVEM vir de GitHub
Secrets do environment `production`, gerados em arquivo no host no deploy (mesmo
padrão de `music-bot.env`). NUNCA no repositório, logs ou payloads para o
cliente.

### SFU-NFR-006 — Dev sobe com um comando
`docker compose up -d postgres livekit` (dev) DEVE deixar o SFU pronto local,
com `livekit.dev.yaml` versionado (key/secret de dev fixos e marcados como
dev-only). Assim o agente consegue rodar o build/teste do `client/ui` contra um
LiveKit real se precisar.

### SFU-NFR-008 — Latência aceitável
O hop extra pelo SFU (vs. P2P direto em calls pequenas) É aceito. Meta informal:
mediana de latência de voz ≤ 150 ms na região SP.
