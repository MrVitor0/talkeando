# 31 — Status de implementação da V1

Atualizado em: 2026-08-26  
Status: acompanhamento de execução — não substitui os critérios de aceite de
`30-v1-delivery-plan.md`.

Este documento descreve o que existe no repositório. “Implementado” não quer
dizer “validado”: build, lint e testes não foram executados nesta etapa por
decisão do fluxo de trabalho.

**Atualização 2026-08-26 (sessão talkeando-60):** os três alvos de build do
projeto foram compilados de ponta a ponta pela primeira vez nesta sessão —
`cargo check` (servidor), `npm run build` (`client/ui`, TypeScript/Vite) e
`dotnet build` (`client/native/Talkeando.Client`) — todos com sucesso (0
erros). Antes desta sessão nenhum dos três havia sido efetivamente
verificado: o cliente nativo tinha `using` ausentes, uma versão de pacote
NuGet incompatível com o SDK instalado, e chamava uma API de codec (Opus)
que não existe no SIPSorcery core; a UI React tinha três erros reais de
tipagem em `App.tsx` e faltava a declaração de tipos do Vite para import de
CSS. Todos corrigidos nesta sessão — ver `27-decisions.md` para o
detalhamento das duas correções de arquitetura (codec e versões de pacote).
Build verificado não é o mesmo que testado em runtime: nada disso foi
exercitado em duas máquinas Windows reais nesta sessão (sem hardware
disponível no ambiente de execução do agente).

**Atualização adicional 2026-08-27:** primeira verificação em runtime real
do projeto (não apenas build): um Postgres 16 real (Docker) foi levantado,
`bootstrap-owner` rodou de ponta a ponta, o servidor rodou de verdade e um
cliente WebSocket real (script Node) autenticou, enviou `chat.message.create`
duas vezes com o mesmo `req_id` e confirmou — por `SELECT` direto no banco —
que apenas uma linha foi inserida. Isso valida o mecanismo de idempotência
de retry de chat descrito em `27-decisions.md` ADR-004 (que também corrige
`specs/chat.md` CHAT-FR-012, escrito antes desta implementação existir e
que descrevia, incorretamente, reenvio com `req_id` novo).

## Resumo por marco

| Marco | Estado | Situação atual |
|---|---|---|
| M0 — contratos e ambiente | Pronto | Contratos REST/WS/IPC, schemas, flows, state machines e exemplos de ambiente foram adicionados. |
| M1 — backend de produto | Parcial | Auth, comunidade, canais, chat, anexos, presença, calls/streams e TURN têm base implementada; 19 testes de integração reais cobrem auth, idempotência de chat, calls, o invariante de subscription, presença (grace period) e anexos (ver `testing/integration.md`) — falta cobertura de broadcast de edit/delete para outros clientes e alguns controles operacionais. |
| M2 — cliente WPF + React | Parcial | Host WPF, DPAPI, REST/WS nativos e primeira UI de autenticação/canais/chat existem; faltam acabamento, estados completos e integração de mídia. |
| M3 — voz P2P | Parcial | O motor de PeerConnection/ICE e a ponte de offer/answer/candidate foram iniciados; áudio de captura/reprodução ainda não foi conectado. |
| M4 — screen share | Parcial | Captura (GDI, não WGC — ver ADR-003), codec VP8, publish/subscribe/unsubscribe end-to-end e renderização em janela dedicada estão implementados; sem validação em hardware real, sem seleção de janela individual, sem UI polida. |
| M5 — operação e release | Parcial | Há receita inicial de instalador Inno Setup e exemplos de ambiente; faltam pipeline, assinatura, deploy e checklist executado. |

## Pronto no código

### Contratos e ambiente (M0)

- `SDD/contracts/` declara REST, WebSocket e IPC como contratos normativos;
- `protocol/` contém schemas de envelope WS e IPC;
- há flows para conexão, reconexão e call, state machines e arquivos `.env.example`;
- o prefixo público do backend é `/api` e erros REST seguem `{ code, message }`.

### Backend (M1, parte pronta)

- bootstrap de owner, convites, registro, login, logout e sessão persistida;
- comunidade/membros e CRUD owner-only de categorias e canais;
- mensagens por WebSocket, histórico REST com cursor estável e `has_more`;
- upload autenticado com allowlist, limite configurável, armazenamento fora do
  diretório público e vínculo transacional do anexo à mensagem;
- limpeza horária de uploads não associados após TTL configurável;
- presença por usuário com múltiplas conexões e grace period de 8 segundos;
- calls e streams em memória, limite de dez participantes, relay RTC com
  identidade injetada e credenciais TURN de curta duração;
- CORS configurável por `ALLOWED_ORIGINS` e tamanho máximo de sinal RTC de 64 KiB.
- envio de mensagem é seguro para retry: `req_id` funciona como chave de
  idempotência real (`messages.client_req_id`, índice único parcial),
  verificado em runtime contra Postgres real (ver acima e `27-decisions.md`
  ADR-004) — uma segunda tentativa com o mesmo `req_id` nunca duplica a
  linha, e a confirmação de uma tentativa repetida vai só para quem repetiu,
  não para toda a comunidade de novo.

### Cliente (M2, parte pronta)

- projeto WPF/WebView2 e armazenamento de sessão protegido com DPAPI;
- cliente HTTP nativo para auth, bootstrap, histórico e upload;
- WebSocket nativo com reconexão exponencial e indicação visual de estado;
- UI React inicial: login/registro, lista de canais, membros, histórico,
  envio de mensagem, seletor nativo de anexos e abertura autenticada do
  arquivo baixado em diretório temporário;
- roster de membros reflete `presence.snapshot` e `presence.update` em tempo
  real, inclusive o estado offline;
- painel inicial de call consome snapshots e entrada/saída de participantes;
  ele ainda não captura nem reproduz áudio.
- `RtcEngine` usa SIPSorcery e credenciais TURN curtas para manter um
  `RTCPeerConnection` por peer, com offer/answer/trickle ICE pelo WebSocket.
- **2026-08-26: build do cliente C# validado de ponta a ponta pela primeira
  vez** (`dotnet build` em `client/native/Talkeando.Client`, 0 erros/0
  avisos). Antes disso o projeto nunca havia compilado de fato: faltavam
  `using System.IO;` em `SessionStore.cs`/`NetworkClient.cs`,
  `SIPSorceryMedia.Windows` 10.0.16 não é compatível com o SDK .NET 6
  instalado na máquina (`NU1202`), e `AudioEncoder(includeOpus: true)` não
  existe na API real — o pacote não suporta Opus (ver `27-decisions.md`
  ADR-001/ADR-002 para a investigação e correção completas).
- captura de microfone está conectada: `RtcEngine` mantém uma única sessão
  WASAPI de captura (compartilhada entre todos os peers da mesh, não uma por
  peer) via `WindowsAudioEndPoint`, codifica em G722 e distribui o frame
  codificado a cada `RTCPeerConnection` conectado via `SendAudio`. Mute e
  deafen são aplicados no `RtcEngine` (não apenas broadcast para os outros);
  `IpcBridge` chama `StartMicrophoneAsync`/`LeaveCallAsync` em
  `call.join`/`call.leave` e `SetMuted`/`SetDeafened` em
  `call.state.update`. `IpcBridge` e `MainWindow` liberam o microfone e todas
  as PeerConnections ao fechar a janela.
- pendente ainda: teste manual real de dois dispositivos de áudio (esta
  sessão só validou compilação e a integração de API via reflexão — não há
  hardware de dois PCs Windows disponível neste ambiente); VAD/indicador de
  fala; troca de dispositivo em tempo real; push-to-talk.
- o autor pode editar ou excluir suas próprias mensagens pelo WebSocket.
- receita Inno Setup inicial em `client/native/installer/`.
- **2026-08-26: compartilhamento de tela implementado de ponta a ponta**
  (`RtcEngine.PublishScreen`/`UnpublishScreen`/`SetScreenSubscription`,
  `ScreenShareViewerWindow`, `IpcBridge` "stream.watch"/"stream.stop_watching",
  UI React com seletor de monitor e botões assistir/parar). Codec VP8 via
  `SIPSorceryMedia.Encoders.VpxVideoEncoder` (verificado por reflexão — não
  H.264, ver `27-decisions.md` ADR-003), captura via GDI
  `System.Drawing`/`System.Windows.Forms.Screen` (não
  `Windows.Graphics.Capture` — mesmo ADR, razão: COM interop não seria
  verificável em runtime neste ambiente). O invariante zero-subscriber →
  zero-RTP-de-vídeo está implementado como gate no envio (nunca renegocia
  a PeerConnection), exatamente como mute faz para áudio. Renderização usa
  uma janela WPF dedicada por stream assistido (`WriteableBitmap`), não um
  tile embutido na janela principal — ver ADR-003 para a razão e
  `14-screen-share-pipeline.md` para o pipeline completo. Cliente e UI
  seguem compilando limpos (0 erros) após esta adição.
- **2026-08-27: bug real corrigido — nenhum frame de vídeo jamais era
  enviado.** Encontrado em teste manual real com dois usuários (não
  hipotético): toda a sinalização funcionava (publish/subscribe/
  subscription_requested confirmados nos logs), mas o viewer nunca recebia
  quadro nenhum. Causa raiz dupla: (1) `PublishScreen` usava a classe
  errada — `WindowsVideoEndPoint` (câmera apenas) lança exceção em toda
  chamada a `ExternalVideoSourceRawSample`; a classe certa para injetar
  frames externos é `SIPSorceryMedia.Encoders.VideoEncoderEndPoint`; (2)
  mesmo trocando a classe, o parâmetro de duração estava em unidades RTP
  quando deveria ser milissegundos por quadro, causando
  `DivideByZeroException`. Ambas as exceções eram engolidas silenciosamente
  por um `catch { break; }` genérico no loop de captura — corrigido para
  logar em vez de engolir. Ver `27-decisions.md` ADR-005 (correção
  detalhada) e ADR-006 (bug relacionado: duas janelas na mesma máquina
  compartilhavam um único arquivo de sessão, o que confundiu o primeiro
  teste de 2 usuários). Corrigido e testes unitários do cliente (12)
  seguem passando.
- **2026-08-27: segundo bug real, encontrado assim que o primeiro frame
  finalmente chegou** — o viewer renderizava preto sólido em vez da tela
  compartilhada. Testado por round-trip real (codificar uma imagem de cor
  conhecida, decodificar, inspecionar os bytes): `VpxVideoEncoder.
  DecodeVideo` ignora completamente o parâmetro `VideoPixelFormatsEnum` —
  toda combinação testada (Bgra, Bgr, Rgb, I420) devolveu exatamente
  `width*height*3` bytes (BGR de 3 bytes/pixel), nunca os 4 bytes/pixel de
  BGRA que o código assumia. Corrigido: `ScreenShareViewerWindow` agora usa
  `PixelFormats.Bgr24` com stride `width*3` em vez de `Bgra32`/`width*4`.
  Ver `27-decisions.md` ADR-005 (mesma entrada, terceira parte). Pendente:
  confirmação visual do usuário de que a imagem renderiza corretamente
  (não só que não fica mais preta).
- pendente: validação em duas máquinas Windows reais; seleção de janela
  individual (só monitor inteiro no v1); tile embutido na UI principal;
  indicador "compartilhando para N pessoas"; adaptação de qualidade de vídeo.
- **2026-08-27: primeiros testes automatizados do cliente nativo** —
  `client/native/Talkeando.Client.Tests` (xUnit), 12 testes passando,
  cobrindo lógica de `RtcEngine` (mute/deafen, no-ops seguros para
  peer/stream inexistente) e `SessionStore` (round-trip DPAPI, arquivo
  corrompido se autocorrige). Exigiu tornar o caminho do arquivo de
  `SessionStore` injetável — o caminho antes era fixo no
  `%LOCALAPPDATA%` real, então testar a classe como estava teria
  sobrescrito/apagado a sessão real de quem rodasse os testes. Ver
  `testing/unit.md` para escopo e o que deliberadamente não é coberto
  (nada que precise de hardware de áudio/vídeo real).
- **2026-08-27: envio de chat otimista na UI React** — mensagem aparece
  imediatamente como `pending`, timeout de 8s marca `failed` com botões
  "tentar de novo"/"cancelar", retry reenvia com o **mesmo** `req_id`
  (correção importante, ver ADR-004). Banner de erro que antes era
  capturado em estado mas nunca renderizado após o login (bug real:
  qualquer erro pós-autenticação era engolido silenciosamente) agora
  aparece na tela de chat com botão de dispensar. Estados vazio/carregando
  de histórico também adicionados.
- **2026-08-27: ICE restart implementado** — `RtcEngine.RestartIceAsync` +
  `IpcBridge.HandleConnectionStateChangeAsync`, com o lado de menor
  `user_id` iniciando o restart (evita colisão sem Perfect Negotiation
  completo) — ver `flows/reconnect.md` camada 2.
- **2026-08-27: WebRTC (voz + screen share) migrado de C#/SIPSorcery para o
  próprio motor libwebrtc do WebView2** (ver ADR-008/ADR-009 em
  `27-decisions.md`). `RtcEngine.cs` e `ScreenShareViewerWindow.xaml(.cs)`
  foram removidos; `client/ui/src/rtc.ts` (novo) implementa a mesh via
  `RTCPeerConnection`/`getUserMedia`/`getDisplayMedia` nativos do
  navegador. `IpcBridge.cs` virou um relay puro de sinalização (offer/
  answer/ice/publish/subscribe passam direto para o WebSocket autenticado,
  sem entender WebRTC). Topologia continua P2P mesh — nada disso introduz
  um SFU. As dependências `SIPSorcery`/`SIPSorceryMedia.*` foram removidas
  do `.csproj`. Motivação: `VpxVideoEncoder.TargetKbps` do pacote pinado
  provou ser um no-op real (testado empiricamente), então não havia
  controle de qualidade/bitrate possível naquele caminho — o motor do
  Chromium já traz isso de fábrica (GCC, NACK/PLI, simulcast/SVC,
  screen-content-coding), então reimplementar à mão deixou de fazer
  sentido. `RtcEngineTests.cs` foi removido (a lógica que testava não
  existe mais em C#); não reposto em TS nesta sessão.

### Operação (M5, parte pronta)

- `server/Dockerfile` produz a imagem não-root do backend;
- `infra/docker-compose.production.yml` e `Caddyfile.example` formam o
  template de Postgres, backend, TLS e coturn. Segredos ficam no ambiente de
  produção, fora do Git.
- **2026-08-27: pipeline de release do cliente validado de ponta a ponta**
  — `dotnet publish -c Release -r win-x64 --self-contained false` (o
  comando exato do passo 2 de `client/native/installer/README.md`) roda
  com sucesso e o output contém o `.exe`, todas as dependências
  gerenciadas, os assets React (`ui/index.html` + `ui/assets/`) e,
  criticamente, `vpxmd.dll` (a dependência nativa do encoder VP8) — sem
  isso o compartilhamento de tela falharia silenciosamente só no primeiro
  uso, não no build. Corrigido também um bug real no `.iss`: a função
  `ShouldSkipPage` era um stub morto que nunca fazia nada, e o instalador
  do WebView2 Runtime rodava incondicionalmente mesmo quando o runtime já
  estava presente na máquina — agora tem `Check: not
  WebViewRuntimeInstalled`. O script `.iss` em si não foi compilado nesta
  sessão (ISCC não está instalado neste ambiente) — a correção é sintaxe
  padrão do Inno Setup, mas fica registrada como não-verificada por
  compilação real.

## Ainda pendente

### Bloqueadores de V1

1. Implementar voz real no Windows: SIPSorcery, WASAPI, G722 (corrigido de
   Opus, ver `27-decisions.md`), negociação WebRTC, ICE/TURN, mute/deafen e
   recuperação de rede. Negociação/ICE, captura/envio e reprodução de áudio,
   mute/deafen e ICE restart (camada 2 de reconexão, ver
   `flows/reconnect.md`) estão implementados e o cliente compila; falta
   validação manual em hardware real (duas máquinas Windows). Não
   implementado: reconstrução completa do PeerConnection como
   escalonamento pós-restart malsucedido, e camada 3 (full call rejoin)
   dedicada.
2. Implementar captura e compartilhamento de tela — **feito nesta sessão**
   (GDI em vez de Windows.Graphics.Capture, VP8 em vez de H.264, ambos por
   razões verificadas — ver `27-decisions.md` ADR-003 e
   `14-screen-share-pipeline.md`). Falta: validação em hardware real,
   seleção de janela individual, tile embutido na UI principal.
3. Terminar a UI: presença em tempo real, lista/painel de call, edição/remoção
   de mensagens, download/preview de anexos, retry/cancelamento e acessibilidade.
4. Empacotar a UI no publish, criar pipeline reprodutível, configurar deploy
   com Caddy/Postgres/coturn e assinar/publicar o instalador.
5. Executar e registrar a matriz de validação do plano: unitária, integração,
   WS, multi-cliente, TURN, rede instável, instalação limpa e teste manual.

### Pendências técnicas não bloqueadoras isoladamente

- limpeza programada de anexos que foram enviados mas não associados a mensagem;
- logs estruturados completos com request/connection IDs;
- download e preview de anexos no host nativo;
- hardening final de Caddy, backup/restauração e rollback.

### Testes automatizados (novo, 2026-08-27)

- `server/tests/` (`auth_test.rs`, `chat_test.rs`, `calls_test.rs`,
  `presence_test.rs`, `attachments_test.rs`, mais `tests/common/mod.rs`) —
  **20 testes de integração reais, rodando contra Postgres de verdade (não
  mockado), todos passando** (inclui broadcast de edit/delete para outros
  clientes, fechando o gap identificado no fim da sessão anterior). Isso exigiu separar o crate do servidor em
  lib+bin (`server/src/lib.rs` novo, `talkeando_server::build_app`) para
  que os testes exercitem o router de produção real. Ver
  `testing/integration.md` para detalhes, cobertura e como rodar.
- Vários bugs reais foram pegos pelos próprios testes durante o
  desenvolvimento (não hipotéticos, todos corrigidos nos testes — o
  servidor estava certo em todos os casos): um username de teste com hífen
  violava a validação real do servidor; a suposição inicial do formato de
  `call.peer_joined` estava errada (é `{ participant: {...} }`, não
  `{ user_id }` solto); e um teste de presença assumia incorretamente que
  o primeiro `presence.update` recebido seria sobre o usuário certo —
  conectar também emite um evento auto-dirigido ("eu fiquei online"), o
  que exigiu filtrar por `user_id`, não só por `op`.

## Regra de conclusão

Nenhuma linha acima muda o go/no-go: a V1 só é “pronta” quando todos os itens
de `30-v1-delivery-plan.md#go-no-go-da-v1` tiverem evidência registrada.
