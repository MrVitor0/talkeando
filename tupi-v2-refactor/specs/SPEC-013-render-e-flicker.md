# SPEC-013 — Performance de render e eliminação do flicker

## 1. Problema

**Causas raiz:** RC-11 (um `voice.roster` por canal para toda a comunidade a
cada evento, com re-render global e remontagem de `<video>`), RC-19 (parte
residual), A5 já resolvido em SPEC-005.

`App.tsx` tem cerca de 4200 linhas e **nenhum** `React.memo`. Cada `setState`
de voz re-renderiza a árvore inteira, incluindo cada `VideoTile`. Como
`onRemoteStream` criava um `MediaStream` novo por evento (`rtc.ts:188`), o
`useEffect` de `VideoTile` (`App.tsx:612-622`) reatribuía `srcObject` e chamava
`play()`, fazendo o vídeo piscar e o `useVideoReady` voltar a `false`,
remontando o overlay de carregamento.

SPEC-008 e SPEC-009 já eliminam a causa principal (o `MediaStream` novo por
evento e o estado de voz no componente). Esta spec fecha o que sobra: evitar
que um evento de roster de um canal qualquer re-renderize os tiles de vídeo.

**Sintomas que desaparecem:** 3 (flicker de UI ao entrar e sair, principalmente
com muita gente).

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** SPEC-008 (`voiceStore`), SPEC-009 (`remoteMedia`).

Executar **depois** delas: medir o flicker antes desta spec, com as duas
anteriores já aplicadas, para saber quanto ainda falta. É possível que o
problema já esteja resolvido; nesse caso, esta spec vira apenas a memoização
defensiva e a instrumentação.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `client/ui/src/App.tsx` | editar: memoizar componentes de lista e tiles |
| `client/ui/src/VoiceTile.tsx` | criar: extrair `VideoTile` e o tile de avatar |
| `client/ui/src/VoiceMemberRow.tsx` | criar: extrair a linha da sidebar |
| `client/ui/src/renderStats.ts` | criar: contador de renders em desenvolvimento |
| `client/ui/src/styles.css` | editar: transições que não remontam |

## 4. Mudança especificada

### 4.1 Medir antes de mudar

Criar `client/ui/src/renderStats.ts`:

```ts
/**
 * Contador de renders por componente, ativo só em desenvolvimento. Serve
 * para provar que a memoização funcionou, em vez de supor.
 * Ler no console com `window.__tupiRenderStats()`.
 */
const counts = new Map<string, number>();

export function countRender(name: string) {
  if (!import.meta.env.DEV) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__tupiRenderStats = () =>
    Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  (window as unknown as Record<string, unknown>).__tupiResetRenderStats = () => counts.clear();
}
```

Chamar `countRender("VideoTile")` no topo de cada componente memoizado.

Procedimento de medição, a executar antes e depois:

1. `npm run dev` em `client/ui`, com o app aberto e 3 pessoas na call, uma
   compartilhando tela.
2. `__tupiResetRenderStats()` no console.
3. Uma pessoa entra e sai do canal 5 vezes.
4. `__tupiRenderStats()` e anotar.

Meta: `VideoTile` com no máximo 2 renders por entrada ou saída (um para a
mudança de lista, um para o estado derivado), em vez de um por evento de
roster.

### 4.2 Extrair e memoizar `VoiceTile`

Mover `VideoTile` (`App.tsx:566-...`) e o tile de avatar
(`App.tsx:2773-2787`) para `client/ui/src/VoiceTile.tsx`, com `React.memo` e
comparação explícita:

```tsx
export const VoiceTile = memo(function VoiceTile(props: VoiceTileProps) {
  countRender("VoiceTile");
  // ... corpo, igual ao atual, com a mudança de mídia de SPEC-009 ...
}, arePropsEqual);

function arePropsEqual(a: VoiceTileProps, b: VoiceTileProps): boolean {
  // A identidade da mídia é o trackSid (remoto) ou o id do MediaStream (local).
  const mediaKey = (props: VoiceTileProps) =>
    props.media?.kind === "remote" ? props.media.video.trackSid
      : props.media?.kind === "local" ? props.media.stream.id
      : null;
  return mediaKey(a) === mediaKey(b)
    && a.name === b.name
    && a.micMuted === b.micMuted
    && a.peerMuted === b.peerMuted
    && a.focused === b.focused
    && a.speaking === b.speaking
    && a.isSelf === b.isSelf
    && a.variant === b.variant
    && a.screenAudioMuted === b.screenAudioMuted
    && a.screenAudioVolume === b.screenAudioVolume;
}
```

Comparar por `trackSid` em vez de por identidade de objeto é o que impede a
remontagem quando o SDK entrega a mesma track em um evento novo.

As props de callback (`onToggleMute`, `onToggleFocus`, `onStopWatch`,
`onToggleScreenAudioMute`, `onScreenAudioVolumeChange`) são deliberadamente
**ignoradas** na comparação. Elas mudam de identidade a cada render do pai, e
comparar por identidade anularia a memoização. Para que ignorá-las seja seguro,
elas precisam ser estáveis: envolver cada uma em `useCallback` no `App.tsx`,
com dependências mínimas, e garantir que nenhuma delas capture estado que muda
por render.

Alternativa mais robusta, e a escolhida: as callbacks passam a receber o
`userId` como argumento e ficam definidas fora do laço de render:

```tsx
const handleToggleMute = useCallback((userId: string) => {
  setPeerMuted(userId, !mutedPeersRef.current[userId]);
}, []);
```

com `mutedPeersRef` espelhando o estado. Assim a identidade é estável de
verdade, sem depender de disciplina de dependências.

### 4.3 Extrair e memoizar `VoiceMemberRow`

A linha da sidebar (`App.tsx:3162-3232`) é renderizada uma vez por ocupante,
por canal, a cada evento de roster de **qualquer** canal. Extrair para
`client/ui/src/VoiceMemberRow.tsx` com `memo`, comparando os campos escalares
que a linha usa: `userId`, `name`, `avatarUrl`, `nameColor`, `micMuted`,
`audioOff`, `locallyMuted`, `hasCamera`, `isLive`, `botPlaying`, `speaking`,
`isDraggable`, `isWatching`, `showPreview`.

### 4.4 Selecionar apenas a fatia usada

`useSyncExternalStore` re-renderiza sempre que o snapshot muda de identidade.
Como `voiceStore.emit()` cria um objeto novo de `VoiceState` a cada evento,
todo componente que assina re-renderiza, mesmo que sua fatia não tenha mudado.

Adicionar um seletor com igualdade:

```ts
/** Assina apenas uma fatia do estado de voz. Evita re-render quando o
 *  evento não tocou no que este componente usa. */
export function useVoiceSelector<T>(
  selector: (state: VoiceState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const lastRef = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(
    subscribeVoice,
    () => {
      const next = selector(getState());
      if (lastRef.current && isEqual(lastRef.current.value, next)) return lastRef.current.value;
      lastRef.current = { value: next };
      return next;
    },
    () => selector(getState()),
  );
}
```

Uso:

```tsx
// A sidebar de um canal só re-renderiza quando o roster daquele canal muda.
const roster = useVoiceSelector(
  state => state.rooms[channel.id]?.participants ?? EMPTY_PARTICIPANTS,
  shallowEqualParticipants,
);
```

`EMPTY_PARTICIPANTS` é uma constante de módulo (`[]` congelado), nunca um
literal inline: um array novo por chamada anularia a igualdade.

`shallowEqualParticipants` compara comprimento e, campo a campo, cada entrada.
Com no máximo 10 pessoas por canal, o custo é irrelevante e evita renders.

### 4.5 `speakingUsers` sem re-render global

`onSpeaking` (`App.tsx:1785`) chama `setSpeakingUsers` com um `Set` novo a cada
`ActiveSpeakersChanged` e a cada transição do monitor local de fala
(`rtc.ts:139`, dentro de um `requestAnimationFrame`). Em uma call ativa isso é
dezenas de re-renders globais por minuto, cada um passando por toda a árvore.

Mover para o `voiceStore` como fatia própria, e consumir com seletor por
usuário:

```ts
/** True se este usuário específico está falando. Só re-renderiza a linha
 *  dele, não a árvore. */
export function useIsSpeaking(userId: string): boolean {
  return useVoiceSelector(state => state.speaking.has(userId));
}
```

Assim, alguém começar a falar re-renderiza uma linha e um tile, não o app.

### 4.6 CSS: transições que não remontam

`client/ui/src/styles.css` tem animações de entrada
(`composer-fade-in`, `drop-pop-in`, `settings-fade-in`, `popoutFadeScale`,
`fadeIn`), mas nenhuma nos elementos de voz. O "efeito bugado" relatado ao
entrar e sair vem de remontagem, não de animação mal escrita.

Duas mudanças pequenas:

1. Garantir **chave estável** em toda lista de voz. Hoje a lista de tiles usa
   `desc.key` (`App.tsx:2690`, `cam:${userId}` e `screen:${userId}`), que já é
   estável. A lista da sidebar usa `entry.user_id` (`App.tsx:3171`), também
   estável. Confirmar que continuam assim após a extração dos componentes, e
   **nunca** usar índice de array.
2. Adicionar uma transição curta de opacidade na entrada de uma linha nova,
   para que a chegada de alguém seja percebida como suave em vez de um salto:

```css
.voice-member {
  animation: voice-member-in 0.14s ease-out;
}
@keyframes voice-member-in {
  from { opacity: 0; transform: translateY(-2px); }
  to   { opacity: 1; transform: none; }
}
```

Deliberadamente curto e sem `transform: scale`: o objetivo é suavizar, não
chamar atenção. Uma animação de saída **não** é adicionada, porque exigiria
manter o nó no DOM após a remoção e adicionaria estado ao render.

### 4.7 O que não fazer

Não introduzir `useTransition`, `useDeferredValue` nem virtualização de lista.
Com no máximo 10 pessoas por canal e cerca de 20 canais, a árvore é pequena; o
problema é frequência de render, não volume. Adicionar concorrência aqui
aumentaria a superfície de bug sem ganho mensurável.

## 5. Contratos de dados

Nenhum. Mudança puramente de render.

## 6. Casos de borda a tratar

1. `useVoiceSelector` com seletor que cria objeto novo: o `isEqual` padrão
   (`Object.is`) falharia sempre. Documentar no JSDoc que todo seletor que
   devolve objeto ou array **precisa** de `isEqual` explícito, e revisar cada
   uso.
2. `memo` com comparação que esquece uma prop: a UI fica presa em estado velho.
   Mitigação: comparar todas as props escalares explicitamente, e o teste de
   §8 cobre as principais.
3. Callback com identidade instável passando por `memo` que a ignora: por isso
   as callbacks recebem `userId` como argumento e não capturam estado.
4. `countRender` em produção: guardado por `import.meta.env.DEV`, e o Vite
   remove o bloco no build.
5. Animação de entrada disparando em cada re-render: `animation` em CSS só
   dispara na montagem do nó; com chave estável, não redispara.
6. Um tile cujo `trackSid` muda (republicação): a comparação detecta e
   re-renderiza, que é o correto.

## 7. Critérios de aceite

- **Dado** uma call com 8 pessoas e uma tela compartilhada, **quando** alguém
  entra e sai 5 vezes, **então** `__tupiRenderStats().VoiceTile` mostra no
  máximo 20 renders (2 por evento), contra o número medido antes.
- **Dado** que alguém está falando continuamente, **então** nenhum `<video>` é
  remontado (verificável: `useVideoReady` não volta a `false`).
- **Dado** que um evento de roster de outro canal chega, **então** os tiles do
  canal atual não re-renderizam.
- **Dado** M-09 (10 pessoas), **então** nenhum tile pisca ou volta ao estado de
  carregamento enquanto o vídeo flui, e a CPU do app fica abaixo de 25%.
- **Dado** que alguém entra no canal, **então** a linha aparece com transição
  suave, sem a lista inteira saltar.

## 8. Como testar

### Automatizado

`client/ui/src/VoiceTile.test.tsx`:

| Teste | Cenário |
|---|---|
| `does_not_rerender_when_unrelated_prop_identity_changes` | callbacks novas, mesmas props escalares |
| `rerenders_when_track_sid_changes` | republicação |
| `rerenders_when_speaking_changes` | |
| `does_not_reattach_track_on_rerender` | duplo de track conta `attach` |

O último é a proteção real contra o flicker, e complementa o teste equivalente
de SPEC-009.

`client/ui/src/voiceStore.test.ts` ganha:

| Teste | Cenário |
|---|---|
| `selector_returns_same_reference_when_slice_unchanged` | |
| `speaking_slice_updates_without_touching_rooms` | |

### Manual

Roteiro M-09 (carga com 10 pessoas) de `07-test-plan.md` §5, com o
procedimento de medição de §4.1 executado antes e depois. Registrar os dois
números no PR.

Verificação de percepção, que é o que o usuário relatou: gravar a tela por 30 s
durante entradas e saídas e assistir quadro a quadro procurando piscadas.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| `memo` com comparação incompleta trava a UI em estado velho | Comparação explícita de todas as props escalares; testes; roteiro manual |
| Extrair componentes de `App.tsx` gera conflito grande de merge | Fazer depois de SPEC-008 e 009, que já tocam nas mesmas regiões |
| A memoização mascara um bug de estado em vez de corrigi-lo | A causa real já foi corrigida em SPEC-008 e 009; esta spec é otimização, e por isso a medição antes e depois é obrigatória |
| Seletores mal escritos causando renders extras em vez de menos | Medição obrigatória |

**Rollback:** `git revert`. Nenhum comportamento funcional muda.

## 10. Fora de escopo

- Não quebrar `App.tsx` além dos dois componentes extraídos.
- Não introduzir biblioteca de estado (Zustand, Redux, Jotai).
- Não virtualizar listas.
- Não mexer em chat, que tem seu próprio comportamento de scroll já ajustado
  (`App.tsx:1689-1736`).
- Não mudar o visual além da transição de entrada de §4.6.
