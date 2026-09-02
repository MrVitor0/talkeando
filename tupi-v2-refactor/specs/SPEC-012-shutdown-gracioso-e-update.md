# SPEC-012 — Shutdown gracioso, aplicação de update e reanúncio pós-reconexão

## 1. Problema

**Causas raiz:** RC-18 (o update é aplicado com a call ativa, sem teardown, e o
processo some sem avisar ninguém), RC-08 (parte: a sala de espectador nunca é
encerrada no fechamento).

`MainWindow.Closed` chama `_bridge.Dispose()`
(`client/native/Talkeando.Client/MainWindow.xaml.cs:61`), que descarta hotkey,
captura e monitor de atividade (`IpcBridge.cs:526`). Não fecha o WebSocket com
um frame `Close`, não avisa a UI, não desconecta o `Room` do LiveKit.

`update.apply` (`IpcBridge.cs:341-345`) chama `ApplyUpdatesAndRestart`
(`UpdateChecker.cs:417`), que encerra o processo imediatamente.

Resultado: o servidor descobre pelo heartbeat (até 60 s,
`server/src/ws/handler.rs:24`) e o LiveKit pelo seu próprio timeout. Nesse
intervalo todos veem a pessoa na call sem ouvir nada. Ao reabrir, o app pode
reentrar na sala antes de a sessão antiga expirar, causando
`DUPLICATE_IDENTITY`.

**Sintomas que desaparecem:** 2 (estado perdido ao reabrir), 5 (erro logo
depois de reiniciar ou atualizar).

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** SPEC-007 (`callSession.leave`), SPEC-011 (`spectator.stop`).

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/native/Talkeando.Client/MainWindow.xaml.cs` | editar: `Closing` faz shutdown gracioso |
| `client/native/Talkeando.Client/IpcBridge.cs` | editar: `app.shutdown`, `update.apply` com teardown |
| `client/native/Talkeando.Client/NetworkClient.cs` | editar: `CloseWebSocketAsync` público e usado |
| `client/ui/src/App.tsx` | editar: handler de `app.shutdown.request` |
| `client/ui/src/shutdown.ts` | criar |

## 4. Mudança especificada

### 4.1 O protocolo de shutdown

O nativo não sabe nada sobre a call (a UI é dona do `Room`), então o shutdown
precisa de um handshake curto entre os dois lados:

```
Nativo                                UI
  │                                    │
  │  app.shutdown.request  ───────────►│
  │  { reason: "closing" | "update" }  │
  │                                    │ callSession.leave()
  │                                    │ spectator.stop()
  │                                    │ screenPublisher.stop()
  │◄──────────  app.shutdown.ready ────│
  │  { }                               │
  │                                    │
  │ fecha o WebSocket com Close        │
  │ segue com o fechamento / update    │
```

Com timeout de **2 segundos** no lado nativo: se a UI não responder (WebView
travado, página não carregada), o nativo segue mesmo assim. Um shutdown que
trava é pior que um shutdown sujo.

### 4.2 `client/ui/src/shutdown.ts` (novo)

```ts
/**
 * Encerramento ordenado antes de o processo morrer. Sem isto, o servidor só
 * descobre pelo heartbeat (até 60 s) e todos veem um fantasma nesse intervalo
 * (tupi-v2-refactor/02-root-cause-analysis.md RC-18).
 */
import { send, subscribe } from "./ipc";
import * as callSession from "./callSession";
import * as spectator from "./spectator";
import * as screenPublisher from "./screenPublisher";

let installed = false;

export function installShutdownHandler() {
  if (installed) return;
  installed = true;
  subscribe(event => {
    if (event.op !== "app.shutdown.request") return;
    void teardownEverything(event.data?.reason ?? "closing").finally(() => {
      send("app.shutdown.ready", {});
    });
  });
}

async function teardownEverything(reason: string): Promise<void> {
  logClient("app.shutdown", { reason });
  // Ordem: tela, espectador, call. A tela primeiro porque a captura nativa
  // tem thread própria e é a que mais demora a soltar.
  await Promise.allSettled([
    screenPublisher.stop(),
    spectator.stop(),
  ]);
  await callSession.leave().catch(() => {});
}
```

`callSession.leave()` já envia a dica de `leaving` com `participant_sid`
(SPEC-007 §4.3), o que faz o servidor chamar `RemoveParticipant` no LiveKit
(SPEC-005 §4.3). A saída fica imediata para todos os outros clientes, em vez de
esperar timeout.

Chamar `installShutdownHandler()` uma vez no boot da UI, junto de
`initVoiceStore()` (SPEC-008).

### 4.3 `IpcBridge.cs` — orquestração

```csharp
/// Pede à UI que encerre call, tela e preview antes de o processo morrer.
/// Resolve mesmo se a UI não responder: um shutdown travado é pior que um
/// shutdown sujo.
private TaskCompletionSource<bool>? _shutdownAck;

public async Task<bool> RequestGracefulShutdownAsync(string reason, TimeSpan timeout)
{
    _shutdownAck = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    Publish("app.shutdown.request", new { reason });
    var completed = await Task.WhenAny(_shutdownAck.Task, Task.Delay(timeout)) == _shutdownAck.Task;
    if (!completed) DebugLog.Write($"Graceful shutdown timed out after {timeout.TotalSeconds}s ({reason}).");
    _shutdownAck = null;
    // O WebSocket é fechado com um frame Close para que o servidor registre a
    // saída na hora, em vez de esperar o heartbeat (handler.rs:24).
    await _network.DisconnectWebSocketAsync();
    return completed;
}
```

E o novo op na `switch` de `HandleWebMessage`:

```csharp
case "app.shutdown.ready":
    _shutdownAck?.TrySetResult(true);
    break;
```

`DisconnectWebSocketAsync` já existe (`NetworkClient.cs:369`) e já faz
`CloseAsync` com `NormalClosure`. Nenhuma mudança necessária nele.

`update.apply` (`IpcBridge.cs:341-345`) passa a ser:

```csharp
case "update.apply":
{
    // Sair da call antes de o Velopack matar o processo (RC-18). Sem isto,
    // todos veem a pessoa na call por até 60 s depois do restart, e o
    // reingresso pode colidir com a sessão antiga (DUPLICATE_IDENTITY).
    await RequestGracefulShutdownAsync("update", TimeSpan.FromSeconds(2));
    _updater.ApplyUpdate();
    break;
}
```

`HandleWebMessage` já é `async void` (`IpcBridge.cs:68`), então o `await`
compila sem mudanças de assinatura.

### 4.4 `MainWindow.xaml.cs` — fechamento da janela

Hoje só existe `Closed` (`MainWindow.xaml.cs:61`), que roda depois de a janela
já ter fechado. Trocar por `Closing`, que permite adiar:

```csharp
private bool _shuttingDown;

public MainWindow()
{
    // ... resto do construtor ...
    Closing += OnClosing;
    Closed += (_, _) => _bridge.Dispose();
}

/// Sair da call antes de fechar. A janela é mantida por até 2 s enquanto a
/// UI desfaz a sessão; sem isto o servidor e o LiveKit só descobrem a saída
/// por timeout (RC-18).
private async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
{
    if (_shuttingDown) return;          // segunda passagem: deixar fechar
    e.Cancel = true;
    _shuttingDown = true;
    try
    {
        await _bridge.RequestGracefulShutdownAsync("closing", TimeSpan.FromSeconds(2));
    }
    catch (Exception exception)
    {
        DebugLog.Write($"Graceful shutdown failed: {exception}");
    }
    Close();                            // agora fecha de verdade
}
```

O padrão de cancelar e reagendar o `Close` é o único jeito de fazer trabalho
assíncrono em `Closing` no WPF. O flag `_shuttingDown` evita recursão infinita.

Risco a tratar: se o usuário clicar no X duas vezes rápido, a segunda passagem
já tem `_shuttingDown == true` e retorna sem cancelar, então a janela fecha.
Correto.

### 4.5 Reanúncio pós-reconexão com sids

`restoreControlPlanePresence` (`client/ui/src/rtc.ts:249-261`) hoje reenvia
`voice.presence.enter` e `voice.track.published` sem `track_sid` para a câmera
e com `publication.trackSid` para as demais. Com o protocolo v2, tudo passa a
carregar sid, e a presença carrega o `participant_sid`:

```ts
function restoreControlPlanePresence() {
  const snapshot = callSession.snapshot();
  const room = callSession.activeRoom();
  if (!room || !snapshot.channelId) return;

  sendPresenceHint(snapshot.channelId, "joining", room.localParticipant.sid ?? undefined);

  for (const publication of room.localParticipant.trackPublications.values()) {
    if (!publication.track) continue;
    const source = publication.source === Track.Source.Camera ? "camera"
      : publication.source === Track.Source.ScreenShare ? "screen_share"
      : publication.source === Track.Source.ScreenShareAudio ? "screen_share_audio"
      : null;
    if (source) sendTrackHint(publication.trackSid, source, "published");
  }
  logClient("call.presence.restored", { channel_id: snapshot.channelId });
}
```

Enviar o `participant_sid` no reanúncio é o que permite ao servidor marcar a
pessoa como **confirmada** de imediato (SPEC-005 §4.3), em vez de provisória: o
cliente só conhece o sid porque a conexão com o LiveKit existe de fato.

O gatilho continua sendo `connection.state == "connected"` (`rtc.ts:267-271`).
Adicionar também um pedido de snapshot, porque o estado local pode ter perdido
deltas durante a queda:

```ts
controlPlaneSubscription = subscribe(event => {
  if (event.op === "connection.state" && event.data?.state === "connected") {
    restoreControlPlanePresence();
    voiceStore.requestFullSnapshot("ws_reconnected");
  }
});
```

`requestFullSnapshot` é exportado por `voiceStore` (SPEC-008 já tem
`requestSnapshot` interno; expor uma versão que pede todos os canais).

### 4.6 Sono e despertar da máquina

Um caso mencionado no pedido e não coberto pelas outras specs. Ao acordar de
suspensão, o WebSocket costuma estar morto sem que o SO tenha avisado, e o
`Room` do LiveKit também.

A UI ganha um detector simples, sem API de sistema:

```ts
/**
 * Detecção de suspensão: um timer de 5 s que percebe um salto grande no
 * relógio. Ao acordar, forçamos a reconciliação em vez de esperar o timeout
 * de heartbeat.
 */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const drift = now - lastTick;
  lastTick = now;
  if (drift > 30_000) {
    logClient("app.wake_detected", { drift_ms: drift });
    voiceStore.requestFullSnapshot("wake");
    // O SDK do LiveKit tem reconexão própria; o que precisamos é reconciliar
    // a nossa visão e reanunciar presença assim que o WS voltar.
  }
}, 5_000);
```

O `NetworkClient` já reconecta sozinho ao detectar falha de envio ou recepção
(`NetworkClient.cs:444`), e o `connection.state` resultante dispara o
reanúncio. O detector de despertar apenas acelera a reconciliação do estado
visível.

## 5. Contratos de dados

IPC novo:

| op | Direção | Payload |
|---|---|---|
| `app.shutdown.request` | nativo para UI | `{ reason: "closing" \| "update" }` |
| `app.shutdown.ready` | UI para nativo | `{}` |

Nenhuma mudança no protocolo WebSocket além do já definido em
`05-protocol-spec.md` §3.1.

## 6. Casos de borda a tratar

1. UI não carregada (falha de WebView2): `RequestGracefulShutdownAsync` expira
   em 2 s e o fechamento segue.
2. UI travada em um laço: mesmo caso.
3. Usuário clicando no X duas vezes: `_shuttingDown` cobre.
4. Update aplicado sem call ativa: `teardownEverything` roda em milissegundos e
   responde imediatamente.
5. `app.shutdown.ready` chegando depois do timeout: `_shutdownAck` já é `null`;
   `TrySetResult` em um TCS descartado não faz nada. Usar `?.` como no código
   acima.
6. Crash do processo (não é fechamento): nada a fazer; o reconcile do servidor
   cobre em até 15 s. Esta spec não tenta resolver crash.
7. Windows encerrando a sessão (shutdown do SO): `Closing` é chamado, mas o SO
   pode não esperar 2 s. Aceito; o caminho de timeout do servidor cobre.
8. Update baixado mas o usuário fecha o app antes de aplicar: fluxo normal de
   `closing`.
9. Suspensão muito curta (menos de 30 s): não dispara o detector; o heartbeat
   normal resolve.
10. Relógio do sistema ajustado para trás: `drift` negativo, nenhum disparo.
    Correto.

## 7. Critérios de aceite

- **Dado** que estou em uma call e fecho o app pelo X, **então** os outros me
  veem sair em menos de 3 s. **Hoje leva até 60 s.**
- **Dado** que estou em uma call e aplico um update, **então** os outros me
  veem sair em menos de 3 s, e ao voltar eu entro sem erro de sessão
  duplicada.
- **Dado** que o WebView não responde, **então** o app fecha em no máximo 2,5 s.
- **Dado** que estou compartilhando a tela e fecho o app, **então** a captura
  nativa para antes do processo morrer (verificável: nenhum processo órfão).
- **Dado** que o WebSocket cai e volta, **então** eu reanuncio presença com
  `participant_sid` e peço um snapshot completo.
- **Dado** que a máquina dorme por 2 minutos e acorda, **então** em menos de
  30 s meu estado visível está correto sem eu clicar em nada.

## 8. Como testar

### Automatizado

`client/ui/src/shutdown.test.ts`:

| Teste | Cenário |
|---|---|
| `teardown_stops_screen_spectator_and_call` | ordem e conclusão |
| `ready_is_sent_even_when_teardown_throws` | `finally` garante a resposta |
| `handler_is_installed_only_once` | |

Lado nativo, em `client/native/Talkeando.Client.Tests/`: um teste que valida o
timeout de `RequestGracefulShutdownAsync` sem UI. Isso exige extrair a lógica de
espera para um método testável, porque `IpcBridge` depende de WebView2. Criar:

```csharp
internal static class GracefulShutdown
{
    public static async Task<bool> WaitForAckAsync(Task ack, TimeSpan timeout)
        => await Task.WhenAny(ack, Task.Delay(timeout)) == ack;
}
```

e testar os dois caminhos. O `SessionStoreTests.cs` existente serve de modelo
para a estrutura do arquivo de teste.

### Manual

Roteiro M-07 (restart do app) e M-08 (auto-update com call ativa) de
`07-test-plan.md` §5.

Roteiro adicional de suspensão:

1. A e B em call.
2. A fecha a tampa do notebook por 3 minutos.
3. A reabre.
4. Em menos de 30 s, A e B se ouvem e as duas sidebars estão corretas.
5. Nenhum banner de erro persistente na tela de A.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| O fechamento demora 2 s a mais e o usuário percebe | Na prática o teardown leva menos de 300 ms; os 2 s são teto |
| `Closing` assíncrono com `e.Cancel` interage mal com o Velopack | O update chama `RequestGracefulShutdownAsync` diretamente, sem passar por `Closing` |
| O detector de despertar dispara falso positivo em máquina sobrecarregada | O custo é um pedido de snapshot; inofensivo |
| `app.shutdown.ready` de uma UI antiga nunca chega | Timeout cobre; nativo e UI vêm no mesmo instalador |

**Rollback:** `git revert`. Volta ao fechamento abrupto.

## 10. Fora de escopo

- Não mudar o Velopack, o feed de update ou os workflows de release.
- Não adicionar verificação periódica de update.
- Não impedir o update quando há call ativa
  (`09-alternatives-rejected.md` §11).
- Não tratar crash do processo.
- Não mexer na reconexão do `NetworkClient`, que já funciona.
