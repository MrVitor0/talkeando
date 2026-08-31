# Testes de integração locais do SFU

Esta suíte exercita o servidor local, o LiveKit em Docker e o WebSocket real.
Ela não é parte de nenhum workflow de CI e não inicia/para containers: execute
`dev.cmd -NoClients` antes, deixando o servidor em `127.0.0.1:8090` e o
LiveKit em `127.0.0.1:7880`.

Forneça pelo menos duas contas que já pertençam à mesma comunidade. Três
contas aumentam a cobertura de entrada tardia em uma call já ocupada.

```powershell
$env:SFU_TEST_ACCOUNTS_JSON = '[
  {"username":"alice","password":"..."},
  {"username":"bob","password":"..."},
  {"username":"carol","password":"..."}
]'
node integration/sfu/run.cjs
```

Variáveis opcionais: `SFU_TEST_API_URL` (padrão `http://127.0.0.1:8090/api`),
`SFU_TEST_WS_URL` (padrão derivado da API) e `SFU_TEST_CHANNEL_ID` para fixar
um canal de voz específico.

O runner cobre:

- emissão de token e conexão real de cada participante ao LiveKit;
- roster para entradas, saídas e abertura tardia do app;
- mute/deafen projetados pelo backend;
- publicação e remoção da sinalização de compartilhamento de tela;
- queda do WebSocket, reconexão e reanúncio de presença;
- desconexão/reconexão da mídia LiveKit;
- limpeza final de presença e da room.

Ele não testa captura física de microfone/tela do Windows: isso depende de
hardware, permissões e do WebView2. O restante usa conexões reais ao SFU.
