# Flow — reconexão

1. Ao fechar WS, cliente agenda retry exponencial com jitter (1, 2, 4, 8, 15s
   máximo) e mostra banner sem bloquear a UI.
2. O backend mantém presença/call por 8 segundos para a última conexão de um
   usuário. Uma nova `auth.ok` nesse intervalo cancela a transição offline.
3. Após reauth, o cliente substitui presença pelo snapshot e envia novo
   `call.join` caso estava em call; recria peers ausentes conforme snapshot.
4. Mensagens pendentes só fazem retry depois de confirmação de conexão e
   preservam o mesmo `req_id`; o cliente não duplica envio.
5. Após esgotar tentativas, UI permanece offline e permite retry manual.

## Camada 2 — reconexão WebRTC por peer (ICE restart)

Implementado em `RtcEngine.RestartIceAsync` + `IpcBridge.
HandleConnectionStateChangeAsync` (`client/native/Talkeando.Client`).

1. Cada `RTCPeerConnection` já reporta `onconnectionstatechange`
   (`RtcEngine.ConnectionStateChanged`). `IpcBridge` observa esse evento por
   peer.
2. **Apenas o lado com o menor `user_id` (comparação determinística de
   UUID) inicia** o ICE restart — a mesma convenção já usada para decidir
   quem oferece primeiro numa conexão nova (ver `flows/join-call.md`). Isso
   evita que os dois lados reiniciem o ICE ao mesmo tempo e colidam; **não**
   é Perfect Negotiation completo (sem rollback de SDP em caso de oferta
   inesperada) — uma simplificação aceita e registrada em
   `27-decisions.md`.
3. Estado `disconnected`: o lado iniciador espera 5s (a perda de pacotes
   breve é comum e costuma se recuperar sozinha) — se ainda `disconnected`
   após a espera, dispara o restart. Um retorno a `connected` antes disso
   cancela o timer.
4. Estado `failed`: dispara o restart imediatamente, sem espera.
5. Restart em si: `RTCPeerConnection.restartIce()` (API real do SIPSorcery
   — não aceita nem devolve SDP, só reseta o agente ICE) seguido de
   `createOffer()`/`setLocalDescription()` normais; a nova oferta (agora com
   credenciais ICE novas) é enviada como um `rtc.offer` comum pelo
   WebSocket. O lado que responde usa exatamente o mesmo caminho de
   `AcceptOfferAsync` já usado para a oferta inicial — nenhum código novo
   foi necessário nesse lado.
6. **Não implementado em v1**: reconstrução completa do `RTCPeerConnection`
   como escalonamento após um restart de ICE malsucedido (cada evento
   `failed` subsequente apenas tenta outro restart) e a camada 3 (full call
   rejoin) não tem lógica dedicada além do que a camada 1 (reconexão do
   WebSocket) já aciona reenviando `call.join`.
