# Flow — sair de call

1. UI para captura/render local e envia `call.leave`.
2. Cliente fecha todos os PeerControllers e tiles de streams.
3. Servidor remove participante, despublica seus streams e envia
   `call.peer_left`/`stream.unpublished` aos restantes.
4. Se a saída decorrer de WS perdido, o mesmo fluxo só executa após a grace
   period; uma reconexão válida o cancela.
