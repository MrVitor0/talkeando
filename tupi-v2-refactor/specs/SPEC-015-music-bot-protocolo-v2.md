# SPEC-015 — Music bot alinhado ao protocolo v2

## 1. Problema

O bot (`music-bot/index.js`) fala o dialeto v1 e reproduz alguns dos mesmos
padrões que causaram os bugs no cliente principal:

- `join` chama `send("voice.presence.enter", ...)` sem `participant_sid`
  (`music-bot/index.js:101`, `:110`), então fica sempre provisório no registry
  v2 e depende do webhook para ser confirmado;
- `leaveVoice` chama `send("voice.presence.leave", ...)` e
  `livekitRoom?.disconnect()` (`:801-802`, `:813-814`), sem esperar a
  desconexão, o mesmo padrão que causou RC-09 no cliente;
- `joinLiveKit` faz `livekitRoom?.disconnect()` sem `await` (`:104`) antes de
  criar a sala nova;
- o comentário em `join` (`:793-797`) ainda descreve o fluxo de mesh
  (`call.peer_joined`, `call.snapshot`), que não existe mais;
- `stream.publish` / `stream.unpublish` continuam sendo o mecanismo da linha
  "TOCANDO" (`:494`, `:501`), que é a exceção documentada a INV-B1.

**Causas raiz:** RC-05 (lado bot), e as mesmas classes de RC-09 e RC-10 no
processo do bot.

**Sintomas que desaparecem:** o bot sumindo da sidebar após um redeploy ou um
blip de rede, e a música parando ao trocar o bot de canal.

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** SPEC-005 (servidor aceita as ops v2).

Pode ser executada em paralelo com as specs de cliente: o bot é um processo
independente e o servidor aceita os dois dialetos.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `music-bot/index.js` | editar: handshake, join, leave, dicas com sid |
| `music-bot/test.js` | editar: cobrir o novo handshake |
| `music-bot/package.json` | nenhuma mudança |

## 4. Mudança especificada

### 4.1 Handshake

```js
const PROTOCOL_VERSION = 2;
const BOT_VERSION = require("./package.json").version;
let serverFeatures = new Set();

// em connect():
ws.on("open", () => {
  wsBackoff = 1000;
  log("ws open — sending auth.hello");
  send("auth.hello", {
    token,
    protocol_version: PROTOCOL_VERSION,
    client_version: BOT_VERSION,
    client_platform: "music-bot",
  });
});

// no handler de auth.ok:
if (e.op === "auth.ok") {
  serverFeatures = new Set(e.data?.features ?? []);
  log(`authenticated as the music bot (protocol ${e.data?.protocol_version ?? 1}, server ${e.data?.server_version ?? "?"})`);
  if (voiceChannel) {
    log(`re-announcing presence in ${voiceChannel} after (re)connect`);
    void rejoinAfterReconnect(voiceChannel);
  }
}
```

`rejoinAfterReconnect` é uma função nova, distinta de `join`: ao reconectar o
WebSocket, a sala do LiveKit provavelmente continua viva, então **não** se deve
desconectar e reconectar a mídia (o que interromperia a música).

```js
/**
 * O WebSocket caiu e voltou, mas a mídia não. Reanunciar presença sem tocar
 * na sala do LiveKit — desconectar aqui interromperia a música para todos.
 */
async function rejoinAfterReconnect(channelId) {
  if (livekitRoom && livekitRoom.isConnected !== false) {
    sendPresenceHint(channelId, "joining", livekitRoom.localParticipant?.sid);
    if (publishedStreamId) {
      send("stream.publish", {
        channel_id: channelId,
        stream_id: publishedStreamId,
        kind: "music",
        label: current?.title ?? null,
        has_audio: true,
      });
    }
    return;
  }
  await join(channelId);
}
```

Verificar em `@livekit/rtc-node` 0.13.34 o nome da propriedade que indica
conexão e o do sid do participante local. Se `isConnected` não existir, usar a
existência de `livekitRoom.localParticipant` como proxy, e se o sid não estiver
acessível, enviar a dica sem ele (o servidor trata como provisório e o webhook
confirma, comportamento correto e já coberto por SPEC-003).

### 4.2 Dicas versionadas

```js
function sendPresenceHint(channelId, state, participantSid) {
  if (serverFeatures.has("voice.hints")) {
    send("voice.presence.hint", {
      channel_id: channelId,
      state,
      participant_sid: participantSid ?? null,
    });
  } else {
    send(state === "joining" ? "voice.presence.enter" : "voice.presence.leave", {
      channel_id: channelId,
    });
  }
}
```

Substituir os quatro usos diretos: `:101`, `:110`, `:801`, `:813`.

### 4.3 `joinLiveKit` com desconexão aguardada

```js
async function joinLiveKit(channelId) {
  if (livekitRoom && voiceChannel === channelId) {
    sendPresenceHint(channelId, "joining", livekitRoom.localParticipant?.sid);
    return;
  }
  // Aguardar de verdade: sem isto, a sala antiga e a nova coexistem por um
  // instante e o LiveKit pode rejeitar por identidade duplicada.
  await disconnectLiveKit();

  const response = await fetch(`${API_URL}/api/livekit/token`, { /* igual a hoje */ });
  if (!response.ok) throw new Error(`LiveKit token request failed (${response.status})`);
  const credentials = await response.json();
  const room = new Room();
  await room.connect(process.env.LIVEKIT_URL || credentials.url || LIVEKIT_URL, credentials.token);
  await room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack("music", musicSource()),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  livekitRoom = room;
  // A dica vai DEPOIS de conectar e publicar, com o sid real: assim o servidor
  // marca o bot como confirmado em vez de provisório (SPEC-003 §4.4).
  sendPresenceHint(channelId, "joining", room.localParticipant?.sid);
}

async function disconnectLiveKit() {
  const room = livekitRoom;
  livekitRoom = null;
  if (!room) return;
  try { await room.disconnect(); }
  catch (error) { log(`livekit disconnect failed: ${error && error.message ? error.message : error}`); }
}
```

Note a inversão de ordem em relação a hoje: `music-bot/index.js:110` envia a
presença **antes** de publicar a track. Enviar depois, com o sid, é o que
permite a confirmação imediata.

### 4.4 `join` e `leaveVoice`

```js
async function join(channelId) {
  if (voiceChannel === channelId) {
    await joinLiveKit(channelId);
    startFeeder();
    return;
  }
  if (voiceChannel) sendPresenceHint(voiceChannel, "leaving", livekitRoom?.localParticipant?.sid);
  await disconnectLiveKit();
  voiceChannel = channelId;
  await joinLiveKit(channelId);
  startFeeder();
}

async function leaveVoice() {
  stopCurrent();
  stopPrepared();
  queue.length = 0;
  unpublishCurrent();
  stopFeeder();
  const channel = voiceChannel;
  const sid = livekitRoom?.localParticipant?.sid;
  voiceChannel = null;
  await disconnectLiveKit();
  if (channel) sendPresenceHint(channel, "leaving", sid);
  paused = false;
  idleSince = 0;
  lastStatusChannelId = null;
}
```

`leaveVoice` passa a ser `async`. Os três chamadores (`:874` no `stop`,
`:918` no watchdog, e o handler de `voice.disconnected` se houver) precisam de
`await` ou `void`. O watchdog roda em `setInterval`, então usar `void
leaveVoice()` lá.

Capturar o sid **antes** de desconectar é essencial: depois da desconexão ele
não existe mais, e a dica sem sid faria o servidor esperar 2 s pelo reconcile.

### 4.5 Limpar o comentário obsoleto

`music-bot/index.js:793-797` descreve `call.peer_joined` e `call.snapshot`, que
não existem desde a migração para SFU. Substituir por:

```js
/**
 * Entra (ou reentra) em um canal de voz. Um reingresso no mesmo canal só
 * reanuncia presença; a sala do LiveKit é preservada para não cortar a música.
 */
```

O comentário de `onEvent` (`:820-821`) sobre "mesh call events (legacy.call_*)"
também sai.

### 4.6 O que **não** muda

- `stream.publish` / `stream.unpublish` com `kind: "music"` continuam como
  estão (`:494`, `:501`). É a exceção documentada a INV-B1
  (`04-invariants.md` INV-B1) e o servidor a preserva no reconcile
  (SPEC-003 §4.4).
- O feeder de PCM, a fila, os provedores e o watchdog de ociosidade ficam
  intocados.
- O backoff de reconexão do WebSocket (`:940-946`) já está correto.

## 5. Contratos de dados

`05-protocol-spec.md` §1.1 (handshake) e §3.1 (dica de presença). O bot é um
cliente como outro qualquer para o servidor.

## 6. Casos de borda a tratar

1. `serverFeatures` vazio (servidor v1 ou com a flag desligada): o bot usa as
   ops v1. Coberto pelo `sendPresenceHint`.
2. Reconexão do WS com a mídia viva: `rejoinAfterReconnect` não toca no
   `livekitRoom`. **A música não pode parar.**
3. Reconexão do WS com a mídia morta: cai no `join` completo.
4. `voice.moved` para outro canal (`:893`): usa `join`, que agora aguarda a
   desconexão. A música é carregada para a sala nova (`publishTrack` com a
   mesma `AudioSource`), comportamento preservado.
5. `localParticipant.sid` indisponível na versão do SDK: dica sem sid, o
   servidor trata como provisório, o webhook confirma. Degradação correta.
6. `disconnect()` que lança: capturado e logado; `livekitRoom` já foi anulado
   antes, então o estado fica consistente.
7. Watchdog disparando `leaveVoice` durante um `join`: as duas funções mexem
   nas mesmas variáveis. Como o bot é single-threaded e o watchdog é um
   `setInterval`, a intercalação ocorre nos `await`. Aceito: o pior caso é o bot
   sair e o próximo `/play` reentrar. Não vale introduzir uma fila de
   serialização aqui pelo custo/benefício.

O item 7 é uma limitação conhecida e declarada, não um item pendente.

## 7. Critérios de aceite

- **Dado** que o bot está tocando e o servidor é reiniciado, **então** a música
  **não** para, e o bot volta ao roster em menos de 20 s.
- **Dado** que o bot está tocando e o WebSocket cai por 30 s, **então** a
  música não para.
- **Dado** um `/play` em um canal novo, **então** o bot sai do anterior e
  aparece no novo em menos de 3 s, sem duplicar linha.
- **Dado** que o bot é desconectado pelo menu de contexto, **então** ele some
  do roster em menos de 3 s e para a música.
- **Dado** um servidor sem `voice.hints`, **então** o bot usa
  `voice.presence.enter` e tudo funciona.
- **Dado** o `GET /api/debug/voice`, **então** o bot aparece com
  `client_version` igual à versão do `package.json` e `protocol_version: 2`.

## 8. Como testar

### Automatizado

`music-bot/test.js` já existe e roda no CI
(`.github/workflows/deploy-production.yml`, job `validate`). Adicionar:

| Teste | Cenário |
|---|---|
| `hello inclui protocol_version e client_version` | inspeciona o payload enviado |
| `sendPresenceHint usa a op v1 sem a feature` | |
| `sendPresenceHint usa a op v2 com a feature` | |
| `rejoinAfterReconnect não desconecta a sala viva` | duplo de `Room` conta `disconnect` |
| `leaveVoice captura o sid antes de desconectar` | |

O arquivo de teste atual usa asserções simples de Node; seguir o mesmo estilo,
sem introduzir framework.

### Manual

1. Com o bot tocando, rodar `docker compose restart tupi-server`.
   **A música não pode parar.** O bot volta à sidebar em menos de 20 s.
2. Com o bot tocando em Alpha, arrastar o bot para Beta pela sidebar. A música
   continua, agora em Beta, e a sidebar mostra o bot só em Beta.
3. `/stop`. O bot sai em menos de 3 s.
4. Verificar `GET /api/debug/voice` e confirmar `protocol_version: 2` para o
   bot.

O passo 1 é o critério mais importante: hoje um redeploy do servidor derruba o
bot do roster (RC-05) e, dependendo do timing, mata a música.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| `localParticipant.sid` não existir no `@livekit/rtc-node` 0.13.34 | Degradação já definida em §4.4 e caso de borda 5 |
| `leaveVoice` assíncrono muda o timing do watchdog | Caso de borda 7, declarado e aceito |
| Reconexão sem desconectar a mídia deixar estado inconsistente | O reconcile do servidor confirma em até 15 s |
| Mudança quebrar a música em produção | O bot roda em container próprio; rollback é redeployar a imagem anterior |

**Rollback:** `git revert` e redeploy. O workflow constrói a imagem por commit
(`ghcr.io/mrvitor0/tupi-music-bot:${{ github.sha }}`), então voltar é trocar a
tag.

## 10. Fora de escopo

- Não mudar provedores, resolução de faixas, yt-dlp ou ffmpeg.
- Não mudar o feeder de PCM nem o formato de áudio.
- Não mudar o watchdog de ociosidade.
- Não mudar `stream.publish` de música para o modelo de tracks por SID.
- Não adicionar reconexão da sala do LiveKit por conta própria: o SDK já tem a
  dele.
