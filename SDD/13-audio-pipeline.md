# 13 — Audio Pipeline

Status: Decidido
Owner/Domain: Cliente nativo (AudioPipeline)
Requisitos: `AUDIO-FR-*`, `AUDIO-NFR-*`, `DEV-FR-001/003/004`
Ver também: `05-client-architecture.md`, `10-webrtc-architecture.md`,
`testing/network-failure.md` (troca/remoção de dispositivo)

## Objetivo

Especificar como o áudio é capturado, codificado, enviado, recebido,
decodificado e reproduzido, e como mute/deafen e trocas de dispositivo são
tratados sem derrubar a call.

## Contexto

Captura/render via WASAPI (`SIPSorceryMedia.Windows`), codec Opus. Voz é o
único stream de mídia que **sempre** existe em uma call ativa (mesmo
mutado) — diferente de tela/câmera, que são `PublishedStream`s opcionais.

## Pipeline de envio (captura → rede)

```
Microfone (WASAPI capture, dispositivo selecionado)
    │
    ▼
Buffer de frames PCM (20ms, taxa nativa do dispositivo)
    │
    ▼
Resample (se necessário) para a taxa esperada pelo encoder Opus (48kHz)
    │
    ▼
Encoder Opus (via SIPSorcery)
    │
    ├── se muted == true: frames NÃO são enviados (ver "mute" abaixo)
    ▼
RTP packetizer → RTCRtpSender da track de áudio (por PeerConnection, uma vez
por peer — não há "N encodes" para N peers; o mesmo frame codificado é
replicado ao RTP sender de cada PeerConnection)
```

## Pipeline de recepção (rede → alto-falante)

```
RTCRtpReceiver (por PeerConnection remota) → depacketizer RTP
    │
    ▼
Decoder Opus (uma instância por peer remoto — nunca compartilhada)
    │
    ▼
Mixer de áudio (soma os N streams decodificados dos N peers remotos em um
único buffer de saída — mixagem acontece no cliente, nunca no servidor)
    │
    ├── se deafened == true: buffer de saída é silenciado antes do render
    │   (mas a decodificação continua acontecendo normalmente — deafen não
    │   para o recebimento de RTP, apenas o playback local, ver abaixo)
    ▼
WASAPI render (dispositivo de saída selecionado)
```

## Mute (`AUDIO-FR-001`)

Mute é um estado de aplicação local, não uma remoção de track. Quando
`muted == true`:
- O encoder Opus para de receber frames do microfone **ou** os frames
  capturados são descartados antes de chegar ao encoder (equivalente em
  efeito de rede — nenhum pacote RTP de áudio novo é enviado).
- A track de áudio permanece anexada à PeerConnection (não é removida nem
  renegociada) — só o fluxo de pacotes para. Isso evita o mesmo problema de
  tempestade de renegociação discutido em `12-stream-subscription-model.md`
  para toggles frequentes de mute.
- `call.self_update {muted: true}` é enviado ao servidor para refletir o
  estado na UI dos demais participantes (ícone de mute no roster de voz).

## Deafen (`AUDIO-FR-002`)

Deafen implica mute automático (você não pode ouvir os outros falarem "ah
peraí, você tá mutado?" e continuar falando sem perceber — deafen sempre
seta `muted = true` também do lado do próprio cliente e do servidor).
Ao ativar deafen:
- Todo áudio recebido continua sendo decodificado normalmente (não hoje
  parar a decodificação — isso evitaria acumular jitter buffer
  descontroladamente se o usuário reativar o áudio depois), mas o estágio
  final de render é silenciado/pulado.
- `call.self_update {muted: true, deafened: true}` é enviado em uma única
  mutação atômica.
- Desativar deafen não desmuta automaticamente — o usuário precisa
  desmutar explicitamente depois (evita voltar a falar sem querer assim que
  desativa o deafen).

## Dispositivos (`DEV-FR-001/003/004`, `AUDIO-FR-005/006`)

### Enumeração e seleção
`DeviceMonitor` enumera dispositivos WASAPI de entrada/saída disponíveis
sob demanda (chamada IPC `listAudioDevices()`, ver
`contracts/ipc-native-ui.md`). Preferência do usuário (device ID escolhido)
persiste localmente entre sessões (arquivo de config do cliente, não é uma
entidade de servidor).

### Dispositivo em uso é removido durante a call (`AUDIO-FR-005`)
1. `DeviceMonitor` detecta o evento de remoção (WASAPI notifica via
   `IMMNotificationClient`/equivalente).
2. `AudioPipeline` para a captura/render daquele dispositivo imediatamente
   (nunca deixa o processo travado esperando um dispositivo que sumiu).
3. Fallback automático para o dispositivo default atual do sistema
   operacional.
4. UI é notificada (evento IPC `device-changed`) e mostra um toast/estado
   transitório informando a troca — a call **não** é derrubada; apenas o
   dispositivo de captura/render muda.

### Dispositivo default do Windows muda durante a call (`AUDIO-FR-006`)
Comportamento decidido: **se o cliente estava usando explicitamente "o
dispositivo default" (não uma seleção manual fixa)**, ele segue a mudança
de default automaticamente (auto-switch). **Se o usuário tinha escolhido
manualmente um dispositivo específico** (não "usar default"), a troca do
default do sistema não afeta a call — o cliente continua no dispositivo
escolhido até que esse dispositivo específico seja removido (caso coberto
acima) ou o usuário troque manualmente. Essa distinção evita o caso
irritante de "escolhi meu headset USB, o Windows mudou o default pro
alto-falante embutido por algum motivo, e agora minha call trocou de
dispositivo sem eu pedir".

## Qualidade de áudio (`AUDIO-NFR-*`)

- Cancelamento de eco (AEC) e supressão de ruído (NS) são habilitados
  quando o pipeline WASAPI/`SIPSorceryMedia.Windows` os expõe (tipicamente
  via as capacidades de "Communications" do driver de áudio do Windows) —
  não são reimplementados em software puro no v1; se a plataforma não
  oferecer, o v1 aceita a degradação sem crash (`AUDIO-NFR-002` é
  "quando disponível", não uma garantia incondicional).
- Orçamento de latência ponta-a-ponta <150ms em P2P direto (`AUDIO-NFR-001`)
  — o frame de 20ms + buffer de jitter tipicamente adiciona ~40-60ms;
  o restante é rede.

## Falhas e recuperação

| Falha | Comportamento esperado |
|---|---|
| Nenhum dispositivo de entrada disponível ao entrar na call | Cliente entra mesmo assim, em modo "sem microfone" (equivalente a mutado permanentemente até um dispositivo aparecer); UI mostra aviso, `AUDIO-FR-003` |
| Encoder Opus falha ao inicializar | Erro tratado, call continua sem áudio de saída daquele cliente (equivalente a mute forçado), logado (`OBS-NFR-*`) |
| Buffer de jitter estoura (rede ruim) | Frames mais antigos são descartados silenciosamente (comportamento padrão de jitter buffer), nunca trava o pipeline de áudio dos demais peers |
