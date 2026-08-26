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
