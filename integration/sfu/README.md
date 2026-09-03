# Testes de integração locais do SFU (protocolo v2)

Esta suíte exercita o servidor local, o LiveKit local e o WebSocket real ao
mesmo tempo. É a que mais se aproxima do uso real e a única que aplica
`voice.room.state` / `voice.room.delta` de verdade, com timing de verdade.

**Não** faz parte de nenhum workflow de CI e **não** sobe/derruba containers.
A cobertura equivalente no CI é `server/tests/voice_test.rs` (SPEC-006). Rode
esta suíte manualmente antes de cada release.

## Pré-requisitos

1. `dev.cmd -NoClients` — deixa o `tupi-server` em `127.0.0.1:8090` e o
   LiveKit em `127.0.0.1:7880` (o `infra/docker-compose.yml` já tem o serviço).
2. Duas contas que já pertençam à mesma comunidade. **Três** contas habilitam
   E-04, E-06 e E-07; com duas, esses cenários são pulados com aviso.
3. Pelo menos um canal de voz. Um **segundo** canal de voz habilita E-06.

```powershell
$env:SFU_TEST_ACCOUNTS_JSON = '[
  {"username":"alice","password":"..."},
  {"username":"bob","password":"..."},
  {"username":"carol","password":"..."}
]'
node integration/sfu/run.cjs
```

O runner inteiro leva cerca de **2 minutos**. O cenário E-02 sozinho leva 15 s
por design (ele espera passar do grace de presença de 8 s).

## Variáveis

| Variável | Padrão | Função |
|---|---|---|
| `SFU_TEST_ACCOUNTS_JSON` | — | obrigatória; array de `{username, password}` |
| `SFU_TEST_API_URL` | `http://127.0.0.1:8090/api` | base da API |
| `SFU_TEST_WS_URL` | derivada da API | endpoint do WebSocket |
| `SFU_TEST_CHANNEL_ID` | primeiro canal de voz encontrado | fixa o canal principal |
| `SFU_TEST_PROTOCOL_VERSION` | `2` | versão de protocolo alvo dos clientes; `1` roda só os cenários de roster pelo caminho v1 |
| `SFU_TEST_INTERACTIVE` | — | `1` habilita E-05 (restart manual do servidor) |
| `SFU_TEST_ALLOW_REMOTE` | — | `1` libera rodar contra um host que não seja `localhost`/`127.0.0.1`. **Nunca** aponte para produção: o runner altera estado de voz |
| `SFU_TEST_TIMEOUT_MS` | `20000` | timeout de cada `waitFor`/`eventually` |

Sem `SFU_TEST_ALLOW_REMOTE=1`, o runner **recusa** rodar se `SFU_TEST_API_URL`
não for local.

## Os sete cenários

| # | O que faz | O que prova |
|---|---|---|
| E-01 | Três contas entram no mesmo canal em sequência | cada uma vê as outras em `voice.room.state`, e `room.remoteParticipants` bate com a lista |
| E-02 | Uma conta derruba o WebSocket (`terminate`) sem sair do LiveKit | as outras **continuam** vendo essa conta (INV-A3); ao reconectar, sem duplicata. Antes da v2 este teste falharia — é o que dá sinal se a mudança de INV-A3 for revertida |
| E-03 | Uma conta desconecta a mídia do LiveKit sem avisar o WS | as outras deixam de vê-la em até 20 s (webhook `participant_left` + reconcile) |
| E-04 | Publica, despublica e republica a tela cinco vezes | após cada publicação há **exatamente uma** track de tela, com o `track_sid` atual. Dá sinal se o endereçamento por SID for revertido |
| E-05 | Servidor é reiniciado com três contas em call (só com `SFU_TEST_INTERACTIVE=1`) | após o boot, todos voltam ao roster em até 20 s sem ninguém reenviar nada |
| E-06 | Uma conta troca de canal 10 vezes em 5 s | estado final consistente, nenhum `error` emitido, a conta aparece em exatamente um canal |
| E-07 | Um cliente v1 simulado (sem `protocol_version`) junto de dois v2 | todos convergem para o mesmo conjunto de participantes |

Ao final, o runner imprime um resumo com o número de **lacunas de versão**
detectadas. Em um cenário saudável esse número é zero; qualquer lacuna falha a
execução (INV-C2).

## Publicação de tela sintética

E-04 publica uma track de **áudio de screen share**
(`TrackSource.SOURCE_SCREENSHARE_AUDIO`) em vez de vídeo: a API de vídeo do
`@livekit/rtc-node` 0.13.34 exige montar buffers de frame crus, e este harness
testa o control plane (SID, roster, delta), não o encoder. O caminho de
publicação, o SID e o roster no servidor são os mesmos.

## O que não é testado aqui

- Captura física de microfone/tela do Windows (depende de hardware, permissões
  e do WebView2).
- O cliente React.
- Criação de contas — o operador fornece contas que já existem.
