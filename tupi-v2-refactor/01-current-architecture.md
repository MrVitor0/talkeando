# 01 — Arquitetura atual (como o sistema funciona hoje)

Tudo aqui foi lido no código em `main` (commit `76e10a6`). Cada afirmação tem
arquivo:linha. Nada foi inferido de documentação.

## 1. Componentes e processos

| Processo | Onde | Papel |
|---|---|---|
| `tupi-server` (Rust/axum) | `server/`, container em `infra/docker-compose.production.yml:4` | REST, WebSocket de controle, emissão de token LiveKit, recepção de webhook, registro efêmero de calls |
| `livekit-server` v1.9.12 | `infra/docker-compose.production.yml:86`, `network_mode: host` | SFU: toda a mídia (voz, câmera, tela, áudio de tela, música) |
| `music-bot` (Node) | `music-bot/index.js` | Publica 1 track de áudio no LiveKit; controlado por `music.command` no WS |
| `caddy` | `infra/Caddyfile.example` | TLS + proxy de `/api`, `/ws` e do domínio do SFU |
| `coturn` | `infra/docker-compose.production.yml:66` | TURN externo; portas 49160-49200 (LiveKit usa 50000-50200) |
| Cliente nativo (WPF/WebView2) | `client/native/Talkeando.Client` | Dono do token de sessão, do WebSocket, da captura de tela GDI/WGC e do updater Velopack |
| UI (React) | `client/ui/src` | Dona do `Room` do LiveKit (`livekit-client` 2.22.1), do estado visual e de toda a lógica de call |

Infra: Lightsail 2 GB, sa-east-1. Note que `docs/sfu-migration/README.md`
listava "subir a Lightsail de 2 GB → 4 GB" como tarefa humana pós-migração;
isso não foi feito. A v2 precisa caber em 2 GB.

## 2. Onde vive "quem está em qual canal"

Existem **quatro** cópias desse estado hoje, sem hierarquia declarada.

### Cópia 1 — LiveKit (a mídia real)

Sala = `channel_id` (string UUID). Identidade do participante = `user_id`
(`server/src/routes/livekit.rs:24` monta o token com `identity = user_id`).
É a única cópia que determina quem realmente ouve quem. O servidor a consulta
por `ListRooms` + `ListParticipants` em `server/src/livekit.rs:325`.

### Cópia 2 — `CallRegistry` no servidor (em memória, um processo)

`server/src/ws/call_registry.rs:64`. `HashMap<ChannelId, ActiveCall>`, com
`participants: HashMap<UserId, ParticipantState>` e
`streams: HashMap<StreamId, PublishedStream>`.
Fica dentro do `Hub` sob um `RwLock` (`server/src/ws/hub.rs:19`). Nada é
persistido: um restart do container zera tudo.

Escritores desse mapa, todos concorrentes entre si e sem ordenação:

| Escritor | Arquivo:linha | Gatilho |
|---|---|---|
| Webhook `participant_joined` / `participant_left` | `server/src/routes/livekit.rs:45-46` | LiveKit |
| Webhook `track_published` / `track_unpublished` | `server/src/routes/livekit.rs:47-48` | LiveKit |
| Webhook `room_finished` | `server/src/routes/livekit.rs:53` (`clear_channel`) | LiveKit |
| `voice.presence.enter` | `server/src/ws/handler.rs:574-581` | cliente |
| `voice.presence.leave` | `server/src/ws/handler.rs:591-592` | cliente |
| `voice.track.published` / `unpublished` | `server/src/ws/handler.rs:601-625` | cliente |
| Desconexão do WS, após 8 s | `server/src/ws/handler.rs:234-236` | servidor |
| `voice.disconnect_member` | `server/src/ws/handler.rs:1510` | outro cliente |
| `call.state.update` (mute/deafen) | `server/src/ws/handler.rs:1379-1382` | cliente |
| `stream.publish` / `unpublish` (só música) | `server/src/ws/handler.rs:1257`, `:1279` | bot |
| Reconcile periódico (15 s) e por conexão | `server/src/ws/handler.rs:1325`, agendado em `server/src/main.rs:182` | timer |
| Exclusão de canal | `server/src/routes/channels.rs:288` | REST |

### Cópia 3 — `voiceRooms` / `voiceRoomStreams` na UI

`client/ui/src/App.tsx:1055` e `:1058`. Alimentados por dois eventos:
`voice.rooms` (snapshot, `App.tsx:1359`) e `voice.roster` (delta por canal,
`App.tsx:1364`). Um `voice.roster` com lista vazia apaga a chave inteira
(`App.tsx:1375`).

### Cópia 4 — `call` (a call em que estou) na UI

`client/ui/src/App.tsx:1049`. É definida otimisticamente em `joinCall`
(`App.tsx:2142`) e depois sobrescrita pelo `voice.roster` do próprio canal
(`App.tsx:1380-1383`). O `Room` do LiveKit tem seu próprio
`remoteParticipants`, que a UI **não consulta** para montar a lista de
participantes.

Consequência estrutural: a lista que a UI mostra (`call.participants`) e a
lista de quem a UI realmente ouve (`room.remoteParticipants`) são calculadas
por caminhos independentes que podem divergir indefinidamente. Esse é o
esqueleto do sintoma 1.

## 3. Protocolo de sinalização (estado atual)

Envelope: `{ "v": 1, "op": "<ns>.<ação>", "data": {...} }`
(`server/src/ws/protocol.rs:9-23`; schema em
`protocol/websocket-envelope.schema.json`).

### Inbound relevantes para voz

| op | Payload | Validação | Efeito |
|---|---|---|---|
| `auth.hello` | `{token}` | 10 s de janela (`handler.rs:55`) | autentica; não carrega versão de cliente |
| `voice.presence.enter` | `{channel_id}` | membro + canal `voice` (`handler.rs:555-559`) | evicta canais anteriores desta conexão, insere participante, broadcast |
| `voice.presence.leave` | `{channel_id}` | nenhuma | remove participante do canal, broadcast |
| `voice.rooms.request` | `{}` | nenhuma | reenvia snapshot para esta conexão |
| `voice.track.published` | `{channel_id, source, track_sid?}` | exige `joined_calls.contains` (`handler.rs:604`) | marca stream |
| `voice.track.unpublished` | idem | **sem validação alguma** (`handler.rs:615`) | desmarca stream |
| `call.state.update` | `{channel_id, muted?, deafened?}` | precisa ser participante | atualiza e faz broadcast |
| `voice.move_member` | `{user_id, channel_id}` | owner e alvo já em alguma call | manda `voice.moved` ao alvo |
| `voice.disconnect_member` | `{user_id, channel_id}` | owner (humano) ou membro (bot) | `RemoveParticipant` + evict |
| `stream.publish` / `unpublish` | ver protocolo | só bot, `kind == "music"` | linha de música do roster |

### Outbound relevantes

| op | Payload | Destinatários |
|---|---|---|
| `voice.rooms` | `{rooms: [{channel_id, participants, streams}]}` | uma conexão |
| `voice.roster` | `{channel_id, participants, streams}` | comunidade inteira (`handler.rs:1226`) |
| `call.state.update` | `{channel_id, user_id, muted, deafened}` | participantes da call |
| `voice.moved` | `{channel_id, moved_by}` | só o alvo |
| `voice.disconnected` | `{channel_id, by}` | só o alvo |

Nenhuma mensagem carrega número de sequência, versão de estado, timestamp ou
`participant_sid`. Não há ACK. Uma mensagem perdida é perdida em silêncio, e
nada no sistema detecta a perda.

### Ordem esperada versus ordem real

O cliente faz `room.connect()` **antes** de `voice.presence.enter`
(`client/ui/src/rtc.ts:290` e `:301`). O webhook `participant_joined` sai do
LiveKit em paralelo. Portanto o servidor recebe dois eventos "eu entrei" em
ordem arbitrária, e ambos escrevem no mesmo mapa sem coordenação. O mesmo vale
para a saída: `voice.presence.leave` (`rtc.ts:279`, `:325`) e o webhook
`participant_left` correm um contra o outro.

## 4. Ciclo de vida da conexão

### WebSocket (nativo)

`client/native/Talkeando.Client/NetworkClient.cs:331` conecta e envia
`auth.hello`. Reconexão com backoff em `:454`, single-flight por `_reconnecting`
(`:449`) e geração por socket (`:439`). Publica `connection.state` igual a
`connected`, `reconnecting` ou `disconnected` para a UI.

Servidor: heartbeat de 15 s e timeout de 60 s
(`server/src/ws/handler.rs:23-24`). Ao cair o último socket do usuário, uma
task espera 8 s (`handler.rs:222`) e então **evicta o usuário de todos os
canais em `joined_calls`** (`handler.rs:234-236`), mesmo que o LiveKit ainda o
tenha na sala e o áudio dele continue fluindo.

### LiveKit (UI)

`client/ui/src/rtc.ts:282` cria `new Room({ adaptiveStream: true, dynacast: true })`.
Reconexão é interna do SDK (política padrão `DEFAULT_RETRY_DELAYS_IN_MS`, dez
tentativas). `RoomEvent.Disconnected` (`rtc.ts:214`) dispara
`voice.presence.leave` e `callEnded`, sem distinguir o motivo
(`CLIENT_INITIATED`, `DUPLICATE_IDENTITY`, `SERVER_SHUTDOWN`,
`PARTICIPANT_REMOVED` e outros existem no SDK, ver
`livekit-client.esm.mjs:3927-3959`).

### Reanúncio pós-reconexão do WS

`rtc.ts:249` (`restoreControlPlanePresence`) reenvia `voice.presence.enter` e
os `voice.track.published` das publicações locais quando `connection.state`
volta a `connected` (`rtc.ts:267-271`).

### Fechamento abrupto do app

`MainWindow.Closed` chama `_bridge.Dispose()`
(`client/native/Talkeando.Client/MainWindow.xaml.cs:61`), que descarta hotkey,
captura e monitor de atividade (`IpcBridge.cs:526`). Não fecha o WebSocket com
um frame `Close` nem desconecta o `Room` do LiveKit de forma ordenada. O
servidor descobre pelo heartbeat (até 60 s) e o LiveKit pelo seu próprio
timeout.

### Múltiplas sessões do mesmo usuário

`Hub::register` guarda `HashMap<Uuid /*user*/, HashMap<Uuid /*conn*/, ConnHandle>>`
(`hub.rs:18`), então dois sockets do mesmo usuário coexistem. Mas o LiveKit
rejeita identidade duplicada na mesma sala (`DUPLICATE_IDENTITY`), e o
`CallRegistry` é indexado só por `user_id`, sem distinguir instância.

## 5. Ciclo de vida de transport e track

### Publicação

- Microfone: `rtc.ts:304-313`, via `AudioPipelineManager`
  (`client/ui/src/audioPipeline.ts:179`), publicado com
  `source: Track.Source.Microphone`.
- Câmera: `rtc.ts:349-355` (`setCameraEnabled(true)`).
- Tela: `rtc.ts:366-374`. `startNativeScreen` cria um `<canvas>` e usa
  `captureStream(fps)` (`client/ui/src/nativeScreen.ts:135-155`); o áudio de
  sistema vira um `MediaStreamTrackGenerator` (`nativeScreen.ts:119`). Ambos
  são publicados com `ScreenShare` e `ScreenShareAudio`.
- Parada de tela: `rtc.ts:375-382` (`unpublishTrack` mais `stopNativeScreen`).

### Assinatura

`watchStream` (`rtc.ts:394`) grava a intenção em `wantedScreens` e chama
`publication.setSubscribed(true)`. `RoomEvent.TrackPublished` (`rtc.ts:177`)
reaplica a intenção quando a publicação chega depois.
`stopWatchingStream` (`rtc.ts:400`) faz `setSubscribed(false)` e apaga a
intenção.

### Renderização

`RoomEvent.TrackSubscribed` (`rtc.ts:181`) faz `track.attach()`, esconde o
elemento com `style.display = "none"` e o anexa ao `body`; para vídeo, emite
`onRemoteStream(identity, new MediaStream([track.mediaStreamTrack]), trackSid)`.
A UI guarda isso em `remoteVideos` (`App.tsx:1752`) e monta um `<video>`
próprio (`App.tsx:612-616`) com `srcObject`.

### Spectator

`rtc.ts:404`: se não há `active`, cria um segundo `Room` com token
`mode: "spectator"` e o atribui a `active`. `stopSpectate` (`rtc.ts:405`) é uma
função vazia que não desconecta nada.

## 6. Estado React da UI

`App.tsx` tem cerca de 4200 linhas e um único `useEffect` de assinatura de
eventos (`App.tsx:1251-1550`) com dependência `[activeChannel?.id]`, ou seja,
o listener é destruído e recriado a cada troca de canal.

Fontes da lista de participantes exibida:

- sidebar por canal: `voiceRooms[channel.id]` mais injeção otimista do próprio
  usuário (`App.tsx:3074-3084`);
- palco da call: `voiceParticipants` (`App.tsx:2629`), derivado de
  `call.participants`, que vem de `voice.roster`.

Estado otimista existe em `joinCall` (`App.tsx:2142`, participantes vazios),
`leaveCall` (`App.tsx:2198`, limpa tudo), `watching` (`App.tsx:2365`) e
`mySharingStreamId` (`App.tsx:2269`). Não há reconciliação explícita contra o
servidor além do próximo `voice.roster` que chegar.

## 7. Detecção de desconexão

| Camada | Mecanismo | Tempo até detectar |
|---|---|---|
| WS servidor para cliente | Ping a cada 15 s, timeout 60 s | até 60 s |
| Presença (online/offline) | grace de 8 s após o último socket | 8 s |
| Voz (roster) | evict imediato no fim do grace de 8 s | 8 s |
| LiveKit para servidor | webhook `participant_left` | best-effort, sem retry visível |
| Reconcile de segurança | `ListRooms` e `ListParticipants` a cada 15 s | até 15 s |
| Reconcile por conexão | throttle de 5 s (`server/src/state.rs:480`) | por conexão |

## 8. Auto-update e version skew

`UpdateChecker` usa Velopack contra um feed privado
(`client/native/Talkeando.Client/UpdateChecker.cs:356`, URL do feed em `:423`).
`ApplyUpdatesAndRestart` (`UpdateChecker.cs:417`) encerra o processo atual e
reinicia. Isso ocorre enquanto a call pode estar ativa e sem nenhum teardown de
voz. O check de startup roda 3,5 s após o boot (`IpcBridge.cs:508`) e a UI
oferece o botão; não há check periódico.

Skew: o cliente ignora `error` com `code == "unknown_op"` (`App.tsx:1542`), mas
o servidor não sabe a versão do cliente e nenhum payload é versionado. Um
cliente novo falando com servidor antigo recebe `unknown_op`; um cliente antigo
com servidor novo simplesmente ignora campos que não conhece, o que hoje é
acidental, não projetado.

## 9. Testes existentes

- Servidor: `server/tests/` cobre auth, chat, presença, anexos, atividade e
  música. **Zero** testes de `voice.*`, do webhook, ou do `CallRegistry` além
  dos quatro unitários de `reconcile` (`call_registry.rs:584-649`).
- UI: apenas `client/ui/src/audioPipeline.test.ts`.
- Integração manual: `integration/sfu/run.cjs`, fora do CI, exige contas reais
  e LiveKit local.
