# SPEC-017 — Harness de integração `integration/sfu` v2

## 1. Problema

`integration/sfu/run.cjs` é o único teste que exercita LiveKit real, servidor
real e WebSocket real ao mesmo tempo. Ele foi escrito para o protocolo v1 e
verifica premissas que a v2 inverte deliberadamente:

- linha 178: espera que derrubar o WebSocket (`terminate`) faça o participante
  **sumir** do roster. Na v2 isso é exatamente o que **não** pode acontecer
  (INV-A3), então o teste vai falhar por estar certo sobre o comportamento
  antigo;
- usa `voice.presence.enter` e `voice.roster` diretamente, sem negociar versão;
- `rosterHas` e `roomHas` leem o formato v1;
- não exercita republicação de tela, que é o sintoma 4.

Sem atualizá-lo, a suíte que mais se aproxima do uso real fica quebrada e
deixa de ser executada, que é como testes morrem.

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** SPEC-005 (ops v2 no servidor). Recomendado executar depois
  de SPEC-015, para exercitar o bot também.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `integration/sfu/run.cjs` | reescrever os cenários |
| `integration/sfu/README.md` | editar: cenários e pré-requisitos |
| `scripts/dev.ps1` | editar: mencionar o runner na saída |

## 4. Mudança especificada

### 4.1 Negociação de versão no `ControlClient`

```js
class ControlClient {
  constructor(account, options = {}) {
    this.account = account;
    this.protocolVersion = options.protocolVersion ?? 2;
    this.features = new Set();
    this.rooms = new Map();   // channel_id -> { version, participants, tracks }
    // ... resto igual ...
  }

  async connect() {
    // ... abertura do socket, igual ...
    this.send("auth.hello", {
      token: this.account.token,
      protocol_version: this.protocolVersion,
      client_version: "integration-harness",
      client_platform: "test",
    });
    const auth = await this.waitFor("auth.ok");
    assert.equal(auth.user_id, this.account.id, "WS autenticou como outro usuário");
    this.negotiated = auth.protocol_version ?? 1;
    this.features = new Set(auth.features ?? []);
    return this;
  }
}
```

### 4.2 Espelho de estado no cliente de teste

O harness passa a manter o mesmo estado que um cliente real manteria, aplicando
snapshots e deltas. Isso é o que permite verificar convergência de verdade, em
vez de só observar mensagens soltas.

```js
  handleVoiceMessage(event) {
    if (event.op === "voice.room.state") {
      this.rooms.clear();
      for (const room of event.data.rooms ?? []) {
        this.rooms.set(room.channel_id, {
          version: room.version,
          participants: room.participants ?? [],
          tracks: room.tracks ?? [],
        });
      }
      return;
    }
    if (event.op === "voice.room.delta") {
      const local = this.rooms.get(event.data.channel_id);
      if (!local) { this.gaps.push({ reason: "unknown_channel", ...event.data }); return; }
      if (event.data.previous_version !== local.version) {
        // Registrar a lacuna: o teste falha se houver alguma em cenário
        // saudável, o que é a verificação de INV-C2.
        this.gaps.push({ reason: "version_gap", local: local.version, ...event.data });
        return;
      }
      applyDelta(local, event.data);
      return;
    }
    // v1, quando o harness roda com protocolVersion: 1
    if (event.op === "voice.rooms") { /* converter para a mesma forma */ }
    if (event.op === "voice.roster") { /* converter */ }
  }
```

`applyDelta` replica a ordem normativa de `05-protocol-spec.md` §2.2. Ter uma
segunda implementação independente da do cliente React é proposital: se as duas
concordarem com o servidor, a especificação está clara.

### 4.3 Cenários

Substituir os cinco blocos atuais pelos sete de `07-test-plan.md` §4:

```js
async function main() {
  // ... login e descoberta de canal, iguais ...

  await scenarioInitialPresence(actors, channelId);        // E-01
  await scenarioAbruptWsDrop(actors, channelId);           // E-02  <- inverte a premissa antiga
  await scenarioMediaDropWithoutWs(actors, channelId);     // E-03
  await scenarioScreenRepublish(actors, channelId);        // E-04
  await scenarioServerRestart(actors, channelId);          // E-05 (opcional, ver §4.4)
  await scenarioRapidChannelSwitch(actors, channelId, second);  // E-06
  await scenarioMixedProtocolVersions(accounts, channelId);     // E-07
}
```

O cenário E-02 é o que muda de sinal:

```js
/**
 * E-02: derrubar o WebSocket NÃO pode remover ninguém da voz.
 *
 * Antes da v2, o servidor evictava o participante 8 s depois da queda do
 * socket (server/src/ws/handler.rs:234-236), embora a mídia continuasse
 * fluindo. Era a causa do "sumiu todo mundo depois do deploy" (RC-05).
 */
async function scenarioAbruptWsDrop(actors, channelId) {
  label("queda abrupta do WebSocket com mídia viva");
  const [observer, subject] = actors;
  assert.ok(subject.room, "o sujeito precisa estar com a mídia conectada");

  subject.control.terminate();          // sem frame de Close

  // Esperar mais que o grace de presença (8 s) mais folga.
  await sleep(15_000);

  const room = observer.control.rooms.get(channelId);
  assert.ok(room, "o canal sumiu do estado do observador");
  assert.ok(
    room.participants.some(p => p.user_id === subject.account.id),
    "INV-A3 violado: a queda do WebSocket removeu alguém que continua no LiveKit",
  );

  // E, ao reconectar, nada de duplicata.
  subject.control = await new ControlClient(subject.account).connect();
  subject.control.send("voice.room.request", { channel_ids: [channelId] });
  await subject.control.waitFor("voice.room.state");
  const restored = subject.control.rooms.get(channelId);
  const occurrences = restored.participants.filter(p => p.user_id === subject.account.id).length;
  assert.equal(occurrences, 1, "participante duplicado após reconexão");
}
```

E o cenário de tela, que é o sintoma 4:

```js
/**
 * E-04: publicar, despublicar e republicar a tela cinco vezes. Cada ciclo
 * precisa terminar com exatamente uma track de tela, com o SID atual.
 */
async function scenarioScreenRepublish(actors, channelId) {
  label("republicação de tela (5 ciclos)");
  const [observer, sharer] = actors;

  for (let cycle = 1; cycle <= 5; cycle++) {
    const publication = await publishFakeScreen(sharer);
    await eventually(`ciclo ${cycle}: observador vê a tela`, () => {
      const room = observer.control.rooms.get(channelId);
      const screens = (room?.tracks ?? []).filter(
        t => t.owner === sharer.account.id && t.source === "screen_share");
      return screens.length === 1 && screens[0].track_sid === publication.sid;
    });

    await unpublishFakeScreen(sharer, publication);
    await eventually(`ciclo ${cycle}: a tela some`, () => {
      const room = observer.control.rooms.get(channelId);
      return !(room?.tracks ?? []).some(
        t => t.owner === sharer.account.id && t.source === "screen_share");
    });
  }
}
```

`publishFakeScreen` usa `@livekit/rtc-node` para publicar uma track de vídeo
sintética. O SDK do Node consegue publicar vídeo por `VideoSource` mais
`LocalVideoTrack`, alimentado com frames gerados (um retângulo colorido basta).
Se a API de vídeo do `@livekit/rtc-node` 0.13.34 se mostrar custosa de usar,
**a alternativa determinada é publicar uma track de áudio com
`TrackSource.SOURCE_SCREENSHARE_AUDIO`**, que exercita exatamente o mesmo
caminho de publicação, SID e roster no servidor, que é o que este teste
verifica. O que este harness testa é o control plane, não o encoder.

### 4.4 Cenário de restart do servidor

E-05 exige reiniciar o `tupi-server`, o que o runner não pode fazer sozinho
sem assumir como o servidor foi iniciado. Torná-lo opcional e explícito:

```js
/**
 * E-05: reinicie o servidor manualmente quando o runner pedir. Só roda com
 * SFU_TEST_INTERACTIVE=1, porque exige ação humana.
 */
async function scenarioServerRestart(actors, channelId) {
  if (process.env.SFU_TEST_INTERACTIVE !== "1") {
    label("restart do servidor: pulado (defina SFU_TEST_INTERACTIVE=1)");
    return;
  }
  label("restart do servidor — REINICIE O tupi-server AGORA (60 s)");
  // ... espera, reconexão dos controles, verificação de convergência ...
}
```

### 4.5 Relatório final

O runner passa a imprimir um resumo em vez de só "PASS":

```js
console.log(`
[SFU] Resumo
  cenários executados: ${results.length}
  lacunas de versão detectadas: ${totalGaps}    (esperado: 0)
  tempo total: ${elapsed}s
`);
if (totalGaps > 0) {
  console.error("[SFU] FAIL: houve lacuna de versão em cenário saudável (INV-C2)");
  process.exitCode = 1;
}
```

Contar lacunas de versão é uma verificação que só este harness consegue fazer
bem, porque exige tráfego real com timing real.

### 4.6 README

Reescrever `integration/sfu/README.md` com:

- pré-requisitos (`dev.cmd -NoClients`, LiveKit em `127.0.0.1:7880`, contas);
- a lista dos sete cenários e o que cada um prova;
- as variáveis (`SFU_TEST_ACCOUNTS_JSON`, `SFU_TEST_API_URL`,
  `SFU_TEST_WS_URL`, `SFU_TEST_CHANNEL_ID`, `SFU_TEST_INTERACTIVE`,
  `SFU_TEST_PROTOCOL_VERSION`);
- a advertência de que E-02 leva 15 s por design e o runner inteiro leva cerca
  de 2 minutos.

## 5. Contratos de dados

`05-protocol-spec.md`. O harness é uma segunda implementação de referência do
cliente, e serve como verificação cruzada da spec.

## 6. Casos de borda a tratar

1. Servidor sem `voice.room.v2` em `features`: o harness cai para v1 e roda os
   cenários que fazem sentido, pulando os de versão.
2. Menos de três contas: E-04 e E-07 exigem três; pular com aviso claro em vez
   de falhar.
3. LiveKit indisponível: falhar cedo com mensagem explícita, não com timeout
   obscuro.
4. Canal já ocupado por usuários reais: o runner usa o primeiro canal de voz
   encontrado. Documentar que deve rodar em ambiente local, nunca contra
   produção. Adicionar uma guarda: recusar rodar se `SFU_TEST_API_URL` contiver
   um domínio que não seja `127.0.0.1` ou `localhost`, a menos que
   `SFU_TEST_ALLOW_REMOTE=1`.
5. Limpeza após falha: o `finally` existente já desconecta todos; preservar.
6. `terminate()` deixando o socket em estado inconsistente para reuso: criar um
   `ControlClient` novo, nunca reusar o terminado. Já é o padrão do código
   atual.

O item 4 é importante: um harness que apaga o estado de voz de produção seria
um desastre, e a guarda custa três linhas.

## 7. Critérios de aceite

- **Dado** um ambiente local com servidor e LiveKit, **quando** o runner é
  executado com três contas, **então** os sete cenários passam em menos de 3
  minutos.
- **Dado** o cenário E-02, **então** ele **falha** se a mudança de INV-A3 for
  revertida.
- **Dado** o cenário E-04, **então** ele falha se o endereçamento por SID for
  revertido.
- **Dado** um cenário saudável, **então** o número de lacunas de versão é zero.
- **Dado** `SFU_TEST_API_URL` apontando para um domínio remoto sem
  `SFU_TEST_ALLOW_REMOTE`, **então** o runner recusa rodar.
- **Dado** o runner com `protocolVersion: 1`, **então** os cenários de roster
  passam pelo caminho v1.

O segundo e o terceiro critérios são os que dão valor ao harness: um teste que
não falha quando a correção some não protege nada.

## 8. Como testar

Meta-teste, executado uma vez ao concluir:

1. Rodar o runner completo contra o servidor com todas as correções. Tudo
   verde.
2. Reverter localmente a mudança de INV-A3 (restaurar o evict por desconexão).
   Rodar. **E-02 precisa falhar.** Restaurar.
3. Reverter o endereçamento por SID. Rodar. **E-04 precisa falhar.** Restaurar.
4. Rodar com `SFU_TEST_PROTOCOL_VERSION=1`. Os cenários de roster passam.

Registrar os quatro resultados no PR.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| O harness ficar desatualizado de novo | Incluí-lo no critério de promoção de fase (`08-rollout-plan.md` §6) para que rodar seja obrigatório antes de cada release |
| E-02 levando 15 s deixa o runner lento | Aceito; o runner inteiro fica em cerca de 2 min e roda antes de release, não por commit |
| API de vídeo do `@livekit/rtc-node` complicada | Alternativa determinada em §4.3: usar track de áudio de screen share |
| Rodar contra produção por engano | Guarda de §6 item 4 |

**Rollback:** `git revert`. Só afeta ferramenta de teste.

## 10. Fora de escopo

- Não colocar este harness no CI: exige LiveKit real, contas reais e leva
  minutos. Os testes de `server/tests/voice_test.rs` (SPEC-006) cobrem o CI.
- Não testar captura de tela ou microfone reais.
- Não testar o cliente React.
- Não criar contas automaticamente: o operador fornece.
