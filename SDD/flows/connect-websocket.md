# Flow — conectar WebSocket

1. Cliente abre WS para `/ws` e inicia timeout de 10 segundos.
2. Cliente envia `auth.hello { token, req_id }` como primeiro frame.
3. Servidor valida sessão; responde `auth.ok` ou `auth.rejected` e fecha.
4. Em `auth.ok`, servidor envia `presence.snapshot` para aquela conexão.
5. UI aplica snapshot antes de processar updates incrementais; a conexão fica
   `online` somente após ambos os frames.
6. Em erro/close, UI mantém último estado em modo reconnecting e delega a
   `reconnect.md`; não marca todos os peers offline localmente.
