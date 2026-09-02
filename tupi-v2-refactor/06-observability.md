# 06 — Observabilidade

Objetivo declarado: **nunca mais depender de leitura de código para diagnosticar
um relato de produção.** Quando um usuário disser "sumiu todo mundo", a
resposta precisa vir de log e de estado inspecionável, em minutos.

Hoje não existe nada disso no caminho de voz (RC-13): `server/src/routes/livekit.rs`
não tem uma única linha de `tracing`, e não há endpoint que mostre o
`CallRegistry`.

## 1. Logs do servidor

Formato já é JSON estruturado (`server/src/telemetry.rs:11`). A v2 adiciona
campos e eventos, sem mudar o formato.

### 1.1 Campos obrigatórios em todo evento de voz

| Campo | Tipo | Sempre? |
|---|---|---|
| `event` | string | sim, nome canônico da tabela §1.2 |
| `channel_id` | string uuid | sim |
| `user_id` | string uuid | quando aplicável |
| `participant_sid` | string | quando conhecido |
| `track_sid` | string | em eventos de track |
| `source` | enum | `webhook`, `reconcile`, `ws`, `admin`, `expiry` |
| `outcome` | enum | `applied`, `ignored_stale`, `ignored_duplicate`, `ignored_unknown`, `rejected` |
| `version_before` | inteiro | em mutações |
| `version_after` | inteiro | em mutações |

**Proibido logar:** token de sessão, JWT do LiveKit, `MUSIC_BOT_TOKEN`, hash de
senha, conteúdo de mensagem. Regra já existente em
`server/src/telemetry.rs:6`, reafirmada aqui porque o caminho de voz passa a
logar payloads.

### 1.2 Catálogo de eventos

| `event` | Nível | Onde |
|---|---|---|
| `voice.registry.participant_added` | info | `voice_registry.rs` |
| `voice.registry.participant_removed` | info | idem |
| `voice.registry.participant_confirmed` | debug | provisório virou confirmado |
| `voice.registry.participant_expired` | warn | provisório expirou sem confirmação (INV-A2) |
| `voice.registry.track_added` | info | idem |
| `voice.registry.track_removed` | info | idem |
| `voice.registry.state_updated` | debug | mute/deafen |
| `voice.webhook.received` | debug | um por webhook, com `event` do LiveKit |
| `voice.webhook.rejected` | warn | assinatura inválida ou corpo malformado |
| `voice.webhook.ignored` | info | com `outcome` explicando por quê |
| `voice.reconcile.started` | debug | inclui `rooms_queried` |
| `voice.reconcile.completed` | info | inclui `duration_ms`, `rooms_changed`, `participants_added`, `participants_removed`, `tracks_synced` |
| `voice.reconcile.failed` | warn | com `error` |
| `voice.reconcile.drift_detected` | **warn** | quando o reconcile encontra divergência; este é o evento mais importante de todos |
| `voice.token.issued` | info | com `mode` |
| `voice.token.refused` | info | com motivo (`not_member`, `channel_full`, `not_voice`) |
| `voice.delta.sent` | debug | com `recipients` e `reason` |
| `voice.snapshot.sent` | debug | com `rooms` e `trigger` |
| `voice.client.version_gap` | warn | cliente pediu snapshot por lacuna de versão |

`voice.reconcile.drift_detected` merece destaque: em regime saudável, o
reconcile a cada 15 s deve encontrar **zero** divergências, porque webhooks
mantêm o estado correto. Toda ocorrência é um webhook perdido ou uma corrida.
A taxa desse evento é a métrica de saúde número um do sistema.

### 1.3 Amostragem

Nada é amostrado. O volume é pequeno: uma comunidade de ~10 pessoas produz
poucas dezenas de eventos de voz por minuto no pior caso. Amostrar aqui
economizaria bytes e custaria diagnóstico.

## 2. Métricas

Não há stack de métricas hoje, e adicionar Prometheus em uma VM de 2 GB é peso
desproporcional. A v2 usa **contadores em memória expostos pelo endpoint de
debug** (§4), que é suficiente para o tamanho do sistema e custa alguns
`AtomicU64`.

```rust
pub struct VoiceMetrics {
    pub webhooks_received: AtomicU64,
    pub webhooks_ignored_stale: AtomicU64,
    pub webhooks_ignored_duplicate: AtomicU64,
    pub reconciles_run: AtomicU64,
    pub reconciles_with_drift: AtomicU64,
    pub participants_added_by_webhook: AtomicU64,
    pub participants_added_by_reconcile: AtomicU64,
    pub participants_removed_by_reconcile: AtomicU64,
    pub provisional_expired: AtomicU64,
    pub deltas_sent: AtomicU64,
    pub snapshots_sent: AtomicU64,
    pub version_gaps_reported: AtomicU64,
    pub tokens_issued: AtomicU64,
    pub tokens_refused: AtomicU64,
    pub last_reconcile_duration_ms: AtomicU64,
    pub last_reconcile_at_unix: AtomicU64,
}
```

Indicadores de saúde e seus limites de alerta:

| Indicador | Cálculo | Saudável | Investigar |
|---|---|---|---|
| Taxa de drift | `reconciles_with_drift / reconciles_run` | menor que 0,02 | maior que 0,10 |
| Confiabilidade do webhook | `participants_added_by_webhook / (webhook + reconcile)` | maior que 0,95 | menor que 0,80 |
| Lacunas de versão | `version_gaps_reported` por hora | 0 a 2 | maior que 10 |
| Provisórios expirados | `provisional_expired` por hora | 0 a 3 | maior que 10 |
| Duração do reconcile | `last_reconcile_duration_ms` | menor que 500 | maior que 2000 |

## 3. Logs do cliente

O cliente hoje escreve em `console` (`rtc.ts:91`, `nativeScreen.ts:49`) e no
`DebugLog` nativo (`client/native/Talkeando.Client/DebugLog.cs`), mas nada
disso chega ao operador.

SPEC-014 adiciona um ring buffer em memória na UI (últimos 500 eventos
estruturados) e o envio sob demanda para `POST /api/client-logs`, acionado por:

- o usuário clicando em "Enviar diagnóstico" nas configurações;
- automaticamente, no máximo uma vez a cada 10 minutos, quando ocorrer um dos
  gatilhos: erro de conexão de voz, lacuna de versão detectada, ou
  `Disconnected` com motivo diferente de `CLIENT_INITIATED`.

### Eventos do cliente que precisam existir

| Evento | Campos |
|---|---|
| `call.join.requested` | `channel_id`, `session_id` |
| `call.join.connected` | `channel_id`, `session_id`, `duration_ms`, `participant_sid` |
| `call.join.failed` | `channel_id`, `session_id`, `stage`, `reason` |
| `call.teardown` | `channel_id`, `session_id`, `trigger` |
| `call.superseded` | `session_id_antigo`, `session_id_novo` |
| `livekit.disconnected` | `reason` (nome do enum), `channel_id` |
| `livekit.reconnecting` / `.reconnected` | `channel_id`, `duration_ms` |
| `screen.publish.started` / `.published` / `.failed` | `capture_generation`, `track_sid`, `source_id`, `with_audio` |
| `screen.unpublish.started` / `.completed` | `capture_generation`, `track_sid` |
| `watch.requested` | `owner`, `track_sid` |
| `watch.subscribed` | `owner`, `track_sid`, `duration_ms` |
| `watch.first_frame` | `owner`, `track_sid`, `duration_ms` desde o `watch.requested` |
| `watch.stalled` | `owner`, `track_sid`, `seconds_without_frames` |
| `voice.version_gap` | `channel_id`, `local_version`, `received_previous`, `received_version` |
| `ws.state` | `state` |

`watch.first_frame` e `watch.stalled` são os dois eventos que provam ou refutam
RC-12 em produção. Se depois de SPEC-009 o `watch.first_frame` chegar
consistentemente em menos de 3 s e `watch.stalled` desaparecer, o bug de tela
está resolvido; se `watch.stalled` persistir, a causa é outra e a investigação
tem dados para continuar.

## 4. Endpoint de inspeção

`GET /api/debug/voice` (INV-G2). Autenticado, restrito ao owner da comunidade.

```json
{
  "server_version": "0.2.0",
  "uptime_seconds": 3812,
  "metrics": { "...": "todos os contadores da §2" },
  "rooms": [
    {
      "channel_id": "<uuid>",
      "channel_name": "*Canal Primário*",
      "version": 42,
      "reconciled_at_ago_ms": 4200,
      "participants": [
        {
          "user_id": "<uuid>",
          "display_name": "fulano",
          "participant_sid": "PA_xxx",
          "provisional": false,
          "muted": false,
          "deafened": false,
          "is_bot": false,
          "joined_at": "2026-09-02T18:04:11Z"
        }
      ],
      "tracks": [
        { "track_sid": "TR_xxx", "owner": "<uuid>", "source": "screen_share", "muted": false }
      ]
    }
  ],
  "connections": [
    { "user_id": "<uuid>", "connection_count": 1, "protocol_version": 2, "client_version": "1.4.0" }
  ]
}
```

O bloco `connections` responde diretamente à pergunta de version skew: quem
está em qual versão, agora.

`GET /api/debug/voice?live=1` faz um `ListRooms` e `ListParticipants` ao vivo e
devolve **a diferença** entre o LiveKit e o registry. Essa é a ferramenta de
diagnóstico definitiva: se a diferença for vazia, o servidor está correto e o
problema é do cliente.

## 5. O que passa a ser respondível

| Pergunta de produção | Como responder na v2 |
|---|---|
| "Sumiu todo mundo do canal X" | `GET /api/debug/voice?live=1`, olhar `rooms[X]` e a diferença |
| "Fulano aparece mas não fala" | ver `participants[fulano].provisional`; se `true`, a dica nunca foi confirmada |
| "Não consigo ver a tela do beltrano" | logs do cliente: `watch.requested` sem `watch.first_frame`, e `watch.stalled` |
| "Todo mundo caiu depois do deploy" | `voice.reconcile.completed` com `participants_added` alto logo após boot |
| "Está ruim desde a atualização" | `connections[].client_version` mostra a distribuição |
| "O webhook está funcionando?" | taxa de `participants_added_by_webhook` versus `_by_reconcile` |
| "O servidor está sob pressão?" | `last_reconcile_duration_ms` e o `restart_count` dos containers (SPEC-016) |

## 6. Retenção e acesso

- Logs do servidor: `docker compose logs` na Lightsail, retenção padrão do
  Docker. SPEC-016 configura `logging.options.max-size: 10m` e `max-file: 3`
  por serviço, para que os logs nunca encham o disco da VM de 2 GB.
- Logs de cliente enviados: gravados em `attachment_storage_path/_client_logs/`
  como JSON, um arquivo por envio, com limpeza automática após 7 dias no mesmo
  job de limpeza que já existe (`server/src/main.rs:140`).
