# Integration testing — backend

Status: Implementado e verificado em runtime (2026-08-27)
Ver também: `../27-decisions.md` ADR-004, `../22-testing-strategy.md`

## O que existe

`server/tests/` contém uma suíte de testes de integração real: cada teste
sobe o router de produção de verdade (`talkeando_server::build_app`, o
mesmo código usado pelo binário) contra um Postgres real, recém-migrado, em
um banco de dados nomeado aleatoriamente e descartado ao final do teste.
Nenhum destes testes usa mocks de banco ou de rede — eles fazem requisições
HTTP reais (via `reqwest`) e conexões WebSocket reais (via
`tokio-tungstenite`) contra um servidor `axum::serve` real ouvindo em uma
porta efêmera local.

Isso é uma escolha deliberada, não um acidente: dado que `CallRegistry` é
estado em memória (nunca persistido, ver `06-backend-architecture.md`), um
teste que mockasse a camada de rede não pegaria bugs reais de autorização
ou de roteamento de sinalização — exatamente a classe de bug mais crítica
deste projeto (ver `12-stream-subscription-model.md`).

## Como rodar

Requer um Postgres alcançável (qualquer um: `infra/docker-compose.yml`
serve, ou um container solto). Aponte `TEST_DATABASE_ADMIN_URL` para o
banco `postgres` de manutenção dele (a suíte cria e derruba seus próprios
bancos `talkeando_test_<uuid>` a partir daí):

```
TEST_DATABASE_ADMIN_URL="postgres://talkeando:talkeando@localhost:5434/postgres" cargo test
```

Sem essa variável, o default assume Postgres em `localhost:5434` com as
credenciais de `infra/docker-compose.yml`. Os testes rodam em paralelo por
padrão (`cargo test`'s default) com segurança — cada `TestApp::spawn()` cria
seu próprio banco isolado, nenhum estado global (env vars, etc.) é mutado.

## Estrutura

- `tests/common/mod.rs` — harness compartilhado: `TestApp::spawn()` sobe um
  servidor real numa porta efêmera; `TestApp::bootstrap()` cria uma
  comunidade + owner direto via SQL (o bootstrap real é só CLI, não uma
  rota HTTP — replicar a lógica aqui é a única forma de testar contra ele);
  `TestApp::register_member()` passa pelo endpoint HTTP real
  `/api/auth/register`; `WsClient` é um cliente WebSocket mínimo real
  (`connect_and_authenticate`, `send`, `recv_op`).
- `tests/auth_test.rs` — convite inválido rejeitado, registro com convite
  válido funciona e já inclui o usuário na comunidade, login com senha
  errada e com username inexistente retornam o mesmo erro genérico
  (AUTH-NFR-002), token ausente é rejeitado, sessão revogada não autentica
  mais.
- `tests/chat_test.rs` — **o teste mais importante desta sessão**: envia a
  mesma mensagem duas vezes com o mesmo `req_id` e confirma, por `SELECT`
  direto no banco, que existe exatamente uma linha (automatiza a
  verificação manual feita para `27-decisions.md` ADR-004). Também cobre:
  usuário não pode mandar mensagem para canal de outra comunidade
  (persistência zero); apenas o autor pode editar/excluir sua mensagem.
- `tests/calls_test.rs` — entrar em call devolve snapshot correto e avisa
  quem já estava lá; `rtc.offer` para alguém fora da call é rejeitado (não
  vazado silenciosamente); **o invariante mais crítico do projeto**:
  publicar um stream não envia nada a ninguém até um `stream.subscribe`
  real chegar, e `stream.unsubscribe` avisa o dono para parar; sair de uma
  call encerra (`stream.unpublished`) os streams que o usuário possuía.

- `tests/presence_test.rs` — snapshot ao conectar reflete quem já está
  online; desconexão só vira "offline" depois do grace period de 8s (não
  antes); reconectar dentro do grace period cancela a transição por
  completo (nenhum evento extra é emitido). Estes dois últimos testes
  esperam de verdade os 8 segundos — a suíte inteira leva ~2min.
- `tests/attachments_test.rs` — upload válido some visível no histórico com
  metadata completa (não só o id) assim que associado a uma mensagem;
  qualquer membro da comunidade (não só quem fez upload) consegue baixar;
  tipo de conteúdo fora da allowlist é rejeitado; usuário fora da
  comunidade recebe 404 (não 403) ao tentar baixar — nunca revela que o
  anexo existe.

- `editing_and_deleting_a_message_is_broadcast_to_other_connected_clients`
  em `chat_test.rs` confirma que edit/delete chegam a um segundo cliente
  conectado (não só ecoam de volta para o autor).

**Total: 20 testes, todos passando** (verificado nesta sessão).

## O que ainda não está coberto (registrado, não escondido)

- Limpeza automática de anexos órfãos (`unattached_attachment_ttl_hours`)
  não tem teste — exigiria manipular tempo/relógio no teste.
- Nenhum teste de carga/concorrência (múltiplos clientes reais
  simultâneos além dos 2-3 usados aqui).
- WebRTC/mídia em si (SIPSorcery, captura de tela, áudio) não pode ser
  testado no backend — isso é inerentemente client-side; ver
  `31-implementation-status.md` para o que foi verificado no cliente
  (compilação + reflexão de API, não hardware real).
