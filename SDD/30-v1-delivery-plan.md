# 30 — Plano de entrega da v1 instalável

Status: Plano de execução proposto
Owner/Domain: Produto, backend, cliente e infraestrutura
Ver também: `00-product-overview.md`, `01-scope.md`, `02-requirements.md` e `specs/`

## Resultado de produto

Entregar um instalador Windows que qualquer membro da comunidade possa baixar,
instalar e usar sem ferramentas de desenvolvimento. O usuário deve conseguir:

1. entrar com conta existente ou criar conta por convite;
2. ver canais, presença e histórico de chat;
3. enviar mensagens e anexos;
4. entrar em voz com outros membros, inclusive através de TURN;
5. mutar/ensurdecer, reconectar e continuar a call;
6. compartilhar uma janela ou tela, onde mídia só é enviada após o viewer
   clicar para assistir;
7. receber atualizações e instalar uma versão identificável/reproduzível.

Esta é a definição operacional de “v1 pronta para a galera usar”. Nenhuma
fase é considerada concluída apenas por ter código: ela exige os critérios de
aceite e a evidência de teste indicados abaixo.

## Decisões de execução

- **Plataforma:** Windows 10 1809+ / Windows 11, x64, WebView2 Runtime.
- **Escala alvo:** uma comunidade, até 10 membros; no máximo 10 participantes
  por call; backend de uma única instância.
- **Mídia:** mesh P2P SIPSorcery; backend nunca recebe RTP; coturn é fallback
  obrigatório para NAT/CGNAT.
- **Corte de escopo que preserva o prazo:** câmera e adaptação avançada de
  qualidade saem do bloqueador de release e entram como v1.1, apesar de serem
  descritas como P1 no baseline. Tela, voz, chat, anexos, reconexão e release
  continuam obrigatórios para v1.0.
- **Fonte de verdade:** antes de implementar cada fase, completar o contrato
  correspondente em `SDD/contracts/`, `protocol/` e a spec; não adivinhar
  payloads a partir de telas ou código.

## Ordem de entrega

| Marco | Objetivo | Dependências | Saída verificável |
|---|---|---|---|
| M0 | Fechar contratos e bootstrap de desenvolvimento | nenhuma | API, WS, IPC e variáveis de ambiente versionados |
| M1 | Servidor de produto: conta, canais, chat, anexos e presença | M0 | dois clientes podem conversar de forma persistente |
| M2 | Cliente desktop funcional: WPF + React | M0, M1 | login, sidebar, chat e presença utilizáveis |
| M3 | Voz P2P confiável | M1, M2, TURN | call entre máquinas/rede externa funciona |
| M4 | Compartilhamento de tela por assinatura | M3 | zero RTP sem subscribe, tela utilizável |
| M5 | Hardening, observabilidade e release | M1–M4 | instalador e checklist de go/no-go aprovados |

## M0 — Contratos e ambiente de desenvolvimento

### Trabalho

1. Criar os contratos hoje ausentes:
   - `SDD/contracts/rest-api.md`;
   - `SDD/contracts/websocket-events.md`;
   - `SDD/contracts/ipc-native-ui.md`;
   - schemas versionados em `protocol/` para REST, WS e IPC.
2. Criar os flows e state machines citados pelo README: login, conexão WS,
   reconexão, join/leave call e publish/subscribe stream.
3. Criar `.env.example` para servidor e `client/.env.example`; documentar
   DATABASE_URL, URL pública, TURN realm/secret/URIs, diretório de anexos e
   limites de upload.
4. Definir um único prefixo público para API (`/api`) e os formatos de erro,
   paginação, `req_id` e versionamento dos envelopes.
5. Criar um `docker-compose` de desenvolvimento completo: Postgres, coturn e
   backend, com arquivos de configuração de coturn.

### Aceite

- Todo op WS possui direção, payload, erro e correlação documentados.
- Todo comando IPC possui dono (UI ou nativo), resposta e evento associado.
- Uma máquina nova consegue levantar o ambiente lendo somente `README` e o
  guia local.

## M1 — Backend de produto

### M1.1 Autenticação e comunidade

- Concluir registro por convite, bootstrap idempotente, login, logout,
  expiração deslizante e revogação de sessão.
- Rate limit por **IP + username**, logs sem tokens/senhas, CORS restrito à
  origem do cliente e TLS delegado a Caddy em produção.
- Endpoint de membros da comunidade, necessário para a UI resolver os IDs de
  presença.

### M1.2 Canais e chat

- Finalizar CRUD owner-only de categorias/canais, incluindo PATCH de todos os
  campos permitidos e fim de call ao remover canal de voz.
- Retornar histórico como `{ messages, has_more }`, com resumo do autor,
  anexos e cursor estável `(created_at, id)`.
- Padronizar `chat.message.created/edited/deleted` com `req_id`; limitar typing
  e enviá-lo apenas para viewers do canal.
- Implementar upload/download de anexos: allowlist de tipos, limite
  configurável, armazenamento local fora do diretório público e associação
  transacional a mensagens.

### M1.3 Presença, calls e streams

- Consolidar múltiplas conexões, presença por comunidade e grace period de
  8 segundos sem flicker.
- Completar `call.join/leave/state.update`: resposta correlacionada, motivos
  de saída, capacidade e rejoin após reconnect.
- Autorizar cada `rtc.*` e limitar tamanho de SDP/candidate; relay inclui
  identidade de origem confiável.
- Concluir `stream.*`: um screen stream por publisher, cascata de unpublish,
  viewer set idempotente e erros tipados.
- Expor credenciais TURN HMAC de vida curta só para membro autenticado.

### Aceite M1

- Dois clientes de teste passam por registro, chat, reconexão e presença sem
  vazamento entre comunidades.
- O banco preserva chat e membros após reinício do backend; calls/streams são
  conscientemente efêmeros.
- Testes unitários e integração cobrem autorização, paginação, convite,
  mensagens, presença, calls, RTC relay e streams.

## M2 — Cliente Windows e UI

### M2.1 Host nativo

- Concluir projeto WPF: janela, assets React empacotados, dark mode, bridge
  IPC tipada, tratamento de erro e telemetria local.
- `SessionStore` DPAPI é a única dona do token; a UI jamais recebe token.
- `NetworkClient` nativo implementa REST autenticado, WebSocket, reconnect
  exponencial com jitter e reauth.

### M2.2 UI React/TypeScript

- Criar Vite/React com tipos de domínio e stores para auth, canais, chat,
  presença, call e streams.
- Implementar login/registro por convite, loading/error/empty states e banner
  de reconexão.
- Implementar layout dark: sidebar de categorias, membros online/offline,
  MessageList, composer, typing indicator e painel de voz.
- Chat deve ser otimista: pendente, timeout, falha, retry e cancelamento.
- Persistir somente preferências não sensíveis (ex.: categorias colapsadas) e
  não o token.

### Aceite M2

- O app abre, restaura sessão, exibe comunidade e permite usar chat sem
  DevTools ou servidor de desenvolvimento.
- Fluxos de erro são compreensíveis: servidor indisponível, convite inválido,
  login inválido, WS em reconexão e mensagem falhada.
- Navegação por teclado básica e contraste/labels dos controles principais são
  revisados manualmente.

## M3 — Voz P2P

### Trabalho

1. Adicionar SIPSorcery e SIPSorceryMedia.Windows ao cliente nativo.
2. Implementar `RtcEngine` e um `PeerController` actor por peer, com mailbox
   serializada e Perfect Negotiation (papel determinístico por UUID).
3. Implementar offer/answer/trickle ICE, coleta de stats e ICE restart antes
   de recriar conexão.
4. Implementar `AudioPipeline`: WASAPI input/output, Opus 48 kHz, mic track
   em todo PeerConnection, render/mix de áudio remoto, VAD local/remoto,
   mute e deafen locais.
5. Conectar os eventos IPC de call/RTC/audio à UI e mostrar estados por peer.
6. Validar NAT usando máquinas em redes diferentes e coturn real.

### Aceite M3

- Três clientes conseguem entrar/sair de call, ouvir todos os outros e ver
  mute/deafen refletidos no roster.
- Uma call funciona com relay TURN quando conexão direta falha.
- Troca de rede provoca ICE restart ou rejoin limpo, sem participante fantasma.
- O backend não recebe bytes RTP em nenhum teste ou captura de rede.

## M4 — Compartilhamento de tela

### Trabalho

- Implementar seleção de monitor/janela com Windows.Graphics.Capture.
- Capturar WGC, codificar H.264 (fallback VP8), criar track e publicar stream.
- Implementar receiver/tiles na UI e lifecycle de fonte encerrada.
- Aplicar o modelo obrigatório: publisher mantém sender por viewer e só o
  habilita após `stream.subscription_requested`; unsubscribe o desabilita sem
  remover m-line/causar renegociação desnecessária.
- Mostrar estado “Compartilhando para N” e ação explícita “Assistir”.

### Aceite M4

- Um stream publicado sem viewer produz **zero RTP de vídeo**.
- Cada subscribe/unsubscribe afeta só aquele viewer.
- Fechar janela compartilhada ou desconectar publisher faz unpublish limpo em
  todos os viewers.

## M5 — Segurança, operação e release

### Trabalho

- Caddy: TLS automático, headers, proxy de REST/WS; coturn com realm, secret,
  portas UDP/TCP e configuração documentada; secrets fora do Git.
- Logs estruturados com request/connection IDs e sem dados sensíveis;
  diagnósticos de call/ICE utilizáveis.
- Criar pipeline de build: UI → assets do cliente → `dotnet publish` x64;
  gerar instalador assinado ou, até assinatura disponível, pacote versionado
  com SHA-256 e instruções explícitas de instalação.
- Incluir versionamento, changelog, backup/restauração Postgres e rollback
  do servidor.
- Executar matriz de testes: unit, integração, WS, multi-cliente RTC, TURN,
  falha de rede, upgrade, instalação limpa e teste manual com 3–4 pessoas.

### Go/no-go da v1

Só publicar quando todos forem verdadeiros:

- [ ] Instalador/pacote Windows x64 instala e abre em máquina limpa.
- [ ] Deploy de produção com Caddy, Postgres e coturn foi ensaiado.
- [ ] Registro por convite, login e logout foram testados end-to-end.
- [ ] Chat, edição, exclusão, paginação e anexos funcionam após reinício.
- [ ] Presença e reconexão não duplicam ou deixam usuários presos online.
- [ ] Voz funciona em LAN e através de TURN.
- [ ] Screen share cumpre a invariante zero-subscriber → zero-video-RTP.
- [ ] Nenhum segredo aparece em logs, bundle do cliente ou repositório.
- [ ] Suite automatizada e checklist manual têm resultado registrado.
- [ ] Versão, changelog, checksum e canal de suporte foram publicados.

## Backlog pós-v1.0

Não bloqueia a primeira release baixável: câmera, adaptação avançada de
qualidade, reações, busca, read receipts, push, cliente não-Windows, SFU,
escala horizontal e E2EE de aplicação.
