# 02 — Requirements (Master List / Traceability Root)

Status: Decidido (catálogo de prefixos fixo — ver canon §9)
Owner/Domain: Todos
Ver também: todo outro documento do SDD cita IDs a partir daqui; `29-definition-of-done.md`
mapeia DoD de volta para estes IDs; `testing/acceptance.md` mapeia para a
lista de aceitação de 21 pontos do product brief.

## Objetivo

Este é o documento raiz de rastreabilidade. Toda funcionalidade, todo teste
e todo critério de aceitação no restante do SDD cita um ID definido aqui.
Nenhum outro documento pode inventar um prefixo novo fora da lista abaixo
(canon §9). Números não são reaproveitados mesmo se um requisito for
removido — um requisito removido é marcado `[REMOVIDO]` com o motivo, não
apagado da lista.

## Convenção

- Prefixos: `AUTH-FR-*`, `AUTH-NFR-*`, `CHAN-FR-*`, `CHAT-FR-*`,
  `CHAT-NFR-*`, `PRES-FR-*`, `WS-FR-*`, `CALL-FR-*`, `RTC-FR-*`,
  `SCREEN-FR-*`, `CAM-FR-*`, `SUB-FR-*`, `AUDIO-FR-*`, `AUDIO-NFR-*`,
  `QUAL-FR-*`, `DEV-FR-*`, `ATTACH-FR-*`, `NOTIF-FR-*`, `SETTINGS-FR-*`,
  `SEC-NFR-*`, `OBS-NFR-*`, `PERF-NFR-*`, `UX-FR-*`, `DB-FR-*`, `API-FR-*`.
- IDs numéricos começam em `001` dentro de cada prefixo, sem lacunas
  propositais.
- `FR` = functional requirement, `NFR` = non-functional requirement.
- Coluna "Fase" referencia `25-roadmap.md` (phase-00..11).
- Coluna "Prioridade": P0 (feature base), P1, P2 — ver `01-scope.md`.

---

## AUTH — Autenticação e sessão (ver `16-security.md`, `contracts/rest-api.md`)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| AUTH-FR-001 | Login via username+senha (`POST /auth/login`) retorna token de sessão opaco | P0 | phase-02 |
| AUTH-FR-002 | Cliente armazena o token localmente protegido por DPAPI (escopo usuário+máquina) | P0 | phase-03 |
| AUTH-FR-003 | Sessão válida por 30 dias com renovação deslizante a cada uso | P0 | phase-02 |
| AUTH-FR-004 | Logout revoga a sessão (`revoked_at` setado; token deixa de autenticar) | P0 | phase-02 |
| AUTH-FR-005 | Registro de novo usuário exige código de convite válido (`invites`) | P0 | phase-02 |
| AUTH-FR-006 | Primeiro usuário (owner) só é criado via comando de bootstrap de servidor (`server --bootstrap-owner`), nunca via API pública | P0 | phase-02 |
| AUTH-FR-007 | Token de sessão é apresentado como `Authorization: Bearer` em REST e como primeira mensagem `auth.hello` em WS | P0 | phase-02 |
| AUTH-FR-008 | Mensagem de erro de credencial inválida é genérica ("invalid credentials"), independente de qual verificação falhou | P0 | phase-02 |
| AUTH-NFR-001 | Hash de senha via Argon2id (`argon2` crate) | P0 | phase-02 |
| AUTH-NFR-002 | Servidor armazena apenas SHA-256 do token de sessão (`token_hash`), nunca o token bruto | P0 | phase-02 |
| AUTH-NFR-003 | Comparação de senha é constant-time (garantido pela verificação Argon2) | P0 | phase-02 |
| AUTH-NFR-004 | Rate limit de janela fixa em `/auth/login` por IP+username (ex.: 10/min) | P0 | phase-02 |
| AUTH-NFR-005 | Sem CSRF token — API é Bearer-token JSON puro, não cookie-session; razão documentada em `16-security.md`, não omitida | P0 | phase-02 |

## CHAN — Comunidade, categorias, canais

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| CHAN-FR-001 | Exatamente uma linha em `communities` existe em v1 (seed) | P0 | phase-02 |
| CHAN-FR-002 | Papéis de membro: `owner`, `member` (`community_members.role`) | P0 | phase-02 |
| CHAN-FR-003 | Categorias de canal têm nome e posição (`position`), são colapsáveis na UI | P0 | phase-03/04 |
| CHAN-FR-004 | Canais têm `kind` = `text` ou `voice`, nome, tópico opcional, posição | P0 | phase-02 |
| CHAN-FR-005 | Canal de voz exibe contagem de participantes conectados como pill `NN / 10` | P0 | phase-06 |
| CHAN-FR-006 | Todo membro da comunidade vê todos os canais (sem ACL granular de UI em v1) — `channel_members` existe mas enforcement é apenas "é membro da comunidade" | P0 | phase-02 |
| CHAN-FR-007 | Owner pode criar/renomear/reordenar categorias e canais via API | P0 | phase-02 |
| CHAN-FR-008 | Member (não-owner) não pode criar/editar/excluir categorias ou canais | P0 | phase-02 |

## CHAT — Mensagens de texto

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| CHAT-FR-001 | Enviar mensagem em canal de texto (`chat.message.create` via WS, persistida) | P0 | phase-04 |
| CHAT-FR-002 | Editar própria mensagem (`chat.message.edit`), `edited_at` setado | P0 | phase-04 |
| CHAT-FR-003 | Excluir própria mensagem — soft delete (`deleted_at` setado, conteúdo não é fisicamente removido) | P0 | phase-04 |
| CHAT-FR-004 | Indicador de digitação (`chat.typing`) é efêmero, nunca persistido | P0 | phase-04 |
| CHAT-FR-005 | Histórico de mensagens é paginado (cursor por `created_at`/`id`) via REST | P0 | phase-04 |
| CHAT-FR-006 | Tabela `reactions` existe no schema; **sem UI de reação em v1** (deferred) | P0 (schema) / deferred (UI) | phase-02 |
| CHAT-FR-007 | Anexos podem ser vinculados a uma mensagem (`ATTACH-FR-*`) | P0 | phase-04 |
| CHAT-FR-008 | Owner de mensagem é o único que pode editar/excluir; owner de comunidade também pode excluir qualquer mensagem (moderação básica) | P0 | phase-04 |
| CHAT-NFR-001 | Mensagens são entregues aos clientes conectados na ordem de criação, por canal | P0 | phase-04 |
| CHAT-NFR-002 | Paginação de histórico responde em <200ms p95 para uma comunidade de 10 pessoas / volume esperado | P0 | phase-04 |

## PRES — Presença

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| PRES-FR-001 | Ao conectar, cliente recebe `presence.snapshot` com todos os membros e seus estados | P0 | phase-05 |
| PRES-FR-002 | Mudança de estado (online/idle/offline) é broadcast via `presence.update` | P0 | phase-05 |
| PRES-FR-003 | Estado `idle` é inferido por inatividade local do cliente (sem input) após um limiar configurável (default documentado em `18-ux-spec.md`) | P0 | phase-05 |
| PRES-FR-004 | Desconexão de WS (sem reconectar dentro do grace period) marca usuário `offline` | P0 | phase-05 |

## WS — Ciclo de vida e protocolo WebSocket

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| WS-FR-001 | `auth.hello` deve ser a primeira mensagem após o upgrade de conexão; qualquer outra mensagem antes disso é rejeitada | P0 | phase-02 |
| WS-FR-002 | Reconexão de WS (novo socket, mesma sessão) restaura presença/estado de call sem duplicar participante nem deixar estado órfão | P0 | phase-10 |
| WS-FR-003 | Heartbeat ping/pong mantém a conexão viva e detecta peers mortos | P0 | phase-02 |
| WS-FR-004 | Envelope de mensagem versionado (`{v:1, op, data}`) em toda troca | P0 | phase-02 |
| WS-FR-005 | Erros usam envelope tipado `{v:1, op:"error", data:{code,message,in_reply_to}}`, nunca fecham a conexão por erro de aplicação | P0 | phase-02 |
| WS-FR-006 | Mutations carregam `data.req_id` gerado pelo cliente; acks/erros ecoam esse `req_id` | P0 | phase-02 |

## CALL — Ciclo de vida de chamada de voz/vídeo

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| CALL-FR-001 | Entrar em canal de voz (`call.join`) retorna `call.snapshot` com participantes e streams atuais | P0 | phase-06 |
| CALL-FR-002 | Sair de canal de voz (`call.leave`) remove o participante e broadcasta `call.peer_left` | P0 | phase-06 |
| CALL-FR-003 | Entrada de novo participante broadcasta `call.peer_joined` aos demais | P0 | phase-06 |
| CALL-FR-004 | Mute/deafen são estado por participante (`ParticipantState.muted/deafened`), refletido em `call.snapshot`/broadcast | P0 | phase-06 |
| CALL-FR-005 | Call sobrevive a reconexão de WS — participante não é removido só por queda momentânea do socket (ver `state-machines/call.md`) | P0 | phase-10 |
| CALL-FR-006 | Toda mensagem de sinalização é autorizada contra o `CallRegistry` (remetente é participante real; alvo é participante real; stream pertence ao dono alegado) — rejeição tipada, nunca panic | P0 | phase-06 |

## RTC — Peer connection, negociação, ICE

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| RTC-FR-001 | Mesh completo: uma `RTCPeerConnection` por peer remoto ativo na call, nunca por track | P0 | phase-06 |
| RTC-FR-002 | Perfect Negotiation: papel polite/impolite decidido deterministicamente por comparação de UUID (menor UUID = polite) | P0 | phase-06 |
| RTC-FR-003 | Cada relação de peer é dona de uma fila serializada (`PeerController`); nenhuma outra parte do app toca a `RTCPeerConnection` diretamente | P0 | phase-06 |
| RTC-FR-004 | ICE restart é o mecanismo de recuperação para mudança de rede, sem descartar a call inteira | P0 | phase-06/10 |
| RTC-FR-005 | Após 2 tentativas de ICE restart falhas para o mesmo peer, recriar a `RTCPeerConnection` do zero | P0 | phase-10 |
| RTC-FR-006 | TURN é fallback obrigatório; credenciais de curta duração emitidas pelo backend (HMAC, TURN REST API style) | P0 | phase-06 |
| RTC-FR-007 | Ordem de tentativa ICE: host/srflx (STUN) antes de relay (TURN), conforme prioridades ICE padrão — TURN nunca é desabilitado como fallback | P0 | phase-06 |
| RTC-FR-008 | `rtc.offer`/`rtc.answer`/`rtc.ice` são roteados pelo servidor apenas entre usuários que estão ambos na mesma call ativa (autorização contra `CallRegistry`) | P0 | phase-06 |

## SCREEN — Compartilhamento de tela

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| SCREEN-FR-001 | Publicar tela (`stream.publish`, kind=`screen`) registra o stream no servidor sem iniciar envio de mídia | P0 | phase-07 |
| SCREEN-FR-002 | Despublicar (`stream.unpublish`) remove o stream e força unsubscribe de todos os viewers | P0 | phase-07 |
| SCREEN-FR-003 | Seleção de fonte de captura (monitor/janela) via `Windows.Graphics.Capture` | P0 | phase-07 |
| SCREEN-FR-004 | Assinatura de stream de tela segue exatamente o modelo em `SUB-FR-*` | P0 | phase-07 |
| SCREEN-FR-005 | Se a janela capturada for fechada durante o compartilhamento, o publisher despublica automaticamente e a UI mostra estado "fonte perdida" (ver `18-ux-spec.md`) | P0 | phase-07 |

## CAM — Câmera

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| CAM-FR-001 | Publicar câmera (`stream.publish`, kind=`camera`) | P1 | phase-08 |
| CAM-FR-002 | Despublicar câmera | P1 | phase-08 |
| CAM-FR-003 | Assinatura de stream de câmera segue exatamente o modelo em `SUB-FR-*` | P1 | phase-08 |
| CAM-FR-004 | Seleção de dispositivo de câmera (`DEV-FR-002`) | P1 | phase-08 |

## SUB — Modelo de assinatura de stream (a spec mais crítica do projeto)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| SUB-FR-001 | `stream.publish` apenas registra o stream (`stream.published` broadcast); nenhum RTP flui até haver um subscriber | P0 | phase-07 |
| SUB-FR-002 | `stream.subscribe {streamId}` do viewer é encaminhado apenas ao owner (`stream.subscription_requested`); owner ativa o RTP sender daquele track **só para aquela PeerConnection** | P0 | phase-07 |
| SUB-FR-003 | `stream.unsubscribe` faz o owner parar de enviar **apenas para aquele peer**, sem afetar outros subscribers do mesmo stream | P0 | phase-07 |
| SUB-FR-004 | Invariante: 0 subscribers de um stream ⇒ 0 envio de saída daquele stream, sempre, sem exceção | P0 | phase-07 |
| SUB-FR-005 | Estratégia v1 é desabilitar o RTP sender (não renegociar a track para fora) para evitar tempestades de renegociação por subscribe independente — tradeoff documentado em `12-stream-subscription-model.md` | P0 | phase-07 |
| SUB-FR-006 | `stream.subscribe`/`unsubscribe` são autorizados contra `CallRegistry` (viewer deve estar na mesma call do stream) | P0 | phase-07 |
| SUB-FR-007 | Subscribe tardio (stream já publicado antes do viewer entrar na call) funciona idêntico a subscribe imediato | P0 | phase-07 |
| SUB-FR-008 | `stream.unpublish` cascade: todos os subscribers daquele stream são implicitamente unsubscribed (servidor limpa `viewers`, clientes recebem `stream.unpublished`) | P0 | phase-07 |

## AUDIO — Pipeline de áudio

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| AUDIO-FR-001 | Mute local para de enviar áudio (silencia a track de saída, não desconecta) | P0 | phase-06 |
| AUDIO-FR-002 | Deafen local para de reproduzir todo áudio recebido, e implica mute automático | P0 | phase-06 |
| AUDIO-FR-003 | Enumeração e seleção de dispositivo de entrada/saída de áudio (`DEV-FR-001`) | P0 | phase-06 |
| AUDIO-FR-004 | Codec de voz é Opus | P0 | phase-06 |
| AUDIO-FR-005 | Remoção do dispositivo de áudio em uso durante a call é detectada e tratada sem derrubar a call (fallback para default, UI notifica) | P0 | phase-10 |
| AUDIO-FR-006 | Troca do dispositivo default do Windows durante a call é detectada; comportamento (auto-switch vs. manter) documentado em `13-audio-pipeline.md` | P0 | phase-10 |
| AUDIO-NFR-001 | Latência de áudio ponta-a-ponta alvo <150ms em condições de rede razoáveis (P2P direto) | P0 | phase-06 |
| AUDIO-NFR-002 | Cancelamento de eco e supressão de ruído habilitados quando disponíveis via WASAPI/`SIPSorceryMedia.Windows` | P0 | phase-06 |

## QUAL — Adaptação de qualidade

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| QUAL-FR-001 | Estimativa de banda/condição de rede por peer connection (baseado em stats RTP: perda, jitter, RTT) | P1 | phase-09 |
| QUAL-FR-002 | Redução de resolução/bitrate de vídeo sob perda de pacote sustentada ou RTT alto | P1 | phase-09 |
| QUAL-FR-003 | Simulcast/scalable video coding fica fora de v1 (naive single-encode adaptativo apenas) | P1 (baseline) | phase-09 |

## DEV — Gerenciamento de dispositivo

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| DEV-FR-001 | Enumerar dispositivos de áudio de entrada/saída disponíveis | P0 | phase-06 |
| DEV-FR-002 | Enumerar dispositivos de câmera disponíveis | P1 | phase-08 |
| DEV-FR-003 | `device.list_changed` é enviado ao servidor como telemetria informacional apenas (enumeração real é local ao cliente) | P0 | phase-06 |
| DEV-FR-004 | Preferência de dispositivo selecionado persiste localmente entre sessões | P0 | phase-06 |

## ATTACH — Anexos

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| ATTACH-FR-001 | Upload de arquivo anexado a uma mensagem (`POST /channels/{id}/attachments` seguido de `chat.message.create` referenciando o anexo) | P0 | phase-04 |
| ATTACH-FR-002 | Armazenamento de anexo em disco local do servidor v1 (`storage_path`), sem CDN/S3 | P0 | phase-04 |
| ATTACH-FR-003 | Limite de tamanho de arquivo configurável (default documentado em `08-api-design.md`) | P0 | phase-04 |
| ATTACH-FR-004 | Validação de `content_type` contra allowlist antes de aceitar o upload | P0 | phase-04 |

## NOTIF — Notificações

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| NOTIF-FR-001 | Badge de não-lido por canal na sidebar | P0 | phase-04 |
| NOTIF-FR-002 | Destaque visual de menção (`@username`) na mensagem e badge diferenciado | P0 | phase-04 |
| NOTIF-FR-003 | [Fora de escopo] Push notification para celular — não existe v1 | — | — |
| NOTIF-FR-004 | [Deferred / P2] Toast de notificação nativa do Windows quando app está em background e chega mensagem/menção — não é v1 P0, ver `28-open-questions.md` | P2 (proposto) | phase-11 |

## SETTINGS — Configurações

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| SETTINGS-FR-001 | Painel de configuração de dispositivos de áudio/vídeo | P0 | phase-06 |
| SETTINGS-FR-002 | Silenciar notificações por canal (nível cliente, não persistido no servidor) | P0 | phase-04 |
| SETTINGS-FR-003 | Tema é fixo (dark), sem toggle de aparência em v1 | P0 | phase-01 |

## SEC — Segurança (não-funcional, transversal)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| SEC-NFR-001 | TLS em toda comunicação REST e WS (terminação via Caddy) | P0 | phase-11 |
| SEC-NFR-002 | DTLS-SRTP em todo tráfego de mídia RTC (padrão WebRTC, garantido pela pilha SIPSorcery) | P0 | phase-06 |
| SEC-NFR-003 | Credenciais TURN de curta duração (HMAC, TTL configurável), nunca estáticas no cliente | P0 | phase-06 |
| SEC-NFR-004 | Token de sessão hasheado em repouso (ver `AUTH-NFR-002`) | P0 | phase-02 |
| SEC-NFR-005 | Rate limiting em endpoints de autenticação (ver `AUTH-NFR-004`) | P0 | phase-02 |
| SEC-NFR-006 | Queries parametrizadas/verificadas em compile-time via SQLx onde praticável — sem SQL injection por construção | P0 | phase-02 |
| SEC-NFR-007 | Nenhum segredo (chave HMAC do TURN, credenciais de DB) é embutido no cliente ou no repositório — apenas em config/env do servidor | P0 | phase-02 |

## OBS — Observabilidade

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| OBS-NFR-001 | Logs estruturados em JSON em produção via `tracing` + `tracing-subscriber` | P0 | phase-02 |
| OBS-NFR-002 | Todo request/conexão WS carrega um ID de correlação nos logs (`req_id` para mutations, connection id para WS) | P0 | phase-02 |
| OBS-NFR-003 | Mudanças de estado de conexão WS (`connect`, `auth.ok`, `disconnect`) são logadas com o `user_id` associado | P0 | phase-02 |
| OBS-NFR-004 | `rtc.connection_state` recebido do cliente é logado (telemetria de diagnóstico, não persistido em DB) | P0 | phase-06 |

## PERF — Performance (não-funcional, transversal)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| PERF-NFR-001 | Round-trip de mensagem de chat (enviar → todos os clientes conectados recebem) <300ms p95 na rede local/típica de v1 | P0 | phase-04 |
| PERF-NFR-002 | Orçamento de latência de áudio ponta-a-ponta <150ms (ver `AUDIO-NFR-001`) | P0 | phase-06 |
| PERF-NFR-003 | UI (WebView2/React) permanece responsiva (sem jank perceptível) durante negociação RTC ou uploads | P0 | phase-03 |
| PERF-NFR-004 | Backend suporta trivialmente 10 usuários concorrentes e até 4 participantes simultâneos em uma call — não há requisito de escala além disso em v1 | P0 | phase-02 |

## UX — Experiência de usuário (transversal, ver `18-ux-spec.md`)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| UX-FR-001 | Tema escuro único, conforme tokens de `19-design-system.md` | P0 | phase-01 |
| UX-FR-002 | Titlebar nativo padrão (não customizado), dark mode via `DwmSetWindowAttribute` | P0 | phase-03 |
| UX-FR-003 | Todos os estados vazios/carregando/erro listados em canon §10 são implementados (ver `18-ux-spec.md`) | P0 | phase-03/04/06/07 |
| UX-FR-004 | Banner de "desconectado/reconectando" quando WS cai | P0 | phase-10 |
| UX-FR-005 | Estado "conectando" por-peer durante estabelecimento de call visível na UI | P0 | phase-06 |

## DB — Banco de dados (ver `07-database-design.md`)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| DB-FR-001 | Schema implementado exatamente conforme canon §7 via migrations SQLx timestamp-prefixadas em `server/migrations/` | P0 | phase-02 |
| DB-FR-002 | Calls/streams/peers nunca são persistidos em banco — apenas em memória (`CallRegistry`) | P0 | phase-02/06 |

## API — Design de API REST (ver `08-api-design.md`, `contracts/rest-api.md`)

| ID | Requisito | Prioridade | Fase |
|---|---|---|---|
| API-FR-001 | Endpoints REST de autenticação (`/auth/login`, `/auth/logout`) | P0 | phase-02 |
| API-FR-002 | Endpoints REST de comunidade/canais/categorias (CRUD conforme `CHAN-FR-*`) | P0 | phase-02 |
| API-FR-003 | Endpoints REST de histórico de mensagens (paginado) | P0 | phase-04 |
| API-FR-004 | Endpoint REST de upload de anexo | P0 | phase-04 |
| API-FR-005 | Endpoints REST de convite (criar, ver, revogar) | P0 | phase-02 |
| API-FR-006 | Formato de erro consistente em toda a API REST (ver `contracts/rest-api.md`) | P0 | phase-02 |

---

## Rastreabilidade — como usar este documento

- Todo documento `NN-*.md` que descreve uma funcionalidade cita os IDs que
  implementa na seção "Functional/Non-functional requirements".
- `29-definition-of-done.md` usa estes IDs para o checklist "critérios de
  aceitação verificados".
- `testing/acceptance.md` mapeia os P0 acima para os 21 itens da lista de
  aceitação do product brief original.
- Se um requisito precisar mudar de forma incompatível com este documento,
  a mudança é registrada como um novo ADR em `27-decisions.md`, e este
  arquivo é atualizado no mesmo commit — nunca diverge silenciosamente.
