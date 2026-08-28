# Activity (Rich Presence) — Specification

Status: Draft v1
Owner/Domain: Backend (`server/src/ws/activity.rs`), Client native
(`client/native/Talkeando.Client/ActivityMonitor.cs`), Client UI
(`client/ui/src/App.tsx` — `ActivityPanel`)
Related canon sections: §5 (signaling ops), §6 (ephemeral state), §9 (ID
catalog). Adjacente a `specs/presence.md` (mesma família de estado efêmero
derivado da conexão) e a `specs/calls.md` (mesmo padrão snapshot + update).

## Objetivo

Mostrar, ao lado da `MemberSidebar`, o que cada membro está fazendo fora do
Talkeando — a música tocando ("Ouvindo Spotify — Artista – Faixa"), o jogo
aberto ("Jogando Rocket League", com tempo de sessão), o navegador em uso —
no estilo do painel "Atividade — N" do Discord. A detecção acontece **no
cliente nativo Windows**; o servidor apenas guarda o último estado reportado
(em memória, nunca persistido na v1) e o repassa para os outros membros da
comunidade.

## Contexto

O Discord não "intercepta apps" de forma genérica. São quatro fontes
independentes, e esta spec só adota as duas primeiras na v1:

| Fonte | O que entrega | Mecanismo | Fase |
|---|---|---|---|
| **SMTC** (`GlobalSystemMediaTransportControlsSessionManager`) | Qualquer mídia tocando: Spotify desktop, YouTube no browser, VLC… título, artista, álbum, posição, play/pause, capa | API WinRT nativa (TFM já é `net6.0-windows10.0.19041.0`) | 1 |
| **Detecção de jogo** | Nome do jogo + arte | Registry do Steam (`HKCU\Software\Valve\Steam\RunningAppID` → arte do CDN), enumeração de processos + ícone do `.exe`, lista curada `exe → nome` | 2 |
| **Tempo de jogo** | "Jogou 29h", "2h atrás", "Novo jogador" | Agregação server-side de sessões de jogo (**única parte com DB**) | 3 |
| **Discord RPC pipe** | Rich presence detalhada que o próprio jogo empurra | Escutar `\\.\pipe\discord-ipc-0` quando o Discord não está aberto | 4 (opcional) |

A "atividade" é conceitualmente irmã da presença: derivada do que o cliente
observa, efêmera, reconstruída do zero a cada reconexão, nunca uma fonte de
verdade persistida (canon §6). Ela é transmitida em ops próprias
(`activity.*`), **não** embutida em `presence.*` — os dois são adjacentes na
UI mas são fluxos de dados separados no protocolo, exatamente como
`specs/presence.md` já observa para a ocupação de canal de voz.

## Escopo

- Cliente nativo: `ActivityMonitor` que observa o SMTC (Fase 1) e, depois,
  processos/Steam (Fase 2); debounce; só reporta em mudança.
- Op `activity.report` (C→S): o cliente envia sua **lista completa e atual**
  de atividades (0..4). Substitui o que o servidor tinha para aquele usuário.
- Op `activity.snapshot` (S→C, uma vez após `presence.snapshot`): estado de
  atividade de todos os membros da comunidade que têm atividade não-vazia.
- Op `activity.update` (S→C, broadcast): a lista de atividades de um usuário
  mudou (lista vazia = limpou).
- Registro de atividade em memória no `Hub` (`HashMap<UserId, Vec<Activity>>`),
  ao lado do `CallRegistry`.
- Limpeza da atividade de um usuário quando sua última conexão cai (piggyback
  no mesmo grace period de 8s da presença — ver `specs/presence.md`
  PRES-FR-003).
- `ActivityPanel` na UI React: cabeçalho "Atividade — N" acima da
  `MemberList`, uma linha por atividade com ícone por tipo, nome, `details`,
  `state` e cronômetro de sessão ao vivo.
- Toggle de privacidade "Compartilhar atividade" (default ligado, paridade
  com o Discord), na `voice-panel`/cabeçalho de membros.

## Fora de escopo

- **Fora de escopo por completo** (não há fase): integração OAuth com
  Spotify (o SMTC já cobre o Spotify desktop tocando localmente; o caso
  "tocando no celular com o desktop fechado" fica de fora); resolver o CDN
  de assets do Discord para as image keys da rich presence (viram texto);
  IGDB/SteamGridDB para key art melhor; merge de atividade multi-dispositivo.
- **Faseado, não "fora de escopo"**: detecção de jogo (Fase 2), tempo de
  jogo (Fase 3), Discord RPC pipe (Fase 4), arte de álbum/jogo (Fase 2 para
  jogo, Fase 5 para álbum). A Fase 1 manda `asset_image: null`.
- Persistência de qualquer atividade em si. Só o **agregado** de tempo de
  jogo (Fase 3) toca o banco, e ainda assim nunca guarda "o que está tocando
  agora".
- Atividade em plataformas não-Windows (não há cliente não-Windows).
- Histórico/timeline de atividade ("você jogou isso ontem"). Fora de escopo
  além do agregado simples da Fase 3.
- Status custom escrito à mão ("Estou ficando louco!") — isso é o campo de
  status de `specs/presence.md`'s "Future considerations", não atividade.

## User stories

- Como membro, vejo no topo da barra lateral um painel "Atividade — N" com
  quem está ouvindo algo ou jogando algo agora, com o tempo decorrido.
- Como membro ouvindo Spotify, os outros veem "Ouvindo Spotify — <artista> –
  <faixa>" atualizar em alguns segundos quando eu troco de música, e sumir
  quando eu pauso.
- Como membro, posso desligar "Compartilhar atividade" e paro imediatamente
  de aparecer no painel de todo mundo.
- Como membro reconectando após um blip de rede, minha atividade não
  pisca/some para os outros dentro da janela de graça.
- Como membro, quando outro fecha o jogo/app, a linha dele some do painel em
  ~1s sem refresh manual.

## Functional requirements

- **ACT-FR-001**: `activity.report` (C→S): `{ activities: [Activity], req_id?:
  string }`. É fire-and-forget (sem ack, como `chat.typing` —
  `specs/chat.md` CHAT-FR-004): o servidor não emite evento de sucesso.
  `req_id` é aceito mas ignorado na v1 (reservado). O payload é a lista
  **inteira** do estado atual do cliente, não um delta.
- **ACT-FR-002**: `Activity` é `{ kind: "playing" | "listening" | "watching"
  | "browsing", name: string, details?: string | null, state?: string |
  null, started_at?: string(RFC3339) | null, asset_image?: string | null,
  asset_text?: string | null }`.
  - `name`: a fonte/app ("Spotify", "Rocket League", "Firefox").
  - `details`: linha 1 sob o nome ("Artista – Faixa", "Ranked Duos").
  - `state`: linha 2 ("no álbum X", "Em partida").
  - `started_at`: início da atividade/sessão, para o cronômetro do cliente.
  - `asset_image`: **Fase 1 sempre `null`**. Fase 2+: um ref opaco resolvido
    pela UI (`att:<uuid>` de attachment, `steam:<appid>`, ou URL absoluta de
    um host permitido). O servidor nunca busca a imagem, só repassa a string.
  - `asset_text`: tooltip/legenda do asset ("álbum X").
- **ACT-FR-003**: Validação no servidor (clamp, não rejeição — coerente com
  "efêmero, sem ack"): `activities` truncada em 4 itens; `kind` fora do
  allowlist → item descartado; `name` vazio → item descartado; `name` ≤ 128
  chars, `details`/`state`/`asset_text` ≤ 256, `asset_image` ≤ 512 (campos
  além do limite são truncados). Envelope totalmente malformado cai no
  `parse_or_reject!` genérico do handler (retorna `error { bad_request }`).
- **ACT-FR-004**: Ao receber um `activity.report` válido, o servidor
  substitui `ActivityRegistry[user_id]` pela lista saneada. Se a lista
  saneada é **diferente** da anterior (comparação estrutural), o servidor
  faz broadcast de `activity.update { user_id, activities }` para todos os
  membros que compartilham comunidade com o remetente (mesma lista de
  destinatários de `presence.update`, via `db::related_member_ids`),
  **incluindo o próprio remetente** (para clientes multi-dispositivo
  convergirem). Se é igual, não há broadcast (dedupe — evita chatter quando
  o poll do cliente re-observa o mesmo estado).
- **ACT-FR-005**: Imediatamente após enviar `presence.snapshot` a uma
  conexão recém-autenticada (ver `specs/presence.md` PRES-FR-002), o
  servidor envia também `activity.snapshot { users: [{ user_id, activities
  }] }` **apenas** com os membros cuja lista de atividades é não-vazia
  (membros sem atividade são omitidos; o cliente assume lista vazia para
  qualquer `user_id` ausente). Enviado só para a conexão nova.
- **ACT-FR-006**: Quando a **última** conexão de um usuário cai, a limpeza
  da atividade acontece no mesmo `tokio::spawn` atrasado que já cuida do
  offline da presença (`specs/presence.md` PRES-FR-003 / `ws/handler.rs`):
  após os 8s de graça, se o usuário continua sem conexão, o servidor limpa
  `ActivityRegistry[user_id]` e, se havia algo, faz broadcast de
  `activity.update { user_id, activities: [] }`. Se uma nova conexão do
  mesmo usuário chega dentro da janela, a limpeza é cancelada junto com a
  transição de offline (sem broadcast de piscada).
- **ACT-FR-007**: Ir de 2→1 conexões vivas **não** limpa a atividade (o
  usuário ainda está online por outra conexão). A atividade efetiva é a do
  último `activity.report` recebido de **qualquer** conexão daquele usuário
  (last-writer-wins; não há merge por conexão na v1 — o caso normal é um PC
  só rodando o monitor).
- **ACT-FR-008**: `activity.config` (IPC UI→Native, **não** é op de
  WebSocket): `{ enabled: bool }`. Com `enabled=false` o `ActivityMonitor`
  para de observar e envia um único `activity.report { activities: [] }`;
  com `true` ele (re)inicia a observação. A UI persiste a escolha em
  `localStorage` (`tk.shareActivity`, default `"on"`) e reenvia o valor no
  bootstrap. Default: ligado.
- **ACT-FR-009** (Fase 1 — SMTC): o `ActivityMonitor` usa
  `GlobalSystemMediaTransportControlsSessionManager.RequestAsync()` e
  observa `CurrentSessionChanged` + `MediaPropertiesChanged` +
  `PlaybackInfoChanged` da sessão corrente, com um poll de segurança a cada
  ~10s. Só reporta quando `PlaybackStatus == Playing`. Mapeamento:
  - `kind`: `PlaybackType == Video` → `"watching"`, senão `"listening"`.
  - `name`: mapa curado a partir de `Session.SourceAppUserModelId`
    (`Spotify.exe` → "Spotify", AUMID do Spotify Store → "Spotify",
    `chrome`/`msedge`/`firefox` → nome do navegador…), fallback para o
    próprio AUMID ou "Mídia".
  - `details`: `MediaProperties.Title`.
  - `state`: `MediaProperties.Artist` (ou `AlbumArtist` se `Artist` vazio).
  - `asset_text`: `MediaProperties.AlbumTitle`.
  - `started_at`: `Timeline.LastUpdatedTime - Timeline.Position` se
    plausível, senão o instante em que o título mudou.
  - `asset_image`: `null` na Fase 1.
  Pausar/parar/fechar a mídia → `activity.report { activities: [] }`.
- **ACT-FR-010**: Debounce no cliente: no mínimo 4s entre `activity.report`
  consecutivos; mudanças mais rápidas são coalescidas (envia o estado final
  quando o timer expira). Uma transição para lista vazia (parou tudo) fura o
  debounce e vai na hora.
- **ACT-FR-011**: `ActivityPanel` (React), renderizado no topo do
  `<aside className="members">`, acima da `MemberList`: cabeçalho
  "Atividade — N" (N = total de membros com atividade), e para cada membro
  com atividade uma linha por `Activity` contendo: ícone por `kind`, o
  `name` em destaque, `details`, `state`, e — se `started_at` presente — um
  cronômetro ao vivo (`H:MM:SS` acima de 1h, `MM:SS` abaixo) que avança
  client-side 1×/s enquanto o painel está montado. Sem atividade nenhuma na
  comunidade, o painel inteiro não renderiza.
- **ACT-FR-012**: O cliente descarta `activity.update`/`activity.snapshot`
  para `user_id`s que não estão na lista de membros carregada (defesa —
  nunca deve acontecer, o fan-out é community-scoped).
- **ACT-FR-013**: Ao reconectar (novo `auth.ok`), o cliente substitui o
  mapa de atividade inteiro pelo `activity.snapshot` fresco (nunca faz
  patch/diff contra o mapa pré-desconexão), espelhando a regra de
  `specs/presence.md` "Recovery behavior".
- **ACT-FR-014** (privacidade): enquanto "Compartilhar atividade" está
  desligado, o cliente nunca envia `activity.report` com lista não-vazia —
  nem no bootstrap, nem em mudança de mídia. O servidor não tem noção de
  "atividade privada": simplesmente nunca recebe nada para transmitir.

### Fase 2 (detecção de jogo) — requisitos

- **ACT-FR-020**: `ActivityMonitor` ganha um poller de processos (~10s):
  `Process.GetProcesses()` + caminho do executável + título da janela em
  primeiro plano + heurística de fullscreen. Um processo casado com a lista
  curada (ou com o Steam, ver ACT-FR-021) vira uma `Activity { kind:
  "playing", name: <jogo>, started_at: <primeira observação> }`.
- **ACT-FR-021**: Se `HKCU\Software\Valve\Steam\RunningAppID` != 0, resolve
  o `appid` → nome via `.../steamapps/appmanifest_<appid>.acf` (chave
  `name`) e `asset_image = "steam:<appid>"`; a UI resolve `steam:<appid>`
  para `https://cdn.cloudflare.steamstatic.com/steam/apps/<appid>/header.jpg`
  (host adicionado ao allowlist de imagem da UI / CSP do WebView).
- **ACT-FR-022**: Sem match no Steam nem na lista curada, o fallback é o
  ícone do próprio `.exe` (`Icon.ExtractAssociatedIcon` → PNG) enviado uma
  única vez a um endpoint de asset (`POST /api/activity-assets`, dedupe por
  hash de conteúdo, ver `08-api-design.md` a adicionar), com
  `asset_image = "att:<id>"`. Nome = título da janela higienizado ou nome do
  produto do `FileVersionInfo`.
- **ACT-FR-023**: `started_at` de um jogo é a primeira vez que o monitor o
  viu **nesta sessão do app**; fechar e reabrir o jogo reinicia a contagem
  (não há persistência na Fase 2 — isso é a Fase 3).

### Fase 3 (tempo de jogo) — requisitos

- **ACT-FR-030**: Migration `0004_game_sessions.sql`: tabela `game_sessions
  (id uuid pk, user_id uuid fk, game_key text, game_name text, started_at
  timestamptz, ended_at timestamptz null)`, índice `(user_id, game_key)` e
  `(user_id, started_at desc)`. `game_key` = `"steam:<appid>"` ou
  `"exe:<sha1-do-caminho>"`.
- **ACT-FR-031**: O servidor abre uma linha `game_sessions` quando um
  `activity.report` introduz um jogo que o usuário não tinha no report
  anterior; fecha (`ended_at = now()`) quando o jogo sai do report seguinte
  ou a conexão cai (reaproveitando o grace path). Sessões "penduradas" de um
  restart do servidor são fechadas com `ended_at = started_at` no startup
  (não dá para saber a duração real).
- **ACT-FR-032**: `activity.snapshot`/`activity.update` de um jogo ganham
  campos derivados **read-only** calculados pelo servidor: `total_seconds`
  (soma de `game_sessions` do par usuário/jogo), `last_played_at`, e
  `is_new` (`true` se a 1ª sessão do usuário nesse jogo tem < 24h). A UI usa
  isso para "Jogou 29h", "2h atrás", "Novo jogador".
- **ACT-FR-033**: Nenhum dado de "o que está tocando" é persistido — só
  `game_sessions`. Mídia (Spotify etc.) nunca gera linha nenhuma.

### Fase 4 (Discord RPC pipe) — requisitos (opcional)

- **ACT-FR-040**: Se nenhum processo `Discord*.exe` está rodando, o
  `ActivityMonitor` cria o named pipe `\\.\pipe\discord-ipc-0` e implementa
  o handshake mínimo do IPC do Discord (frame: `int32 opcode` + `int32 len`
  + JSON UTF-8; `op 0` handshake, `op 1` frame, `op 2` close). Jogos com
  `discord-rpc`/`discord-game-sdk` conectam e mandam
  `SET_ACTIVITY` com `{ state, details, timestamps: { start }, assets: {
  large_image, large_text, small_image, small_text }, party, ... }`.
- **ACT-FR-041**: Um `SET_ACTIVITY` recebido vira uma `Activity { kind:
  "playing", name: <nome do app registrado no handshake / client_id
  resolvido>, details, state, started_at: timestamps.start }`. As
  `large_image`/`small_image` são chaves de asset do app Discord do jogo —
  na Fase 4 ficam como `asset_text` textual apenas (resolver o CDN de
  assets do Discord fica fora de escopo).
- **ACT-FR-042**: O pipe é liberado assim que um `Discord*.exe` aparece (o
  Discord real tem prioridade; não brigamos pelo pipe). Documentar que
  Fase 4 e o Discord aberto ao mesmo tempo são mutuamente exclusivos.

## Non-functional requirements

- Fan-out de `activity.update`: < 1s da recepção do `activity.report` ao
  outro cliente receber (mesma classe de orçamento de `presence.update`,
  reusa o mesmo `broadcast_to`).
- Custo do registro: O(tamanho da comunidade) para snapshot; `set`/`clear`
  são O(1) amortizado. Trivial em ~10 usuários.
- Overhead do `ActivityMonitor` no cliente: o poll de mídia/processos a cada
  ~10s não deve custar CPU perceptível; enumeração de processos sem abrir
  handles de processos de outros usuários.
- Nenhuma escrita em disco no caminho de atividade na Fase 1 (a config de
  privacidade é `localStorage`, lado UI).

## UX behavior

- O painel aparece/some sozinho conforme há ou não atividade na comunidade;
  não ocupa espaço quando vazio.
- Uma nova atividade entra com um fade simples (não obrigatório); o
  cronômetro começa de onde `started_at` indica (pode já iniciar em "3:12"
  se o app já estava aberto quando o membro conectou).
- Trocar de música no Spotify atualiza `details`/`state` in place, sem
  recriar a linha (key estável por `user_id` + `kind` + `name`).
- Desligar "Compartilhar atividade" remove minha(s) linha(s) do painel de
  todo mundo em ~1s; religar volta a reportar o estado atual no próximo
  tick.
- Reconnect banner (ver `flows/reconnect.md`): enquanto a barra lateral está
  em estado "stale", o painel de atividade também é esmaecido junto (mesma
  regra visual da `MemberSidebar`), não descartado, até o
  `activity.snapshot` fresco chegar.

## UI states

- Painel: ausente (nenhuma atividade), presente-fresco, presente-stale
  (durante reconexão).
- Linha de atividade: com cronômetro / sem cronômetro (`started_at` ausente);
  com asset / sem asset (Fase 1 é sempre sem).
- Toggle: compartilhando / não compartilhando.

## API contracts

Nenhuma na Fase 1 (atividade é WS-only, como presença). Fase 2 adiciona
`POST /api/activity-assets` + `GET /api/activity-assets/{id}` (dedupe por
hash, ver `08-api-design.md` / `contracts/rest-api.md` a atualizar). Fase 3
não adiciona REST (os agregados vão embutidos nos eventos `activity.*`).

## WebSocket events

```
activity.report (C->S, fire-and-forget, sem ack — como chat.typing)
  { activities: [Activity], req_id?: string }
  Activity = {
    kind: "playing" | "listening" | "watching" | "browsing",
    name: string,
    details?: string | null,
    state?: string | null,
    started_at?: string | null,   // RFC3339
    asset_image?: string | null,  // Fase 1: sempre null
    asset_text?: string | null
  }

activity.snapshot (S->C, uma vez, logo após presence.snapshot)
  { users: [{ user_id: uuid, activities: [Activity] }] }   // só membros com atividade não-vazia

activity.update (S->C, broadcast em qualquer mudança, inclui o próprio remetente)
  { user_id: uuid, activities: [Activity] }                // [] = limpou
```
Sem ops C→S além de `activity.report`. Erros: só `error { code:
"bad_request" }` para envelope malformado (o resto é clamp silencioso).

Fase 3 acrescenta, em cada `Activity` de `kind: "playing"` dentro de
`activity.snapshot`/`activity.update`, os campos derivados read-only
`total_seconds`, `last_played_at`, `is_new`.

## IPC contracts

```
activity.config (UI -> Native)
  { enabled: bool }
```
Native → UI: nenhum op novo. `activity.snapshot`/`activity.update` chegam
pelo WebSocket e são repassados à UI pelo relay genérico
(`IpcBridge.HandleNetworkEvent` → `Publish(op, data)`) — com **uma**
transformação: todo `asset_image: "att:<hash>"` é trocado por um `data:` URI
(o host busca o asset com o token e faz base64; cache por hash), para o
WebView nunca precisar falar com a origem da API. Refs `steam:`/`https:`
passam intactas.

## Data model

Fase 1–2: **nenhuma tabela** — o `ActivityRegistry` é
`HashMap<UserId, Vec<Activity>>` em memória no `Hub`, reconstruído vazio a
cada restart (canon §6, igual a presença e call). Fase 3: `game_sessions`
(ver ACT-FR-030) — a única tabela desta feature, e ainda assim só o
agregado de duração, nunca o "agora tocando".

## State transitions

Por usuário: `sem_atividade` → `com_atividade` (primeiro `activity.report`
não-vazio) → `com_atividade'` (mudanças in place) → `sem_atividade`
(`activity.report` vazio, toggle desligado, ou última conexão caída + 8s de
graça). Nenhuma transição toca disco na Fase 1.

## Concurrency model

- `Hub.activities: RwLock<ActivityRegistry>` — leituras (snapshot) frequentes
  e baratas, escritas (`set`/`clear`) serializadas, mesmo padrão de
  `Hub.calls`. Nunca segurar o lock durante o `broadcast_to` (soltar, depois
  transmitir), consistente com o resto do `ws/handler.rs`.
- A limpeza no disconnect roda dentro do mesmo `tokio::spawn` atrasado da
  presença e é guardada pelas mesmas checagens (`is_online`,
  `presence_epoch_is_current`, `finish_offline_grace`) — não há task
  separada nem novo epoch para atividade.
- `activity.report` de conexões concorrentes do mesmo usuário: last-writer-
  wins sob o `write()` lock; sem merge (ACT-FR-007).

## Security considerations

- `user_id` em todo payload S→C é sempre a identidade autenticada da conexão
  remetente, nunca vinda do payload do cliente (idêntico a presença/chat).
- Fan-out é community-scoped (`db::related_member_ids`) — atividade nunca
  vaza para fora da comunidade.
- A atividade revela nome de app/jogo/música e tempo de sessão a membros já
  autenticados da mesma comunidade — aceitável numa comunidade fechada de
  ~10 pessoas, e mitigado pelo toggle de opt-out (ACT-FR-008/014). Nenhum
  caminho de arquivo, PID, título de janela cru ou dado de hardware é
  transmitido (o título de janela é sanitizado para virar só um nome na
  Fase 2).
- O servidor nunca busca `asset_image` (sem SSRF): é string opaca repassada;
  a UI resolve contra um allowlist fixo de hosts.
- Fase 4: criar o named pipe do Discord só quando o Discord real não está
  rodando; nunca injetar nada em processo nenhum (só leitura do próprio
  `Process` list e escuta de um pipe local).

## Failure modes

- `RequestAsync()` do SMTC indisponível/negado: o monitor loga e fica
  inerte; nenhuma atividade de mídia é reportada (não é erro fatal do app).
- `activity.report` chega antes do WebSocket estar `Open` (corrida no
  bootstrap): `SendWebSocketAsync` lança, o monitor engole e tenta de novo
  no próximo tick.
- Restart do servidor: todo mundo aparece sem atividade até o próximo
  `activity.report` de cada cliente (esperado; o poll de ~10s reidrata).
- Membro com o app fechado que trava sem `activity.report` de limpeza: a
  atividade some junto com o offline da presença (grace de 8s) quando a
  conexão cai; enquanto a conexão viver, a linha pode ficar "presa" — limite
  aceito, igual ao de presença.

## Recovery behavior

- Reconexão do cliente: no novo `auth.ok`, recebe `presence.snapshot` e em
  seguida `activity.snapshot`; substitui o mapa de atividade inteiro
  (ACT-FR-013). O `ActivityMonitor` reenvia o estado atual no primeiro tick
  pós-reconexão.
- Restart do servidor: registros reconstroem conforme os `activity.report`
  voltam a chegar; sem batching especial nesta escala.

## Telemetry

- Servidor loga em `debug` cada `activity.update` transmitido (alta
  frequência, baixo valor operacional — promover a `info` só ao investigar).
- Servidor loga em `warn` um `activity.report` cujo payload teve itens
  descartados por validação (indício de cliente com bug).
- Nenhum log inclui `details`/`state` (pode conter nome de música/estado de
  jogo) — só `kind`, `name` e a contagem de itens.

## Testing

- **Unit (servidor)**: saneamento de `activity.report` (truncar em 4,
  descartar `kind` inválido, truncar strings); dedupe (report idêntico não
  gera broadcast); `snapshot` só inclui membros com atividade não-vazia.
- **Unit (cliente)**: mapeamento SMTC→`Activity` (mock de `MediaProperties`);
  debounce de 4s coalesce; transição para vazio fura o debounce; toggle
  desligado nunca produz report não-vazio.
- **Unit (UI)**: cronômetro formata `MM:SS` / `H:MM:SS`; `activity.update`
  com `[]` remove a linha; key estável não recria a linha ao trocar de
  faixa.
- **Integration (servidor)**: duas conexões, A manda `activity.report`, B
  recebe `activity.update`; A reconecta e recebe `activity.snapshot` com o
  estado de B; A cai e, após a graça, B recebe `activity.update {
  activities: [] }` para A; 2→1 conexões de A não limpa a atividade de A.
- **Manual/E2E**: tocar algo no Spotify e ver a linha aparecer no outro
  cliente com o tempo correndo; pausar e ver sumir; desligar o toggle e ver
  sumir na hora; matar a rede < 8s e confirmar que não pisca.

## Acceptance criteria

- Um membro ouvindo mídia local aparece para os outros com nome/artista/
  faixa e um cronômetro em < 1s do play, e some em < 1s do pause.
- O toggle "Compartilhar atividade" desligado remove o membro do painel de
  todos e impede qualquer report não-vazio subsequente.
- Um blip de rede menor que a janela de graça nunca produz uma piscada de
  atividade para os outros.
- O `activity.snapshot` de uma conexão nova é um retrato completo e correto
  de quem tem atividade, e o mapa é substituído por inteiro na reconexão.
- Restart do servidor nunca deixa uma atividade "fantasma" presa.

## Dependencies

- `specs/presence.md` — lifecycle de conexão, grace period de 8s (a limpeza
  de atividade faz piggyback), lista de destinatários do fan-out.
- `specs/auth.md` — handshake WS e identidade autenticada da conexão.
- `specs/channels.md` / `db::related_member_ids` — escopo de comunidade do
  fan-out.
- `contracts/ipc-native-ui.md` — o novo op IPC `activity.config`.
- Fase 2: `08-api-design.md` / `contracts/rest-api.md` (endpoint de asset),
  CSP/allowlist de imagem do WebView (`MainWindow.xaml.cs` /
  `client/ui`).
- Fase 3: `07-database-design.md` (migration `0004_game_sessions.sql`).

## Future considerations

- Arte de álbum via SMTC `Thumbnail` (precisa do endpoint de asset da Fase
  2).
- Spotify via OAuth para o caso "tocando fora do PC".
- IGDB/SteamGridDB para key art bonita em vez do `header.jpg` do Steam.
- Merge de atividade multi-dispositivo (hoje é last-writer-wins).
- "Assistir junto"/"entrar no jogo" (deep links) — bem além da v1.

---

## Plano de implementação (fases e tasks)

Cada fase é entregável e testável isolada. A Fase 1 é o slice vertical
mínimo (protocolo + servidor + monitor de mídia + painel). Marque cada task
ao concluir.

### Fase 1 — "Ouvindo" (SMTC), fim a fim

**Protocolo / contratos**
- [x] `T1.1` `server/src/ws/protocol.rs`: structs `Activity`,
  `ActivityReport` (inbound), `ActivityEntry`, `ActivitySnapshot`,
  `ActivityUpdate`.
- [x] `T1.2` `SDD/contracts/websocket-events.md`: linhas `activity.report`
  / `activity.snapshot` / `activity.update`.
- [x] `T1.3` `SDD/contracts/ipc-native-ui.md`: op `activity.config`.

**Servidor (Rust)**
- [x] `T1.4` `server/src/ws/activity.rs`: `ActivityRegistry`
  (`set`/`clear`/`get`/`snapshot`) + saneamento (ACT-FR-003) + `PartialEq`
  para o dedupe.
- [x] `T1.5` `server/src/ws/hub.rs`: campo `activities: RwLock<ActivityRegistry>`.
- [x] `T1.6` `server/src/ws/mod.rs`: `pub mod activity;`.
- [x] `T1.7` `ws/handler.rs` dispatch: `"activity.report" =>
  handle_activity_report`.
- [x] `T1.8` `ws/handler.rs`: `handle_activity_report` (sanear → `set` →
  broadcast `activity.update` se mudou, para `related_member_ids`, incluindo
  o remetente).
- [x] `T1.9` `ws/handler.rs` no connect: após `presence.snapshot`, montar e
  enviar `activity.snapshot` (só membros com atividade não-vazia) para a
  conexão.
- [x] `T1.10` `ws/handler.rs` no grace task de disconnect: `activities.clear`
  + broadcast `activity.update { activities: [] }` se havia algo.
- [ ] `T1.11` `server/tests/activity_test.rs`: report→update, snapshot na
  reconexão, clear no disconnect, 2→1 não limpa, dedupe.

**Cliente nativo (C#)**
- [x] `T1.12` `client/native/Talkeando.Client/ActivityMonitor.cs`: watcher
  do `GlobalSystemMediaTransportControlsSessionManager` + poll de 10s +
  mapeamento SMTC→`Activity` (ACT-FR-009) + debounce 4s (ACT-FR-010) +
  `SetEnabled(bool)` (ACT-FR-008/014).
- [x] `T1.13` `IpcBridge.cs`: campo `ActivityMonitor`, `case
  "activity.config"`, callback → `_network.SendWebSocketAsync("activity.report",
  …)`, start após WS conectar, `Dispose`.
- [ ] `T1.14` `client/native/Talkeando.Client.Tests`: teste do mapeamento e
  do debounce (mock das props).

**UI (React/TS)**
- [x] `T1.15` `App.tsx`: tipo `ActivityDto`, estado `activities`,
  handlers `activity.snapshot` / `activity.update` (ACT-FR-012/013).
- [x] `T1.16` `App.tsx`: componente `ActivityPanel` + cronômetro ao vivo
  (ACT-FR-011), renderizado no topo do `<aside className="members">`.
- [x] `T1.17` `App.tsx`: toggle "Compartilhar atividade" (localStorage
  `tk.shareActivity`, `send("activity.config", …)`, reenvio no bootstrap).
- [x] `T1.18` `styles.css`: `.activity-panel`, `.activity`, `.activity__*`.
- [x] `T1.19` ícones por `kind` (reusar `Icon`/`Glyphs`; `activities` já
  existe no set).

**Verificação**
- [x] `T1.20` `cargo check` (server) — 0 erros.
- [x] `T1.21` `npm run build` (`client/ui`) — 0 erros.
- [x] `T1.22` `dotnet build` (`client/native/Talkeando.Client`) — 0 erros.
- [ ] `T1.23` teste manual: dois clientes, Spotify tocando num, linha
  aparece no outro com cronômetro; pause → some; toggle off → some.
- [ ] `T1.24` `SDD/31-implementation-status.md`: registrar o que foi feito.

### Fase 2 — Detecção de jogo (Steam + ícone de exe)
- [~] `T2.1` `ActivityMonitor`: poller de processos (reusa o timer de 10s da
  Fase 1). Heurística de fullscreen **não** implementada — só match por
  nome de executável (lista curada) + Steam; o fallback fullscreen fica
  como melhoria futura (risco de falso-positivo mostrando app aleatório).
- [x] `T2.2` `ActivityMonitor`: `RunningAppID` do registry + parse de
  `libraryfolders.vdf`/`appmanifest_<appid>.acf` → `asset_image="steam:<appid>"`
  (ACT-FR-021). Nome cacheado por sessão.
- [x] `T2.3` lista curada `exe→nome` (dicionário C# inline em
  `ActivityMonitor`, não um `games.json` — ~35 títulos não-Steam comuns) +
  `Icon.ExtractAssociatedIcon` → PNG.
- [x] `T2.4` `server/src/routes/activity_assets.rs`: `POST /api/activity-assets`
  (auth, multipart, png/jpeg ≤512 KiB, sha256 → id) + `GET
  /api/activity-assets/:id` (**sem auth** — id é hash de conteúdo, a UI do
  WebView não tem token; `Cache-Control: immutable`). Store em
  `{ATTACHMENT_STORAGE_PATH}/_activity_assets/<hash>`, dedupe por existência
  do arquivo, sem tabela.
- [x] `T2.5` `ActivityMonitor.IconRefAsync` → `NetworkClient.UploadActivityAssetAsync`
  → `asset_image="att:<hash>"`, cacheado por game key (inclusive sentinela
  de falha p/ não re-tentar todo poll).
- [x] `T2.6` UI `resolveActivityArt`: `steam:<appid>` → `header.jpg` do CDN
  Steam; `att:<hash>` → `{apiBaseUrl}/activity-assets/<hash>` (`apiBaseUrl`
  vem no `app.bootstrap`, novo campo); URL absoluta passa direto. **Sem
  mudança de CSP** — o app não define CSP nenhuma.
- [x] `T2.7` UI: `<img class="activity__art">` na linha (com `onError` que
  esconde), 44px de altura.
- [x] `T2.8` Builds: `cargo check` + `npm run build` limpos; `dotnet build`
  compila (cópia do `.exe` falha só porque o app está aberto). Teste manual
  com jogo real: pendente.

### Fase 3 — Tempo de jogo (persistência + agregados)
- [x] `T3.1` `server/migrations/0005_game_sessions.sql` (era 0004 na spec;
  0004 já estava em uso). Índice único parcial `(user_id, game_key) WHERE
  ended_at IS NULL`.
- [x] `T3.2` `db.rs`: `open_game_session` (ON CONFLICT DO NOTHING),
  `close_game_session`, `close_all_game_sessions`,
  `close_dangling_game_sessions`, `game_stats` (`total_seconds`,
  `last_played_at`, `is_new` numa query).
- [x] `T3.3` `handle_activity_report`: `reconcile_game_sessions` faz o diff
  do conjunto de `game_key` (de `ws::activity::game_key`) do report anterior
  vs. o novo, abrindo/fechando linhas (ACT-FR-031).
- [x] `T3.4` grace task de disconnect: `db::close_all_game_sessions`.
- [x] `T3.5` `main::serve`: `db::close_dangling_game_sessions`
  (`ended_at = started_at`) no startup.
- [x] `T3.6` `enrich_playtime` preenche `total_seconds`/`last_played_at`/
  `is_new` em cada `Activity` de `kind: "playing"` — no `activity.update` e
  no `activity.snapshot` de conexão nova. `sanitize` zera esses campos na
  entrada (nunca confiados do cliente).
- [x] `T3.7` UI: `formatPlaytime` → "Xh jogadas" / "Xmin jogadas"; badge
  "Novo jogador" quando `is_new`. ("2h atrás"/`last_played_at` não é
  exibido — o jogo está sendo jogado *agora*; o campo existe para uso
  futuro numa aba de "jogados recentemente".)
- [ ] `T3.8` `server/tests/activity_test.rs`: soma de duração ao longo de
  sessões; fechamento no disconnect; `is_new`. **Pendente** — a harness de
  testes de integração do server está quebrada no working tree
  (`reqwest` sem features `json`/`multipart` — corrigido no `Cargo.toml`
  mas não rodei a suíte; precisa de Postgres local).

### Fase 4 — Discord RPC pipe (opcional)
- [x] `T4.1` `DiscordRpcListener.cs`: `NamedPipeServerStream("discord-ipc-0")`
  (até 4 instâncias) + framing `[op int32 LE][len int32 LE][json]` +
  handshake (op 0 → responde `DISPATCH/READY`), só se nenhum
  `Discord*.exe`/`DiscordPTB`/`DiscordCanary` está rodando (ACT-FR-040).
  Ping (op 3) → Pong (op 4). Ancorado no toggle de privacidade.
- [x] `T4.2` Parse de `SET_ACTIVITY` → `RpcActivity` (name, details, state,
  `timestamps.start` em ms ou s, `assets.large_text`) → `Activity` de
  `kind: "playing"` (ACT-FR-041). Nome do jogo resolvido via
  `GET https://discord.com/api/v10/applications/<client_id>/rpc` (cache por
  sessão; fallback "Jogo" + details/state se falhar). `SUBSCRIBE`/
  `UNSUBSCRIBE` são só ackados. As image keys ficam como `asset_text`
  textual (resolver o CDN de assets do Discord está fora de escopo).
  `ActivityMonitor.BuildAsync`: RPC tem prioridade sobre Steam/lista curada
  para o slot "playing".
- [x] `T4.3` Timer de 15s: se um `Discord*.exe` aparece → fecha o pipe e
  para pela sessão (ACT-FR-042). Se o Discord já estava aberto no `Start()`,
  nem cria o pipe.
- [ ] `T4.4` Teste manual com um jogo que usa `discord-rpc`/`discord-game-sdk`
  (Rocket League, Among Us, etc.) — não feito.

### Fase 5 — refinos pós-Fase 1–4
- [x] `T5.1` Arte de álbum: `ActivityMonitor.ReadThumbnailAsync` lê
  `MediaProperties.Thumbnail` do SMTC → sobe uma vez por faixa (dedupe por
  hash no servidor) → `asset_image="att:<hash>"`. `asset_image` deixou de
  ser sempre `null` na mídia.
- [x] `T5.2` Retry de upload de asset: `AssetRefAsync` com cooldown crescente
  (30s × tentativa) até `AssetMaxAttempts` (4), depois desiste pela sessão —
  em vez da sentinela permanente que nunca re-tentava.
- [x] `T5.3` Mixed content resolvido de vez: `IpcBridge.HandleNetworkEvent`
  intercepta `activity.snapshot`/`activity.update`, troca `asset_image:
  "att:<hash>"` por um `data:` URI buscado com o token (mesmo padrão do
  `HydrateMediaUrlsAsync`). O WebView nunca mais toca a origem da API para
  isso — sem CORS, sem mixed-content, sem auth. `steam:`/`https:`/`data:`
  passam direto; a UI ganhou o branch `data:` no `resolveActivityArt`.
- [ ] `T5.4` Teste manual: capa do Spotify aparece; jogo via RPC aparece com
  details/state; nome do jogo RPC resolve; pipe some quando abre o Discord.
