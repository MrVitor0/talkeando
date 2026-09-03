# 02 — Análise de causa raiz

Cada item é uma causa raiz, não uma descrição de sintoma. Itens marcados como
**Hipótese** não foram provados só pelo código; cada um traz a instrumentação
exata que confirma ou refuta.

Legenda de confiança:
- **Provado**: o código lido demonstra o defeito por leitura direta.
- **Hipótese**: o código é compatível com o defeito, mas falta evidência de
  runtime; a instrumentação necessária está descrita.

---

## RC-01 — O roster do servidor mistura duas fontes de verdade com precedência invertida

**Confiança: Provado.**

O `CallRegistry` recebe escritas de duas autoridades diferentes sem nenhuma
regra de precedência:

- LiveKit, via webhook: `server/src/routes/livekit.rs:45-46` chama
  `apply_participant(room, user, true|false)`.
- O cliente, via socket: `server/src/ws/handler.rs:574-581` e `:591-592`
  chamam `apply_participant` e `evict_voice_participant` para os mesmos dados.

`apply_participant` (`server/src/ws/call_registry.rs:81-88`) é um upsert cego:
`joined = true` insere, `joined = false` chama `leave`, que remove a pessoa e
todos os streams dela (`call_registry.rs:276-294`).

O resultado é uma corrida "last writer wins" entre dois emissores assíncronos
que descrevem instantes diferentes. Sequência real e reproduzível:

1. Usuário A sai do canal X: a UI manda `voice.presence.leave`
   (`client/ui/src/rtc.ts:325`) e desconecta o `Room`.
2. Servidor remove A de X e faz broadcast do roster sem A.
3. O webhook `participant_left` de A chega depois: `leave` de novo, inofensivo.
4. **Mas** se um webhook `participant_joined` atrasado de A (do próprio join
   anterior, ou de uma reconexão do LiveKit) chegar depois do passo 2, o
   servidor **reinsere A** no canal X, e o `broadcast_voice_roster` que segue
   ressuscita a linha na sidebar de todo mundo.

O inverso também acontece e é o que produz o sintoma 1: o `voice.presence.leave`
de um usuário remove a linha dele do roster **antes** de o LiveKit efetivamente
desconectá-lo. Enquanto o LiveKit não desconecta (e ele só desconecta quando o
`room.disconnect()` do cliente completa, ou quando o timeout do SFU expira), o
áudio continua fluindo para quem permanece na sala. Ninguém é removido do lado
da mídia por um evento de socket.

**Sintomas que isso causa:** 1 (fantasmas na UI, áudio continua), 2 (estado
perdido no restart), parte de 3.

**Correção:** SPEC-003, SPEC-004, SPEC-005.

---

## RC-02 — A UI monta a lista de participantes a partir do roster do servidor, não do `Room` do LiveKit

**Confiança: Provado.**

`App.tsx:1380-1383` define `call` a partir do `voice.roster` recebido, e
`voiceParticipants` (`App.tsx:2629-2636`) deriva os tiles disso. Em nenhum lugar
o código lê `room.remoteParticipants` para montar a lista. `client/ui/src/rtc.ts`
sequer expõe os participantes do `Room`: os únicos callbacks são
`onRemoteStream`, `onLocalCamera`, `onSpeaking`, `onCallDisconnected`,
`onConnectionQuality`, `onMediaError` e `onAudioPipelineStatus`
(`rtc.ts:406-410`, `:428`).

Ou seja: mesmo que o servidor estivesse perfeito, um `voice.roster` perdido no
transporte deixaria a UI errada até o próximo evento, sem nenhum mecanismo de
detecção. E como quem determina o áudio é o `Room`, a UI só pode divergir.

Isso também explica o sintoma 1 na direção "eu saio, elas somem da UI, mas eu
ainda ouço": o `voice.roster` é uma projeção do servidor que não tem relação
causal com as tracks assinadas pelo `Room`.

**Sintomas:** 1, 2, 3.

**Correção:** SPEC-008 (roster local da própria call derivado do `Room`, com o
roster do servidor como fonte apenas para canais em que não estou).

---

## RC-03 — Streams são identificados por um UUID inventado pelo servidor, não pelo SID do LiveKit

**Confiança: Provado.**

`apply_track` (`server/src/ws/call_registry.rs:97-137`) cria
`PublishedStream { id: Uuid::new_v4(), ... }` toda vez que uma publicação nova
aparece (`:120`, `:128`). O `msid` guarda o `track_sid` do LiveKit, mas só
quando ele chega — e a linha 124 só o preenche se estiver vazio:

```rust
(true, false, Some(stream)) => {
    if stream.msid.is_none() { stream.msid = track_sid; }
}
```

Consequência direta: quando alguém **para** de compartilhar e **começa de
novo**, o LiveKit emite um novo `track_sid`. Se a linha antiga ainda existir
(porque o `track_unpublished` se perdeu, chegou fora de ordem, ou foi
processado depois do novo `track_published`), o servidor mantém o `msid`
antigo. O `StreamDto` distribuído para os clientes (`protocol.rs:352-365`)
carrega então um `msid` que não corresponde a nenhuma publicação viva.

No cliente, `screenPublication` (`rtc.ts:386-393`) faz:

```ts
return participant.trackPublications.get(sid)
  ?? [...participant.trackPublications.values()].find(p => p.source === Track.Source.ScreenShare);
```

O fallback salva o caso de um SID errado quando existe exatamente uma
publicação de tela. Mas `pickRemoteVideo` (`App.tsx:2664-2671`) usa o `msid`
para decidir se um vídeo é câmera ou tela:

```ts
const row = streams.find(s => s.msid && s.msid === vid.msid);
const kind = row ? row.kind : "screen";
```

Com um `msid` obsoleto, a tela recém-publicada não casa com nenhuma linha e é
classificada como `"screen"` por padrão — o que por acaso funciona para tela,
mas quebra quando a pessoa também tem câmera ligada: a câmera passa a ser
tratada como tela e vice-versa.

Pior: `App.tsx:2685` procura `streams.find(s => s.owner === ... && s.kind === "screen")`
para decidir se cria o tile de tela. Se a linha antiga sobreviveu, o tile aparece
com `stream: undefined` e renderiza para sempre o placeholder "Assistir
transmissão" (`App.tsx:2711-2730`), sem vídeo. É exatamente o "loading infinito".

**Sintomas:** 4 (segunda vez não vejo a tela, loading infinito).

**Correção:** SPEC-003 (chave por SID), SPEC-004 (webhook aplica SID), SPEC-010
(cliente).

---

## RC-04 — `room_finished` apaga o canal inteiro sem verificar se ainda há gente

**Confiança: Provado.**

`server/src/routes/livekit.rs:53`:

```rust
"room_finished" => { state.hub.calls.write().await.clear_channel(room); broadcast_voice_roster(&state, room).await; },
```

`clear_channel` (`call_registry.rs:238`) remove o canal do mapa
incondicionalmente. O LiveKit emite `room_finished` depois de
`room.empty_timeout` (300 s em `infra/livekit/livekit.yaml.tmpl:16`), mas o
evento é assíncrono e pode chegar **depois** de alguém já ter entrado de novo
na mesma sala. Nesse caso o servidor apaga um canal que tem gente dentro, todo
mundo some da sidebar, e só o reconcile de 15 s
(`server/src/main.rs:189`) corrige.

Combina com RC-01: em uma janela de 15 s, todo cliente conectado vê o canal
vazio enquanto o áudio continua fluindo.

**Sintomas:** 1, 3.

**Correção:** SPEC-004 (tratar `room_finished` como pedido de reconcile daquele
canal, nunca como delete direto).

---

## RC-05 — A desconexão do WebSocket evicta o usuário da voz, embora o WS não seja o transporte de mídia

**Confiança: Provado.**

`server/src/ws/handler.rs:214` captura `joined_calls` e `:234-236` roda, após
8 s:

```rust
for channel_id in left_calls {
    evict_voice_participant(&delayed_state, channel_id, user_id).await;
}
```

`evict_voice_participant` (`handler.rs:1240-1246`) chama
`apply_participant(..., false)`, removendo a pessoa do roster.

Mas o WebSocket e o LiveKit são conexões independentes: uma queda momentânea do
WS (deploy do servidor, blip de rede, sleep curto) **não** derruba a sessão de
mídia. Depois desse evict, a pessoa continua falando e sendo ouvida, mas
sumiu da sidebar de todos. A recuperação depende de:

- o cliente reconectar o WS e reenviar `voice.presence.enter`
  (`rtc.ts:249-261`), o que só ocorre se `active` e `presentChannelId` ainda
  estiverem setados; ou
- o reconcile de 15 s.

Um deploy do servidor (o workflow recria o container,
`.github/workflows/deploy-production.yml`) provoca isso para todos os usuários
em call ao mesmo tempo.

**Sintomas:** 1, 2, 3 e "some todo mundo depois do deploy".

**Correção:** SPEC-005 (a queda do WS nunca escreve no registro de voz; o
LiveKit e o reconcile são as únicas autoridades de presença de mídia).

---

## RC-06 — O webhook não distingue instância de participante, então eventos fora de ordem se cancelam

**Confiança: Provado.**

`WebhookEvent` (`server/src/livekit.rs:211-217`) só decodifica
`participant.identity`. O LiveKit envia também o `sid` do participante, que é
único **por sessão** — a mesma pessoa reconectando recebe um sid novo. Sem ele,
esta sequência corrompe o estado:

1. Usuário A reconecta o LiveKit. LiveKit emite `participant_joined` (sid S2).
2. O `participant_left` da sessão anterior (sid S1) chega **depois** por atraso
   de rede ou retry do webhook.
3. `apply_participant(room, A, false)` remove A, apesar de A estar conectado
   com S2.

O servidor não tem como saber que o evento tardio é obsoleto. O mesmo vale para
`track_published` versus `track_unpublished` com SIDs diferentes.

O webhook também não é idempotente: o LiveKit reenvia eventos que falharam, e o
handler processa cada reentrega como se fosse nova.

**Sintomas:** 1, 4.

**Correção:** SPEC-004 (dedupe por `(event_id, sid)` e comparação de sid antes
de aplicar remoção).

---

## RC-07 — Um espectador (`hidden: true`) não é filtrado do reconcile e pode virar participante do roster

**Confiança: Provado (o caminho existe); a frequência é hipótese.**

O token de espectador é emitido com `hidden: true`
(`server/src/livekit.rs:201`). O LiveKit não emite webhooks de `participant_*`
para participantes ocultos, mas `ListParticipants` **os retorna**. O reconcile
(`server/src/livekit.rs:352-373`) filtra apenas `state == "DISCONNECTED"`,
não o flag de oculto — o struct `ParticipantInfo` (`livekit.rs:306-312`) nem
decodifica `permission`.

Portanto, um usuário que só passa o mouse sobre uma linha para dar preview
(`App.tsx:2441` chama `rtc.spectate`) entra na sala como espectador e, no
próximo tick de 15 s, aparece na sidebar de todo mundo como se estivesse na
call — sem áudio, sem ter entrado. Ele fica lá até parar o preview, e como
`stopSpectate` é uma função vazia (`rtc.ts:405`), o `Room` de espectador nunca
é desconectado: ele permanece até o app fechar.

**Sintomas:** 1 (pessoa aparece em canal em que não está), 4 (preview "ao vivo"
bugado).

**Correção:** SPEC-004 (filtrar `permission.hidden` no reconcile), SPEC-011
(ciclo de vida do spectator no cliente).

---

## RC-08 — `rtc.spectate` sequestra a variável `active`, e então `leaveCall` e o reanúncio agem sobre a sala errada

**Confiança: Provado.**

`client/ui/src/rtc.ts:404`:

```ts
export async function spectate(id, sid, owner) {
  if (!active) {
    const credential = await credentials(id, "spectator");
    const room = new Room({ adaptiveStream: true, dynacast: true });
    bind(room);
    await room.connect(credential.url, credential.token);
    active = room;              // <— a sala de espectador vira "a call ativa"
  }
  watchStream(id, sid, owner);
}
```

Efeitos comprovados por leitura:

- `presentChannelId` **não** é setado, então `reportTrack` (`rtc.ts:236`) vira
  no-op e `restoreControlPlanePresence` (`rtc.ts:252`) não faz nada — correto
  por acaso.
- Mas `joinCall` (`rtc.ts:273-280`) toma `previous = active ?? connecting` e
  chama `previous?.disconnect()`. Isso desconecta a sala de espectador, o que é
  o comportamento desejado; porém `RoomEvent.Disconnected` dessa sala dispara
  `callEnded` (`rtc.ts:225`) porque `active === room` no momento do evento. A
  UI então roda `onCallDisconnected` (`App.tsx:1786-1799`), que zera `call`,
  `streams`, `watching`, `remoteVideos` e mostra o erro
  "A conexão de voz foi encerrada" — **durante** o join que o usuário acabou de
  pedir.
- `startCamera`, `publishScreen` e `setLocalAudioState` operam sobre `active`
  (`rtc.ts:350`, `:367`, `:341`). Se `active` é uma sala de espectador
  (`canPublish: false`), qualquer publicação falha com erro do SDK.

**Sintomas:** 4 (preview "ao vivo"), 5 (erro ao sair e entrar), 3.

**Correção:** SPEC-011 (sala de espectador separada, nunca em `active`),
SPEC-007 (máquina de estados de sessão).

---

## RC-09 — `joinCall` desconecta a sala anterior e a `Promise` do `connect()` anterior rejeita com "Client initiated disconnect", que a UI exibe como erro

**Confiança: Provado.**

Caminho exato:

1. `App.tsx:2171` chama `rtc.joinCall(...)` e trata a rejeição em `:2177-2185`
   exibindo `Não foi possível conectar o áudio: ${error.message}`.
2. `rtc.joinCall` (`rtc.ts:273-282`) faz `previous?.disconnect()` **sem
   `await`**, e imediatamente cria a sala nova.
3. No SDK, `Room.disconnect()` durante `Connecting` rejeita a `connectFuture`
   pendente com `ConnectionError.cancelled('Client initiated disconnect')`
   (`livekit-client.esm.mjs:33609`).
4. Se o usuário clicou em um canal e depois em outro rapidamente, a rejeição do
   `connect()` da primeira sala chega ao `catch` da primeira chamada de
   `joinCall`, cujo `attempt !== connectAttempt`. Mas o guard de `AbortError`
   em `App.tsx:2178` só reconhece o erro que o próprio `rtc.ts:293-295` cria
   manualmente **depois** do `connect()` resolver. Uma rejeição vinda de dentro
   do `connect()` tem `name === "ConnectionError"`, não `AbortError`, e cai no
   ramo que mostra o banner.

Além disso, `RoomEvent.Disconnected` da sala antiga (`rtc.ts:214-226`) roda com
`active === room` ainda verdadeiro em parte dos casos, disparando
`voice.presence.leave` do canal novo (porque `presentChannelId` já foi limpo em
`:279`, mas o evento pode chegar depois de `:302` ter definido o novo) e
`callEnded`, que zera a call recém-criada.

**Sintoma:** 5 ("não foi possível conectar o áudio: client initiated
disconnect"), e a instabilidade geral de trocar de canal rápido.

**Correção:** SPEC-007.

---

## RC-10 — `joinCall` no cliente não é atômico: falha parcial deixa recursos vivos

**Confiança: Provado.**

`rtc.ts:288-321`. Se `microphone.start(...)` (`:304`) lançar depois de
`room.connect()` ter sucedido:

- o `catch` (`:315-321`) faz `unpublishMicrophone`, `room.disconnect()` e
  `microphone.dispose()`;
- mas `presentChannelId` já foi definido em `:302` e **não é limpo** no `catch`;
- `active = room` já foi definido em `:297` e também não é limpo (só
  `connecting`, em `:316`).

Resultado: `active` aponta para uma sala desconectada e `presentChannelId`
aponta para um canal do qual nunca sairemos formalmente. O servidor mantém a
pessoa no roster (o `voice.presence.enter` de `:301` já foi enviado), e a UI
mostra o erro de `App.tsx:2184` mas deixa `call` nulo. Fantasma perfeito: no
roster do servidor, ausente na UI.

O `RoomEvent.Disconnected` disparado pelo `room.disconnect()` do `catch` chega
e limpa `active`/`presentChannelId` na maioria dos casos — mas ele só age se
`active === room || connecting === room` (`rtc.ts:215`), e nesse ponto
`connecting` já foi anulado, então depende de `active` ainda apontar para a
mesma sala. Se o usuário clicou em outro canal no meio, não aponta.

**Sintomas:** 1, 5.

**Correção:** SPEC-007.

---

## RC-11 — Um `voice.roster` por canal, para toda a comunidade, a cada evento, causa re-render global

**Confiança: Provado para a origem do custo; a percepção de "flicker" é
hipótese confirmável por profiling.**

`broadcast_voice_roster` (`server/src/ws/handler.rs:1213-1235`) faz uma consulta
ao Postgres (`db::channel_community`) e envia o roster completo do canal para
**todos os membros da comunidade**. É chamado em pelo menos 11 lugares, entre
eles cada `track_published` e `track_unpublished` (`livekit.rs:47-48`) e cada
`call.state.update` (`handler.rs:1404`).

Em uma call com 8 pessoas, entrar em um canal produz: 1 `participant_joined` do
webhook, 1 `voice.presence.enter`, 1 `track_published` do microfone, mais o
`call.state.update` inicial. São 4 broadcasts para toda a comunidade, cada um
disparando em cada cliente:

- `setVoiceRooms` com um objeto novo (`App.tsx:1366-1378`);
- `setVoiceRoomStreams` com um objeto novo (`:1379`);
- se for o canal atual, `setCall` e `setStreams` (`:1381-1382`).

Como `App.tsx` é um único componente gigante sem `memo` em nenhum subcomponente
de lista (verificado: não há `React.memo` no arquivo), cada um desses `setState`
re-renderiza a árvore inteira, incluindo cada `VideoTile`. E `VideoTile` tem um
`useEffect` com dependência `[stream]` que faz `video.srcObject = stream` e
`video.play()` (`App.tsx:612-622`).

Aqui está o mecanismo do flicker: `onRemoteStream` (`rtc.ts:188`) cria
`new MediaStream([track.mediaStreamTrack])` a **cada** evento. A UI guarda esse
objeto em `remoteVideos` (`App.tsx:1770`). Toda vez que um novo objeto
`MediaStream` substitui o anterior, o `useEffect` do `VideoTile` roda de novo,
reatribui `srcObject` e chama `play()` — o vídeo pisca e o
`useVideoReady` (`App.tsx:465-487`) volta para `false`, remontando o overlay
`StreamLoading`. Com muita gente, isso acontece várias vezes por segundo.

`speakingUsers` agrava: `onSpeaking` (`App.tsx:1785`) chama `setSpeakingUsers`
com um `Set` novo a cada `ActiveSpeakersChanged`, e o monitor local de fala roda
em `requestAnimationFrame` (`rtc.ts:140`) chamando `emitSpeaking()` a cada
transição — em uma call ativa, dezenas de re-renders globais por minuto.

**Sintoma:** 3 (flicker, principalmente com muita gente).

**Correção:** SPEC-013 (memoização e chaves estáveis), SPEC-008 (estado de voz
isolado do render de chat), SPEC-005 (menos broadcasts redundantes).

---

## RC-12 — `adaptiveStream: true` com o elemento de vídeo real fora do DOM do LiveKit faz o SFU parar de enviar a tela

**Confiança: Provado por leitura do SDK; é a causa mais provável do "loading
infinito".**

O `Room` é criado com `adaptiveStream: true` (`rtc.ts:282`). Com essa opção, o
`RemoteVideoTrack` observa os elementos anexados via `track.attach()` e reporta
visibilidade ao servidor:

- `attach()` registra um `HTMLElementInfo` e chama `updateVisibility()`
  (`livekit-client.esm.mjs:15486-15511`);
- `isElementInViewport` retorna `false` quando `display === 'none'`
  (`livekit-client.esm.mjs:15760-15768`);
- `updateVisibility` emite `VisibilityChanged`, que vira
  `sendUpdateTrackSettings({ disabled: !visible })` (`:33064`, `:32980`).

E `rtc.ts:182-183` faz exatamente isto:

```ts
const element = track.attach() as HTMLMediaElement;
element.autoplay = true; element.style.display = "none"; document.body.appendChild(element);
```

O único elemento que o LiveKit conhece está com `display: none`. O elemento que
o usuário realmente vê é um `<video>` criado pelo React
(`App.tsx:641-651`) que recebe `srcObject` diretamente — o SDK não sabe da
existência dele.

Logo, para **todo** vídeo remoto, o LiveKit informa ao SFU que a track está
invisível e o SFU para de enviar (`disabled: true`). O `<video>` do React fica
com um `MediaStreamTrack` vivo mas sem frames: `readyState === "live"`, mas a
track fica `muted`, então `useVideoReady` (`App.tsx:471-474`) nunca vira `true`
e o overlay `StreamLoading` fica para sempre. **Esse é o "loading infinito ao
clicar para ver a tela".**

Por que às vezes funciona: `updateVisibility` tem um atraso de reação
(`REACTION_DELAY`) e o `IntersectionObserver` pode não ter disparado ainda
quando os primeiros frames chegam. Nesse intervalo o vídeo aparece; depois
congela. Isso casa com "às vezes vejo, às vezes fica carregando".

**Sintoma:** 4 (loading infinito, preview morto), e telas que congelam.

**Correção:** SPEC-009 — ou desligar `adaptiveStream`, ou anexar o elemento
visível real ao SDK. A decisão está tomada na spec (anexar o elemento real e
manter `adaptiveStream`, ver `09-alternatives-rejected.md`).

---

## RC-13 — Não existe observabilidade de voz: nem log estruturado, nem métrica, nem estado inspecionável

**Confiança: Provado.**

Buscando por `tracing::` no caminho de voz, existem apenas:
`handler.rs:1458` (`voice.move_member`), `:1511` (`voice.disconnect_member`),
`:1303` (falha do reconcile) e `:1197` (heartbeat timeout). Não há log de:

- `voice.presence.enter` / `leave`;
- nenhum evento de webhook (`routes/livekit.rs` inteiro não tem uma linha de
  `tracing`);
- resultado do reconcile (quantos canais mudaram, quem entrou, quem saiu);
- emissão de token.

Não há endpoint para inspecionar o `CallRegistry`, nem métricas. Quando um
usuário relata "sumiu todo mundo", não existe nenhuma forma de saber o que o
servidor achava do estado naquele momento. Todo o diagnóstico desta análise
teve que ser feito por leitura de código.

**Sintoma:** todos, indiretamente. É a razão de os bugs estarem em produção há
tempo sem diagnóstico.

**Correção:** SPEC-002 e SPEC-014.

---

## RC-14 — Não há negociação de versão: o servidor não sabe com qual cliente fala

**Confiança: Provado.**

`AuthHello` (`server/src/ws/protocol.rs:55-58`) tem apenas `token`. `AuthOk`
(`:60-67`) devolve identidade e `livekit_url`. Nenhuma versão em nenhuma
direção. Com auto-update via Velopack, clientes de versões diferentes
coexistem por dias.

Hoje isso é gerenciado por acidente: o cliente silencia `unknown_op`
(`App.tsx:1542`). Qualquer mudança de semântica (não de nome) de uma op
existente quebra clientes antigos sem aviso, e o servidor não pode adaptar seu
comportamento por versão.

**Correção:** SPEC-001, que é pré-requisito de toda mudança de protocolo.

---

## RC-15 — `unpublishScreen` itera sobre a coleção de publicações enquanto a modifica

**Confiança: Provado.**

`rtc.ts:376-380`:

```ts
if (active) for (const publication of active.localParticipant.trackPublications.values())
  if ((publication.source === ScreenShare || publication.source === ScreenShareAudio) && publication.track) {
    await active.localParticipant.unpublishTrack(publication.track);
    reportTrack(false, ...);
  }
```

`unpublishTrack` remove a entrada do próprio `Map` que está sendo iterado, e há
um `await` dentro do laço. Em JavaScript, iterar um `Map` enquanto se apaga
entradas é definido, mas a combinação com `await` significa que o SDK pode
inserir ou remover entradas entre as iterações (por exemplo o
`LocalTrackUnpublished` interno). O risco real e observável é sair do laço com
o track de **áudio** de tela ainda publicado quando o de vídeo é removido
primeiro — e é justamente esse resíduo que faz a republicação seguinte falhar
ou produzir estado inconsistente no servidor (a linha `screen` continua com
`has_audio: true`, ver `call_registry.rs:118`).

**Sintoma:** 4 (parar e começar de novo).

**Correção:** SPEC-010 (coletar as publicações em um array antes, e desfazer em
ordem determinística: áudio depois vídeo).

---

## RC-16 — `stopNativeScreen` fecha o writer do gerador de áudio, mas `startNativeScreen` reutiliza estado global; uma segunda tela pode nascer sem áudio ou com timestamps errados

**Confiança: Provado para o estado; **Hipótese** para o impacto exato no áudio.**

`client/ui/src/nativeScreen.ts` mantém estado de módulo: `videoBuffer`,
`audioWriter`, `audioGenerator`, `audioFrameCount`, `active`, `canvas`, `ctx`.
`stopNativeScreen` (`:167-177`) zera `canvas`, `ctx`, fecha o writer e para o
gerador. `startNativeScreen` (`:135`) recria canvas e gerador.

Dois problemas:

1. `onVideoFrame` (`:71`) e `onAudioPacket` (`:94`) são handlers globais
   registrados uma vez (`:64`). Depois de `stopNativeScreen`, o host nativo
   pode ainda emitir alguns frames em voo (o `ScreenCapture.Stop` faz
   `_thread?.Join(800)`, `ScreenCapture.cs:249`); esses frames chegam com
   `active === false` e são descartados corretamente. Mas se o usuário
   recomeçar dentro dessa janela de 800 ms, `active` volta a `true` e frames da
   captura **antiga** são desenhados no canvas **novo**. Com resoluções
   diferentes isso produz um frame corrompido; com o mesmo tamanho, passa
   despercebido.
2. `IpcBridge` (`IpcBridge.cs:243-266`) chama `_screen.Start(...)` que por sua
   vez chama `Stop()` internamente (`ScreenCapture.cs:205`), mas o `_audio` só
   é iniciado se `withAudio`; ele **não** é parado quando `withAudio` é falso
   em uma segunda chamada. Uma segunda partilha sem áudio mantém a captura
   WASAPI da anterior rodando e escrevendo em `screen.audio`, que a UI vai
   ignorar (writer nulo) mas que continua consumindo CPU.

**Sintoma:** 4.

**Instrumentação que confirma o ponto 1:** logar em `onVideoFrame` a dimensão
do bitmap e um `captureGeneration` incrementado por `startNativeScreen`;
divergência entre gerações prova o vazamento.

**Correção:** SPEC-010.

---

## RC-17 — O preview por hover cria e destrói assinaturas sem coordenação com o estado de `watching`

**Confiança: Provado.**

`peekEnter` (`App.tsx:2433-2443`) chama `rtc.watchStream` ou `rtc.spectate`.
`endPeek` (`App.tsx:2422-2432`) chama `rtc.stopWatchingStream` ou
`rtc.stopSpectate` — que é vazia. Mas `watchStream` e `stopWatchingStream`
compartilham o mesmo mapa `wantedScreens` que o botão "AO VIVO" usa
(`rtc.ts:395`, `:401`). Sequência que quebra:

1. Usuário passa o mouse sobre a linha de A: `peekEnter` chama
   `watchStream(ch, sid, A)` → `wantedScreens.set(A, sid)`, `setSubscribed(true)`.
2. Usuário clica em "AO VIVO": `focusLiveShare` (`App.tsx:2374`) chama
   `endPeek()` primeiro (`:2377`), que faz `stopWatchingStream(..., A)` →
   `wantedScreens.delete(A)`, `setSubscribed(false)`.
3. Em seguida `:2395-2398` chama `watchStream` de novo e seta `watching[A]`.

O par `setSubscribed(false)` seguido de `setSubscribed(true)` em milissegundos
força o SFU a derrubar e recriar a assinatura. Com `dynacast` ativo, o
publicador pode ter parado o encoder no intervalo, e a nova assinatura espera
um keyframe. Combinado com RC-12 (o SFU já acha a track invisível), o resultado
prático é que a tela nunca aparece depois de um preview.

Além disso, `peekLeave` agenda `endPeek` em 220 ms (`App.tsx:2446`) lendo
`watching[ownerId]` **capturado no closure**, não o valor atual. Se o usuário
clicou em "AO VIVO" nesse intervalo, o timer ainda pode cancelar a assinatura
recém-criada.

**Sintoma:** 4.

**Correção:** SPEC-011 e SPEC-009.

---

## RC-18 — O update é aplicado com a call ativa, sem teardown, e o processo antigo desaparece sem avisar ninguém

**Confiança: Provado.**

`update.apply` (`IpcBridge.cs:341-345`) chama `_updater.ApplyUpdate()`, que
executa `ApplyUpdatesAndRestart` (`UpdateChecker.cs:417`). O processo é
encerrado pelo updater do Velopack. Nada envia `voice.presence.leave`, nada
chama `room.disconnect()`, nada fecha o WebSocket com `Close`.

Resultado: o servidor detecta a queda pelo heartbeat (até 60 s,
`handler.rs:24`) e então evicta a pessoa da voz (RC-05). O LiveKit detecta pelo
seu próprio timeout. Nesse meio-tempo, todos os outros clientes veem a pessoa
"na call" sem áudio. Quando o app reabre e reconecta, ele pode reentrar na sala
antes de o LiveKit ter expirado a sessão anterior, disparando
`DUPLICATE_IDENTITY` — que hoje é tratado como um `Disconnected` genérico
(`rtc.ts:214`), produzindo "A conexão de voz foi encerrada" logo após o update.

O mesmo caminho explica parte do sintoma 2: ao reabrir o app,
`send("auth.session.restore")` (`App.tsx:1554`) dispara o bootstrap e o WS
conecta; o `voice.rooms` inicial é enviado antes de o React ter montado seus
listeners em alguns casos, por isso existe o `voice.rooms.request` de
`App.tsx:1267`. Mas se o reconcile ainda não rodou (janela de até 15 s) e o
registro em memória foi zerado pelo evict de RC-05, o snapshot chega
legitimamente vazio — e nada mais o corrige até o próximo tick.

**Sintomas:** 2, 5.

**Correção:** SPEC-012.

---

## RC-19 — O listener de eventos do WS é recriado a cada troca de canal e captura estado obsoleto

**Confiança: Provado.**

`App.tsx:1251` abre `useEffect(() => { const unsubscribe = subscribe(...) }, [activeChannel?.id])`.
O closure captura `channels`, `activeChannel`, `call`, `watching` e as funções
`joinCall`/`leaveCall` do render em que foi criado. Dois problemas concretos:

- `voice.moved` (`App.tsx:1348-1354`) chama `joinCall(dest)` a partir do
  closure. Se o estado mudou desde então, `joinCall` opera sobre valores
  antigos de `voiceRooms`, `call` e `channels`.
- Entre o `unsubscribe` do efeito antigo e o `subscribe` do novo, existe uma
  janela (um tick de microtask) em que **nenhum** listener está registrado.
  Eventos entregues nessa janela pelo `ipc.ts` (`listeners.forEach`,
  `ipc.ts:193`) são perdidos silenciosamente. Trocar de canal enquanto alguém
  entra ou sai da call é exatamente a situação em que isso acontece.

**Sintomas:** 1, 3.

**Correção:** SPEC-008 (mover o estado de voz para um store fora do componente,
com um único listener montado uma vez).

---

## RC-20 — LiveKit sem limite de memória em uma VM de 2 GB, junto com Postgres remoto, servidor, bot e Caddy

**Confiança: Provado para a configuração; o impacto é Hipótese.**

`infra/docker-compose.production.yml` não define `mem_limit`,
`cpus` nem `restart` policies diferenciadas para nenhum serviço.
`livekit` roda com `network_mode: host` e `room.max_participants: 12`
(`infra/livekit/livekit.yaml.tmpl:16`). O `music-bot` roda `yt-dlp` e `ffmpeg`,
que são picos de memória e CPU imprevisíveis.

Em 2 GB, um pico do bot pode fazer o OOM killer escolher o `livekit-server` ou
o `tupi-server`. Um kill do `tupi-server` produz exatamente o sintoma
"todo mundo sumiu" (registro em memória zerado, RC-05) e um kill do LiveKit
derruba todas as calls.

**Instrumentação que confirma:** `docker stats` amostrado a cada 30 s e
`dmesg | grep -i oom` na Lightsail; a métrica de `restart_count` por container.

**Correção:** SPEC-016.

---

## Mapa sintoma para causa raiz

| Sintoma reportado | Causas raiz | Specs que resolvem |
|---|---|---|
| **1 [P0]** Dessincronização de canal, fantasmas na UI, áudio continua | RC-01, RC-02, RC-04, RC-05, RC-06, RC-07, RC-10, RC-19 | 003, 004, 005, 007, 008, 011 |
| **2 [P1]** Estado perdido após restart do app | RC-05, RC-18, RC-01 | 005, 012, 003 |
| **3 [P1]** Flicker de UI ao entrar e sair | RC-11, RC-19, RC-02, RC-04 | 008, 013, 005 |
| **4 [P0]** Screenshare quebrado ponta a ponta | RC-12, RC-03, RC-15, RC-16, RC-17, RC-07, RC-08 | 009, 010, 011, 003, 004 |
| **5 [P1]** "client initiated disconnect" ao sair e entrar | RC-09, RC-08, RC-10, RC-18 | 007, 011, 012 |

## Problemas adicionais encontrados, ainda não reportados por usuários

| # | Problema | Evidência | Spec |
|---|---|---|---|
| A1 | `voice.track.unpublished` não valida nada: qualquer cliente autenticado pode apagar o stream de qualquer outro em qualquer canal | `server/src/ws/handler.rs:615-624` (falta o `joined_calls.contains` que o `published` tem em `:604`) | 005 |
| A2 | `voice.presence.leave` não valida membership: um usuário pode remover a si mesmo de um canal ao qual não pertence, gerando broadcasts inúteis para a comunidade | `server/src/ws/handler.rs:584-593` | 005 |
| A3 | O limite de 10 participantes (`is_full`, `call_registry.rs:303`) nunca é aplicado no caminho SFU: `join` só é chamado pelo código morto de mesh; o token é emitido sem checar lotação | `server/src/routes/livekit.rs:20-33` | 004 |
| A4 | Mais de 600 linhas de código morto de mesh comentadas em `handler.rs` (`:364-447`, `:1090-1201`, `:1514-1752`) confundem qualquer leitura futura | `server/src/ws/handler.rs` | 018 |
| A5 | `broadcast_voice_roster` faz uma query ao Postgres por evento de roster, para toda a comunidade | `server/src/ws/handler.rs:1214` | 005 |
| A6 | O token do LiveKit dura 6 h (`livekit_token_ttl_seconds`, `config.rs:374`), mas o cliente nunca renova; uma call de mais de 6 h com reconexão falha ao reconectar | `client/ui/src/rtc.ts:148-163` | 007 |
| A7 | O `AudioContext` do monitor local de fala nunca é fechado se `joinCall` falhar após `startLocalSpeechMonitor` | `client/ui/src/rtc.ts:314` versus `catch` em `:315` | 007 |
| A8 | Elementos `<audio>` anexados ao `body` em `TrackSubscribed` só são removidos em `TrackUnsubscribed`; um `Disconnected` abrupto os deixa órfãos no DOM para sempre | `client/ui/src/rtc.ts:181-199` versus `:214-226` | 009 |
| A9 | `reconcile` não preserva `viewers` de streams que ele recria, e cria `stream_id` novo a cada execução para o mesmo track | `server/src/ws/call_registry.rs:551-566` | 003 |
| A10 | O webhook não tem rate limit nem verificação de replay por timestamp; a assinatura é válida para sempre | `server/src/livekit.rs:224-240` | 004 |
