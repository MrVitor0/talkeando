# Flow — entrar em call

1. UI envia `call.join` para canal de voz.
2. Se o usuário estava em outro canal, servidor publica a saída antes do join.
3. Cliente recebe `call.snapshot`, inicia captura de áudio e cria um
   `PeerController` por participante remoto.
4. O peer impolite inicia a oferta; ambos trocam ICE até `connected`.
5. `call.peer_joined` cria peer para membros já conectados.
6. Falha de microfone não falha o join: UI exibe erro e o usuário ainda ouve.
