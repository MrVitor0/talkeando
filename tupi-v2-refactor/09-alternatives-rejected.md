# 09 — Alternativas consideradas e descartadas

Registro das bifurcações reais encontradas durante a investigação. Cada uma foi
decidida; nenhuma fica aberta para o executor. Não reabrir sem uma razão nova.

---

## 1. `adaptiveStream` — desligar versus anexar o elemento real

**Contexto:** RC-12. O `Room` é criado com `adaptiveStream: true`
(`client/ui/src/rtc.ts:282`), mas o elemento que o SDK observa está com
`display: none` (`rtc.ts:183`), então o LiveKit informa ao SFU que toda track
remota está invisível.

**Opção A (descartada): `adaptiveStream: false`.** Uma linha, resolve o bug
imediatamente. Descartada porque desliga também a adaptação de qualidade por
tamanho de elemento e o pause automático de vídeo em segundo plano. Numa VM de
2 GB com upload da Lightsail compartilhado, uma tela em 1080p60 enviada para
alguém que está com a janela minimizada é exatamente o desperdício que o SFU
existe para evitar. Também perderíamos a proteção contra uma call de 10 pessoas
com várias câmeras saturando o link.

**Opção B (escolhida): anexar ao SDK o elemento que o usuário realmente vê.**
`track.attach(elementoDoReact)` no `useEffect` do componente e
`track.detach(elemento)` no cleanup. O SDK passa a observar o elemento certo, a
visibilidade reportada vira verdadeira, e `adaptiveStream` funciona como
projetado.

**Justificativa em uma linha:** manter a economia de banda que a VM de 2 GB
precisa, corrigindo a causa em vez de desligar a funcionalidade.

**Custo aceito:** SPEC-009 é maior que uma linha; exige mudar como
`VideoTile` recebe a mídia (de `MediaStream` para o `RemoteTrack`).

---

## 2. Fonte de verdade — LiveKit versus servidor Tupi

**Opção A (descartada): o `tupi-server` é a autoridade, e o LiveKit obedece.**
O servidor manteria o estado canônico e usaria `RemoveParticipant` para forçar
o LiveKit a concordar. Descartada porque inverte a realidade física: o LiveKit
é quem encaminha os pacotes. Se os dois discordarem, quem está certo é quem faz
o áudio chegar. Uma autoridade que não controla o meio é uma autoridade
fictícia, e é precisamente essa ficção que produz o sintoma 1 hoje.

**Opção B (escolhida): LiveKit é autoridade de presença de mídia; o Tupi é
autoridade apenas do que só ele sabe** (mute, deafen, quem é bot, permissões,
associação com canal e comunidade).

**Justificativa:** a única definição de "está na call" que importa para o
usuário é "eu ouço essa pessoa", e isso é decidido pelo SFU.

---

## 3. Persistir o estado de call em Postgres

**Descartada.** A motivação seria sobreviver a um restart do servidor
(sintoma 2). Mas o estado persistido seria imediatamente suspeito: depois de um
restart, quem estava na sala pode ter saído nesse meio-tempo, então o dado
persistido precisaria ser validado contra o LiveKit de qualquer forma. Ou seja,
o reconcile continuaria sendo obrigatório, e a persistência adicionaria escrita
em banco no caminho quente de cada join e leave, em uma VM de 2 GB com Postgres
remoto (Neon).

**Escolhido:** reconcile no boot, 3 s após subir
(`server/src/main.rs:188` já faz isso), reconstruindo tudo do LiveKit em menos
de 1 s para o tamanho desta comunidade.

---

## 4. Substituir o webhook por polling puro

**Descartada.** Seria mais simples: só `ListRooms` e `ListParticipants` a cada
poucos segundos, sem webhook, sem dedupe, sem SIDs obsoletos, sem verificação
de assinatura. Mas com um intervalo de 15 s a latência de "fulano entrou" fica
inaceitável, e reduzir o intervalo para 2 s significaria, com 20 canais, 21
requisições HTTP a cada 2 s contra o LiveKit, permanentemente, numa VM de 2 GB.

**Escolhido:** webhook como caminho rápido e reconcile como rede de segurança,
que é o desenho atual. O que muda é que o reconcile passa a ser confiável
(filtra ocultos, preserva estado do Tupi, não infla versão à toa) e o webhook
passa a ser seguro (dedupe, SIDs, sem apagar sala inteira).

---

## 5. Cliente derivar a call ativa do roster do servidor versus do `Room`

**Opção A (descartada): manter `call.participants` vindo de `voice.roster`,
corrigindo apenas o servidor.** Descartada porque deixa a divergência
estruturalmente possível: qualquer mensagem perdida entre servidor e cliente
recria o fantasma, e não há como o cliente detectar. A versão por sala (INV-C2)
reduz a janela, mas não a fecha.

**Opção B (escolhida): a call ativa é derivada de `room.remoteParticipants`.**
A lista exibida passa a ser a mesma estrutura de onde sai o áudio, então
INV-C1 vale por construção e não por disciplina.

**Custo aceito:** o roster do servidor continua necessário para os canais em que
não estou, então o cliente tem duas fontes com regras diferentes. Isso é
documentado explicitamente em `03-target-architecture.md` §1 e §5.2 para não
virar confusão.

---

## 6. Reescrever `App.tsx` versus extrair o estado de voz

**Opção A (descartada): quebrar `App.tsx` (4199 linhas) em componentes.**
Descartada por conflitar com a restrição de não reescrever o sistema e por
misturar refatoração estética com correção de bug: um PR de 4000 linhas movidas
torna impossível revisar a correção de concorrência que é o objetivo real.

**Opção B (escolhida): extrair apenas o estado de voz** para
`voiceStore.ts` e `callSession.ts`, deixando `App.tsx` consumindo esses módulos.
A redução de `App.tsx` é consequência, não objetivo.

---

## 7. `stream_id` v1 — aleatório versus determinístico

**Contexto:** clientes v1 esperam `streams[].stream_id`. As tracks v2 são
endereçadas por `track_sid`, então o `stream_id` precisa ser derivado.

**Opção A (descartada): gerar um UUID aleatório por projeção.** É o que o
código faz hoje (`call_registry.rs:120`), e é justamente o que faz o cliente v1
tratar o mesmo compartilhamento como novo a cada broadcast, remontando o tile e
perdendo a assinatura.

**Opção B (escolhida): UUID v5 determinístico de `(channel_id, owner, kind)`,
namespace fixo.** O mesmo compartilhamento tem sempre o mesmo id, mesmo depois
de um restart do servidor.

**Justificativa:** estabilidade do id é o que o cliente v1 assume implicitamente
e nunca teve.

---

## 8. Corrigir o `leave` com timeout curto versus com reconcile dirigido

**Opção A (descartada): manter a remoção imediata por `leave`, mas reinserir
se o LiveKit ainda listar a pessoa no próximo tick.** Produz a linha piscando
na sidebar (sai, volta, sai), que é pior para o usuário do que 2 s de atraso, e
alimenta exatamente o sintoma 3.

**Opção B (escolhida): `leave` de participante confirmado não remove; agenda um
reconcile daquele canal em 2 s.** A linha some uma vez, no momento certo.

---

## 9. Serializar a máquina de estados com uma biblioteca (XState)

**Descartada.** A máquina de `callSession` tem 5 estados e um punhado de
transições. Uma dependência nova no bundle do WebView2 e um vocabulário novo
para o time custam mais do que 80 linhas de TypeScript explícito. A garantia
que importa (INV-C3, descartar callbacks obsoletos por `sessionId`) é um
`if`, não um framework.

---

## 10. Endpoint de debug versus Prometheus e Grafana

**Descartada** a stack de métricas. Um Prometheus mais Grafana na mesma
Lightsail de 2 GB competiria por memória com o `livekit-server`, que é o
processo que não pode morrer. Para uma comunidade de dez pessoas, contadores
atômicos expostos em um JSON autenticado respondem as mesmas perguntas
(`06-observability.md` §5) por custo praticamente zero.

**Reabrir quando:** a comunidade passar de ~50 usuários simultâneos ou a VM for
promovida a 4 GB ou mais.

---

## 11. Bloquear o update quando há call ativa

**Opção A (descartada): recusar `update.apply` enquanto o usuário está em
call.** Descartada porque o usuário pode ficar horas em call, e adiar
indefinidamente a atualização é pior: mantém clientes antigos em produção, que é
a origem do risco de skew.

**Opção B (escolhida): fazer teardown gracioso antes de aplicar** — sair da
sala do LiveKit, mandar a dica de `leaving` com `participant_sid`, fechar o
WebSocket com `Close`, e só então chamar `ApplyUpdatesAndRestart`. Com timeout
de 3 s para não travar o update se algo não responder.

---

## 12. Reduzir o timeout de heartbeat do WebSocket de 60 s

**Descartada como correção.** Reduzir para, digamos, 20 s faria o servidor
detectar clientes mortos mais rápido. Mas depois de SPEC-005 a queda do WS
deixa de afetar a presença de voz (INV-A3), então o timeout do WS passa a ser
irrelevante para os sintomas relatados: ele só controla a presença
online/offline, onde 60 s é aceitável e o grace de 8 s já evita flapping.

Mexer nele agora só aumentaria a taxa de reconexão em redes ruins sem benefício.
