# SDD — Migração para SFU (LiveKit)

> Status: **implementação em andamento**.
> Modelo de execução: **uma única execução autônoma de um agente LLM**, que faz
> a migração inteira de ponta a ponta e entrega **um único commit**. Sem
> feature flag, sem backend dual, sem rollout em fases, sem "confirmar com
> humano" no meio. É uma **substituição limpa**: o mesh sai, o LiveKit entra,
> na mesma passada.

## Por que

Toda a mídia WebRTC (voz, câmera, tela, áudio de tela, bot de música,
hover-preview) é **P2P em malha** hoje, com sinalização relayada pelo servidor
Rust e coturn fazendo TURN. Isso gera uma classe de bug **independente de
escala** (2 pessoas ou 20): "só alguns ouvem o bot", "não consigo reassistir a
tela", "todo mundo some da call após deploy", "alguém entra/sai e o áudio pica".
Origem: topologia mesh + `@roamhq/wrtc` (fork de lib abandonada) + estado
efêmero em 3 camadas sem re-sync.

Um SFU (LiveKit, self-hosted, neste monorepo) resolve a categoria inteira:
reconexão com re-sync autoritativo, simulcast, keyframe, adaptação de banda e
"quem entra depois recebe o stream que já flui" — tudo já pronto na biblioteca.

## Como o agente deve usar este SDD

1. Ler **`requirements.md`** — o estado final que a migração precisa satisfazer
   (`SFU-FR-###`, `SFU-NFR-###`) e os critérios de aceite.
2. Ler **`design.md`** — os **contratos fixos** (endpoint de token, webhook,
   nomes de track, env/secrets, `livekit.yaml`). É o que o código implementa.
3. Executar **`implementation.md`** de cima a baixo, numa passada. Cada passo diz
   o que mudar e como verificar. **Rodar as suítes de teste ao longo do
   caminho**; ao final, tudo verde (`cargo test`, `music-bot npm test`,
   `client/ui npm run build`, `dotnet build`).
4. Consultar os anexos quando um passo pedir:
   - **`01-current-state.md`** — inventário do que existe hoje (arquivos, ops,
     fluxos de mídia).
   - **`02-target-architecture.md`** — topologia alvo e mapeamento conceitual.
   - **`03-changes-by-service.md`** — mudança concreta por diretório.
   - **`risks.md`** — decisões técnicas travadas, custo, alternativas.
5. Entregar **um commit** cobrindo tudo. Mensagem sugerida:
   `feat: migrate all realtime media from WebRTC mesh to LiveKit SFU`.

## O que o agente FAZ vs. o que o humano faz depois

| Faz nesta execução (código + config no repo) | Humano faz depois (fora do repo) |
|---|---|
| `routes/livekit.rs` (token + webhook), remoção de `relay_rtc`/`rtc.*`/`stream.subscribe*`/`routes/turn.rs` | Provisionar/rodar o `livekit-server` (o compose já vem pronto) |
| `client/ui/src/rtc.ts` substituído pela camada LiveKit; `nativeMusic.ts` deletado | Criar os GitHub Secrets `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` no environment `production` |
| `music-bot` sem `@roamhq/wrtc`, publicando no LiveKit | Subir a Lightsail de 2 GB → 4 GB (`SFU-NFR-003`) |
| `MusicPlayback.cs` + IPC de música local deletados | Abrir a faixa UDP `50000-50200` no firewall da Lightsail |
| `infra/`: serviço `livekit` no compose, `livekit.yaml.tmpl`, Caddyfile, CI | Rodar o deploy |
| Docs: `README.md` raiz, `protocol/`, `memory/*` atualizados | — |

## Regras invariantes

- **Substituição limpa, não coexistência.** Nada de flag `MEDIA_BACKEND`. Ao
  final, o caminho mesh não existe mais no código.
- **É tudo neste monorepo.** `infra/livekit/` novo, SDKs em `client/ui` e
  `music-bot`, mesmo `docker compose` na Lightsail, sem repo separado.
- **Servidor Rust continua a fonte da verdade:** auth, permissão, roster, chat,
  presença. Ele deixa de relayar mídia; passa a emitir token e reagir a webhook.
- **Todas as suítes verdes no fim.** Testes que exercitavam o mesh
  (`rtc.offer forbidden`, `stream.subscribe`, per-peer track do bot, etc.) são
  reescritos ou removidos, não deixados quebrados.

## Decisões travadas

| Questão | Escolha | Motivo |
|---|---|---|
| SFU próprio vs. pronto | **LiveKit** self-hosted | SFU em `webrtc-rs` = semanas + virar mantenedor de media server. |
| Escopo | **Tudo** (voz, câmera, tela, áudio de tela, bot, spectate) numa passada | Meio-mesh/meio-SFU = dois caminhos, mais complexo. |
| SDK de mídia do bot (Node) | **`@livekit/rtc-node`**; se não compilar no `node:20-bookworm-slim`, trocar a base do `music-bot/Dockerfile` para a imagem oficial do LiveKit agents/Node ou `node:20-bookworm` (não-slim) | ver `risks.md#1` |
| Transporte de sinalização antigo | **Removido** (`relay_rtc`, ops `rtc.*`, `stream.subscribe*`, `routes/turn.rs`) | cliente novo fala direto com o LiveKit |
| Infra | Lightsail **2 GB → 4 GB**; coturn mantido como TURN externo do LiveKit | 2 GB já no talo |

## Estrutura do diretório

```
docs/sfu-migration/
├── README.md                  ← índice + modelo de execução (single-shot, 1 commit)
├── requirements.md            ← specs do estado final (SFU-FR-*, SFU-NFR-*) + aceite
├── design.md                  ← contratos fixos (token, webhook, tracks, env, yaml)
├── implementation.md          ← passos de build ordenados por dependência, numa passada
├── risks.md                   ← decisões travadas, custo, alternativas
├── 01-current-state.md        ← anexo: inventário do estado atual
├── 02-target-architecture.md  ← anexo: topologia alvo / modelo LiveKit
└── 03-changes-by-service.md   ← anexo: mudança por diretório do monorepo
```
