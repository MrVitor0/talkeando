# Pipeline de áudio e redução de ruído

O cliente desktop atual publica áudio diretamente no LiveKit. O servidor Rust,
WebSocket e SFU não recebem PCM e não participam do processamento de voz.

## Modos

| Modo | Captura nativa | Track publicada |
| --- | --- | --- |
| `browser` (padrão) | AEC, supressão de ruído e ganho automático | track original do navegador |
| `rnnoise` | AEC e ganho automático; supressão nativa desligada | saída do AudioWorklet RNNoise |
| `off` | apenas AEC | track original do navegador |

No modo RNNoise, a cadeia é:

```text
getUserMedia (mono, alvo 48 kHz)
  → MediaStreamAudioSourceNode
  → RnnoiseWorkletNode (WASM local)
  → MediaStreamAudioDestinationNode
  → output MediaStreamTrack
  → LocalAudioTrack.replaceTrack / LiveKit publish
  → LiveKit SFU
```

O pacote `@sapphi-red/web-noise-suppressor` processa o AudioWorklet em blocos
de 128 amostras e internamente os agrupa nos frames RNNoise de 480 amostras a
48 kHz. Não há envio de áudio cru ao backend.

## Fallback e lifecycle

Se worklet, WASM ou a criação do grafo falharem, a captura RNNoise é encerrada
e o cliente adquire novamente uma captura `browser`. Nunca é publicado como
fallback o mesmo microfone capturado com a supressão nativa desligada.

`AudioPipelineManager` serializa join, troca de modo e troca de dispositivo.
Ele instala primeiro a nova track com `replaceTrack`, só então libera a track,
stream, nós e `AudioContext` anteriores. Mute/unmute reutiliza a publicação
existente e não recria o grafo. Saída ou desconexão libera todos os recursos.

## Diagnóstico

O console do cliente registra eventos `[audio]`, sem conteúdo de áudio nem
credenciais. Para confirmar RNNoise, procure nesta ordem:

1. `audio.rnnoise.worklet.loaded`
2. `audio.rnnoise.wasm.loaded`
3. `audio.rnnoise.processing.started`
4. `audio.track.published` ou `audio.track.replaced` com `processed: true`
5. `audio.pipeline.ready` com `origin: "rnnoise"`

Se houver `audio.pipeline.failed` seguido de `audio.pipeline.ready` com
`origin: "fallback"`, o app preservou a call em modo padrão; a UI não deve
mostrar RNNoise como ativo.

## Validação manual antes de release

- Entrar com `browser`, `rnnoise` e `off` e confirmar uma única publicação de microfone.
- Alternar modo e microfone durante uma chamada de dois participantes.
- Fazer mute/unmute com RNNoise ativo.
- Testar headset e microfone integrado, ruído contínuo, teclado e fala baixa.
- Sair/reentrar e reconectar a rede; verificar ausência de tracks/contexts órfãos no console.
- Confirmar que remoto recebe áudio após cada troca e que não há clipping, gaps ou eco novo.
