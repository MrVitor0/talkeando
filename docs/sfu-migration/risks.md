# Riscos, custo e decisões travadas

Execução: **uma passada, um commit** (ver `README.md`). Sem fase dual, sem flag.
Rollback = `git revert`.

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| **`@livekit/rtc-node` não roda no `node:20-bookworm-slim`** (bindings nativos Rust) | Bot não publica no LiveKit | **Decisão travada:** se não compilar no slim, trocar a base do `music-bot/Dockerfile` para `node:20-bookworm` (não-slim) ou a imagem base recomendada pelo LiveKit; registrar no `Dockerfile`. Último recurso: manter `@roamhq/wrtc` só como fonte de `RTCAudioSource` ligada num transporte LiveKit. O agente decide inline e segue. |
| **RAM na Lightsail 2 GB** com server + bot + livekit + caddy + coturn | OOM | **Tarefa do humano antes de deployar:** subir para 4 GB. É pré-requisito, não bloqueia a execução do código. |
| **Cota de banda mensal** da Lightsail com screen-share pesado diário | Excedente (~US$0,09/GB) | Capar bitrate da tela (~2 Mbps, 720–1080p) no `livekit.yaml`/publicação; `dynacast`; monitorar `docker stats` + billing. Contraponto: hoje o coturn já relaya boa parte do mesh (mídia 2× pelo box) — pode nem aumentar. |
| **Latência extra** (hop pelo SFU vs. P2P direto) | +10–40 ms em calls pequenas hoje P2P puro | Aceitável (comunidade, não competitivo). Onde hoje cai no coturn, é empate. |
| **Reescrita de `rtc.ts` + ajuste do `App.tsx`** introduz regressão de UI | Tiles, foco, PiP, fullscreen, menus de volume | A nova `rtc.ts` **mantém o mesmo conjunto de exports** que o `App.tsx` consome (ver `implementation.md` C1) — o `App.tsx` muda pouco (origem dos streams e remoção de handlers de op mortos). Testar contra o LiveKit dev antes do commit. |
| **Spectate "hidden"** — LiveKit permite participant que assina sem aparecer no roster? | Hover-preview de fora da call pode forçar "entrar" | `hidden: true` no grant existe. Se não servir, degradar para "só quem está na call vê preview" (feature secundária — o agente implementa o fallback e anota). |
| **coturn + LiveKit no host (`network_mode: host`)** — colisão de porta UDP | ICE quebrado | Faixas disjuntas: coturn `49160-49200`, LiveKit `50000-50200`. Documentado no `livekit.yaml` e no `turnserver.conf`. |
| **Testes do mesh vermelhos** após a remoção | Suíte quebrada | `implementation.md` E2/D1 reescreve/remove cada um. Checklist final exige tudo verde. |

## Custo

| Item | Custo |
|---|---|
| Lightsail 2 GB → 4 GB | ~+US$12/mês (≈US$12 → ≈US$24) |
| Banda extra (se screen-share intenso) | US$0,09/GB acima da cota; ~0 para uso normal de voz |
| LiveKit | Open-source, self-hosted, sem licença |
| Trabalho | 1 execução autônoma (o agente leva o tempo que precisar) + as 5 tarefas de infra do humano |
| Manutenção contínua | Menor: sai o motor de malha hand-rolled e o `@roamhq/wrtc` (lib abandonada) |

## Alternativas descartadas (e por quê)

| Alternativa | Por que não |
|---|---|
| **SFU próprio em `webrtc-rs`** | 3–5 semanas + virar mantenedor de media server (keyframe, congestion control, o long tail de NAT). Só vale se construir media server for objetivo. |
| **mediasoup** (C++/Node) | Ótimo, mas a API é mais baixo nível (você orquestra workers/transports/producers/consumers). Mais código que o LiveKit para o mesmo resultado. |
| **Janus** (C) | Plugin-based, config verbosa, ecossistema mais datado. |
| **ion-sfu** (Go) | Leve, mas menos mantido/documentado que o LiveKit; sem SDKs tão prontos. |
| **Manter mesh e só continuar corrigindo** | Cada correção é band-aid num stack frágil (lib abandonada + sem re-sync). A classe de bug "topologia" continua gerando variação nova (esta conversa inteira). |
| **Serviço SaaS (LiveKit Cloud, Daily, Agora)** | Custo recorrente por minuto/GB, dependência externa, dados de mídia saindo da infra própria. Contra o espírito "self-hosted" do projeto. Self-host do LiveKit dá o mesmo sem isso. |

## Decisões já travadas (o agente segue, não pergunta)

1. **Instância única** (LiveKit junto do resto no 4 GB). Separar depois é trocar
   1 URL.
2. **coturn como TURN externo** do LiveKit (`turn.enabled: false` no yaml).
3. **SDK do bot:** `@livekit/rtc-node`; se não compilar no slim, trocar a base
   do `Dockerfile` (ver risco #1). O agente resolve inline.
4. **Mute/deafen para o roster:** manter `call.state.update` (não usar attributes
   do LiveKit).
5. **Spectate de fora da call:** participant `hidden`; se inviável, degradar para
   "só quem está na call vê preview".
6. **`voice.rooms` / `voice.roster`:** continuam saindo do `tupi-server`
   (alimentados pelo `CallRegistry`-espelho de webhook). O LiveKit não tem o
   conceito de "comunidade".
7. **Gravação/egress:** fora de escopo (bônus futuro do LiveKit).

## Definição de pronto

- [ ] `cargo test` / `music-bot npm test` / `client/ui npm run build` /
      `dotnet build` — todos verdes.
- [ ] `client/ui/src/rtc.ts` reescrito p/ LiveKit; `nativeMusic.ts`,
      `MusicPlayback.cs` deletados.
- [ ] `relay_rtc` + ops `rtc.*` + `stream.subscribe*`/`stream.publish*` +
      `call.join/leave/snapshot/peer_*` + `routes/turn.rs` removidos do servidor.
- [ ] `@roamhq/wrtc` fora do `music-bot/package.json`; `peer`/`offer`/`iceServers`
      removidos do `index.js`.
- [ ] `infra/livekit/` (compose + yaml.tmpl + Caddyfile + CI) pronto.
- [ ] `README.md` raiz, `protocol/`, `memory/*` atualizados.
- [ ] Um commit.
- [ ] (humano) Secrets criados, Lightsail 4 GB, UDP `50000-50200` aberto, deploy
      feito, call testada.
- [ ] Banda mensal na Lightsail dentro da cota (ou teto de bitrate ajustado).
