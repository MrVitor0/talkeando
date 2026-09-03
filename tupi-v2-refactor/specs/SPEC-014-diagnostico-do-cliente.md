# SPEC-014 — Diagnóstico do cliente: ring buffer e envio de logs

## 1. Problema

**Causa raiz:** RC-13 (lado cliente).

O cliente escreve em `console` (`client/ui/src/rtc.ts:91`,
`nativeScreen.ts:49`) e no `DebugLog` nativo
(`client/native/Talkeando.Client/DebugLog.cs`), mas nada disso chega ao
operador. Quando um usuário diz "não consigo ver a tela do fulano", não há como
saber se a assinatura foi pedida, se o SFU respondeu, ou se os frames pararam.

SPEC-002 deu visibilidade ao servidor. Metade dos sintomas relatados
(especialmente o 4) vive no cliente, e continua cego.

**Sintomas que desaparecem:** nenhum diretamente. Torna os sintomas 3, 4 e 5
diagnosticáveis e permite verificar os critérios de promoção de fase
(`08-rollout-plan.md` §6, que exige "zero ocorrências de `watch.stalled`").

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** SPEC-001 (`features`), SPEC-009 (emite `watch.*`).

As specs 007 a 013 já chamam `logClient(...)` no código que escrevem. Esta spec
implementa `logClient` e o transporte. Para que aquelas sejam entregáveis
antes desta, criar um stub mínimo em SPEC-007:

```ts
// client/ui/src/clientLog.ts — stub inicial, substituído por SPEC-014.
export function logClient(event: string, fields: Record<string, unknown> = {}) {
  console.info(`[tupi] ${event}`, fields);
}
```

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/clientLog.ts` | editar: ring buffer real |
| `client/ui/src/SettingsModal.tsx` | editar: botão "Enviar diagnóstico" |
| `client/ui/src/App.tsx` | editar: gatilhos automáticos |
| `client/native/Talkeando.Client/IpcBridge.cs` | editar: op `diagnostics.upload` |
| `client/native/Talkeando.Client/NetworkClient.cs` | editar: `UploadClientLogsAsync` |
| `server/src/routes/client_logs.rs` | criar |
| `server/src/routes/mod.rs` | editar: rota |
| `server/src/ws/mod.rs` | editar: `server_features` ganha `client.logs` |
| `server/src/main.rs` | editar: limpeza de logs antigos |

## 4. Mudança especificada

### 4.1 `client/ui/src/clientLog.ts`

```ts
/**
 * Ring buffer de diagnóstico. Fica em memória e só sai da máquina quando o
 * usuário pede ou quando um gatilho de erro dispara (com limite de taxa).
 *
 * NUNCA registrar: token de sessão, JWT do LiveKit, conteúdo de mensagem,
 * nome de arquivo compartilhado, título de janela capturada. Identidades
 * (user_id, channel_id, track_sid) são permitidas: são opacas e necessárias
 * para correlacionar com o log do servidor.
 */
export type ClientLogEntry = {
  at: string;            // ISO 8601
  event: string;
  fields: Record<string, unknown>;
};

const CAPACITY = 500;
const buffer: ClientLogEntry[] = [];

export function logClient(event: string, fields: Record<string, unknown> = {}) {
  const entry: ClientLogEntry = { at: new Date().toISOString(), event, fields: sanitize(fields) };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.shift();
  if (import.meta.env.DEV) console.info(`[tupi] ${event}`, entry.fields);
}

export function snapshotLogs(): ClientLogEntry[] { return [...buffer]; }
export function clearLogs(): void { buffer.length = 0; }
```

`sanitize` é a proteção que não pode falhar:

```ts
const FORBIDDEN_KEYS = /token|secret|password|authorization|jwt|credential/i;
const MAX_VALUE_LENGTH = 200;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.test(key)) { output[key] = "[redacted]"; continue; }
    if (typeof value === "string") {
      output[key] = value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value;
    } else {
      output[key] = String(value).slice(0, MAX_VALUE_LENGTH);
    }
  }
  return output;
}
```

Rejeitar objetos aninhados (convertendo para string truncada) é deliberado:
impede que alguém passe um objeto de erro do SDK contendo um token na URL.

### 4.2 Contexto e envio

```ts
export type DiagnosticsReport = {
  client_version: string;
  protocol_version: number;
  server_version: string;
  reason: string;
  collected_at: string;
  context: {
    channel_id: string | null;
    call_state: string;
    participants: number;
    watching: number;
    sharing: boolean;
    connection_state: string;
    user_agent: string;
  };
  entries: ClientLogEntry[];
};

export function buildReport(reason: string): DiagnosticsReport;

/** Envia pelo host nativo (que tem o token). Devolve true se aceito. */
export async function sendDiagnostics(reason: string): Promise<boolean>;
```

`sendDiagnostics` emite `send("diagnostics.upload", { report })` e espera
`diagnostics.uploaded` ou `diagnostics.failed`, com timeout de 10 s. O padrão é
o mesmo de `credentials` (`client/ui/src/rtc.ts:148-163`).

Limite de taxa e gatilhos automáticos:

```ts
const AUTO_INTERVAL_MS = 10 * 60 * 1000;
let lastAutoSendAt = 0;

/** Gatilhos automáticos: erro de conexão de voz, lacuna de versão,
 *  desconexão não solicitada, e travamento de tela. No máximo um envio a
 *  cada 10 minutos, para não virar telemetria contínua. */
export function maybeAutoSend(reason: AutoTrigger) {
  const now = Date.now();
  if (now - lastAutoSendAt < AUTO_INTERVAL_MS) return;
  lastAutoSendAt = now;
  void sendDiagnostics(`auto:${reason}`);
}

export type AutoTrigger = "join_failed" | "version_gap" | "unexpected_disconnect" | "watch_stalled";
```

Chamar `maybeAutoSend` em quatro pontos, todos já existentes nas specs
anteriores:

| Ponto | Gatilho |
|---|---|
| `App.tsx`, `catch` de `joinCall` (SPEC-007 §4.5) | `join_failed` |
| `voiceStore.applyDelta`, ramo de lacuna (SPEC-008 §4.3) | `version_gap` |
| `App.tsx`, `onCallDisconnected` com razão não nula (SPEC-007 §4.5) | `unexpected_disconnect` |
| `remoteMedia.monitorStall` (SPEC-009 §4.6) | `watch_stalled` |

### 4.3 Botão manual

Em `SettingsModal.tsx`, na aba de voz, adicionar uma seção ao final:

```tsx
<div className="settings-section">
  <div className="settings-section__title">Diagnóstico</div>
  <p className="settings-hint">
    Envia os últimos eventos de conexão para quem administra o Tupi. Não inclui
    mensagens, áudio, vídeo nem senhas.
  </p>
  <button className="settings-button" disabled={sending} onClick={onSendDiagnostics}>
    {sending ? "Enviando…" : diagnosticsSent ? "Enviado" : "Enviar diagnóstico"}
  </button>
</div>
```

A frase sobre o que não é incluído é obrigatória: o usuário precisa saber o que
está enviando.

### 4.4 `IpcBridge.cs` e `NetworkClient.cs`

```csharp
case "diagnostics.upload":
{
    var report = root.GetProperty("data").GetProperty("report");
    try
    {
        await _network.UploadClientLogsAsync(report);
        Publish("diagnostics.uploaded", new { });
    }
    catch (Exception exception)
    {
        DebugLog.Write($"Diagnostics upload failed: {exception.Message}");
        Publish("diagnostics.failed", new { message = exception.Message });
    }
    break;
}
```

```csharp
/// Envia o relatório de diagnóstico da UI. O token de sessão fica aqui,
/// nunca no WebView.
public async Task UploadClientLogsAsync(JsonElement report)
{
    using var request = new HttpRequestMessage(HttpMethod.Post, "client-logs")
    {
        Content = new StringContent(report.GetRawText(), Encoding.UTF8, "application/json"),
    };
    AddAuthorization(request);
    using var response = await _http.SendAsync(request);
    if (!response.IsSuccessStatusCode)
        throw new InvalidOperationException("Não foi possível enviar o diagnóstico.");
}
```

O nativo também tem contexto útil que a UI não tem: o `DebugLog` recente.
Anexar as últimas 100 linhas dele ao relatório antes de enviar:

```csharp
var payload = JsonNode.Parse(report.GetRawText())!.AsObject();
payload["native_log"] = JsonSerializer.SerializeToNode(DebugLog.Tail(100));
```

Isso exige `DebugLog.Tail(int)`, que hoje não existe
(`DebugLog.cs` tem 28 linhas e só escreve). Adicionar, lendo as últimas linhas
do arquivo.

### 4.5 `server/src/routes/client_logs.rs`

```rust
//! Recebe relatórios de diagnóstico do cliente. Guardados como arquivos JSON
//! ao lado dos anexos, limpos junto com eles.

use axum::{extract::State, Json};
use serde::Deserialize;

use crate::{auth::AuthUser, error::{AppError, AppResult}, state::AppState};

/// Teto de tamanho: 500 entradas com campos curtos cabem folgadamente.
const MAX_BODY_BYTES: usize = 512 * 1024;
/// Um relatório por usuário a cada 60 s.
const MIN_INTERVAL: Duration = Duration::from_secs(60);

pub async fn upload(
    State(state): State<AppState>,
    auth: AuthUser,
    body: String,
) -> AppResult<Json<serde_json::Value>> {
    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::PayloadTooLarge);
    }
    if !state.allow_client_log(auth.user.id).await {
        return Err(AppError::RateLimited);
    }
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| AppError::Validation("relatório inválido".into()))?;

    let reason = parsed.get("reason").and_then(|v| v.as_str()).unwrap_or("unknown");
    let client_version = parsed.get("client_version").and_then(|v| v.as_str()).unwrap_or("unknown");
    tracing::info!(
        event = "client.diagnostics.received",
        user_id = %auth.user.id,
        reason,
        client_version,
        bytes = body.len(),
    );

    let dir = std::path::Path::new(&state.config.attachment_storage_path).join("_client_logs");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Internal(e.into()))?;
    let name = format!("{}-{}.json", chrono::Utc::now().format("%Y%m%dT%H%M%SZ"), auth.user.id);
    tokio::fs::write(dir.join(name), &body).await.map_err(|e| AppError::Internal(e.into()))?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
```

`AppError::PayloadTooLarge` e `AppError::RateLimited` já existem
(`server/src/error.rs:29`, `:33`).

`allow_client_log` segue o padrão de `check_login_rate_limit`
(`server/src/state.rs:493`), com janela de 60 s e máximo de 1.

Limpeza: no `spawn_attachment_cleanup` (`server/src/main.rs:140-175`), que já
roda de hora em hora, adicionar a remoção de arquivos de `_client_logs` com
mais de 7 dias.

O diretório fica dentro de `attachment_storage_path`, que já é um volume
persistente (`infra/docker-compose.production.yml:20`), então os relatórios
sobrevivem a um redeploy, que é exatamente quando eles são mais úteis.

### 4.6 Leitura pelo operador

Nenhuma interface. O operador lê por SSH:

```bash
docker compose -f docker-compose.production.yml exec tupi-server \
  ls -lt /var/lib/tupi/attachments/_client_logs | head -20
```

Adicionar essa receita a `infra/README.production.md`, junto de um exemplo de
`jq` para filtrar eventos:

```bash
jq -r '.entries[] | select(.event | startswith("watch.")) | "\(.at) \(.event) \(.fields)"' relatorio.json
```

Interface web para isso é desproporcional para uma comunidade de dez pessoas.

## 5. Contratos de dados

`POST /api/client-logs`, corpo = `DiagnosticsReport` de §4.2, mais
`native_log: string[]` adicionado pelo host.

Respostas: `200 {"ok": true}`, `413` (grande demais), `429` (limite),
`400` (JSON inválido), `401` (sem sessão).

## 6. Casos de borda a tratar

1. Relatório com mais de 512 KB: `413`. O cliente não reenvia.
2. Segundo envio em menos de 60 s: `429`. O cliente mostra "tente novamente em
   instantes" no caso manual e ignora no caso automático.
3. Disco cheio: `500` com log; o cliente mostra falha. Não é crítico.
4. Campo `fields` com objeto aninhado: `sanitize` converte para string
   truncada.
5. Chave contendo `token`: substituída por `[redacted]`, mesmo que o valor seja
   inofensivo.
6. Buffer vazio (envio logo após abrir o app): relatório com `entries: []` é
   aceito; o contexto ainda é útil.
7. `DebugLog.Tail` com arquivo inexistente: devolve lista vazia.
8. Usuário sem sessão: `401`, e o botão nem aparece (a aba de configurações
   exige estar autenticado).
9. Envio automático durante um pico de erros: o limite de 10 min no cliente e
   de 60 s no servidor impedem enxurrada.

## 7. Critérios de aceite

- **Dado** um usuário autenticado clicando em "Enviar diagnóstico", **então**
  um arquivo JSON aparece em `_client_logs` com os eventos recentes.
- **Dado** um campo chamado `access_token` em um log, **então** o valor gravado
  é `[redacted]`.
- **Dado** dois envios em 30 s, **então** o segundo recebe `429`.
- **Dado** um relatório de 1 MB, **então** recebe `413`.
- **Dado** uma falha de conexão de voz, **então** um envio automático ocorre, e
  um segundo erro em menos de 10 min **não** dispara outro.
- **Dado** um relatório recebido, **então** existe um log de servidor
  `client.diagnostics.received` com `reason` e `client_version`.
- **Dado** um relatório com mais de 7 dias, **então** a limpeza horária o
  remove.

## 8. Como testar

### Automatizado

`client/ui/src/clientLog.test.ts`:

| Teste | Cenário |
|---|---|
| `redacts_forbidden_keys` | `token`, `authorization`, `jwt` |
| `truncates_long_strings` | mais de 200 caracteres |
| `ring_buffer_keeps_last_500` | 600 entradas |
| `auto_send_respects_interval` | dois gatilhos em 1 min, um envio |
| `nested_objects_become_strings` | |

`server/tests/client_logs_test.rs`:

| Teste | Cenário |
|---|---|
| `upload_requires_authentication` | `401` |
| `upload_writes_a_file` | |
| `upload_rejects_oversized_body` | `413` |
| `upload_rate_limits_per_user` | `429` |

### Manual

1. Provocar uma falha de voz (parar o container do LiveKit e tentar entrar).
2. Confirmar que o envio automático ocorreu (log do servidor).
3. Abrir o arquivo e verificar que a sequência `call.join.requested` até
   `call.join.failed` está lá com o motivo.
4. Conferir que não há nenhum token no arquivo, com
   `grep -iE "token|bearer|secret" relatorio.json`.

O passo 4 é obrigatório e precisa ser registrado no PR.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Vazamento de segredo no log | `sanitize` por chave, truncamento, e a verificação manual obrigatória de §8 |
| Usuário achar que é telemetria escondida | Envio manual é explícito e explicado; o automático é limitado e só em erro. Comunicar no aviso de rollout (`08-rollout-plan.md` §7) |
| Disco da VM enchendo | Teto por relatório, limite de taxa, limpeza de 7 dias |
| Ring buffer consumindo memória | 500 entradas com campos curtos, na ordem de dezenas de KB |

**Rollback:** `git revert`. O cliente volta a só logar no console.

## 10. Fora de escopo

- Não construir interface de leitura de logs.
- Não enviar logs continuamente nem em background sem gatilho.
- Não coletar métricas de uso, telemetria de produto ou dados de performance
  que não sejam os eventos listados em `06-observability.md` §3.
- Não mudar o `DebugLog` nativo além de adicionar `Tail`.
