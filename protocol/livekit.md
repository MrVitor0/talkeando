# Transporte de mídia — LiveKit SFU

Toda voz, câmera, tela, áudio de tela e música passam pelo LiveKit SFU.
Clientes pedem `POST /api/livekit/token` autenticado com `{ channel_id, mode }`
e conectam diretamente à URL retornada. O servidor recebe eventos confiáveis em
`POST /api/livekit/webhook` e atualiza `voice.roster` e `voice.rooms`.

Os seguintes ops WebSocket foram removidos: `call.join`, `call.leave`,
`call.snapshot`, `call.peer_joined`, `call.peer_left`, `rtc.*` e `stream.*`.
`call.state.update` permanece somente como projeção de mute/deafen para o
roster; não transporta mídia.
