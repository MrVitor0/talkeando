# Unit testing — native client

Status: Implementado (2026-08-27), 12 testes passando
Ver também: `integration.md` (backend), `../27-decisions.md`

## O que existe

`client/native/Talkeando.Client.Tests/` (xUnit, `net6.0-windows10.0.19041.0`,
referencia `Talkeando.Client` via `ProjectReference`). Rodar com:

```
cd client/native/Talkeando.Client.Tests && dotnet test
```

## Escopo deliberadamente limitado

Estes são testes de **lógica**, não de hardware. Nenhum deles abre um
microfone de verdade, captura tela de verdade, ou faz uma negociação ICE
real — este ambiente de desenvolvimento não tem um runner de CI garantido
com dispositivo de áudio/vídeo, e fingir cobertura de hardware sem validar
seria exatamente o tipo de "implementação falsa" que este projeto evita
(ver seção 38 do prompt original / `27-decisions.md`). Comportamento de
áudio/vídeo/rede reais precisa do teste manual de duas máquinas descrito em
`31-implementation-status.md`, não de um teste unitário.

O que os 12 testes cobrem:

- **`RtcEngineTests`**: `RtcEngine` começa mutado por padrão (garante que
  `IpcBridge`'s fluxo de `call.join` nunca transmite antes do usuário
  desmutar explicitamente); mute/deafen são flags independentes
  (desensurdecer não desmuta sozinho — `SetDeafened` documenta isso);
  `RemovePeer`/`LeaveCallAsync`/`UnpublishScreen`/`SetScreenSubscription`
  em cima de peers/streams que nunca existiram são no-ops seguros (não
  lançam exceção) — importante porque eventos de rede podem chegar fora de
  ordem (ex.: um `stream.subscription_requested` atrasado para um stream já
  encerrado); `ListMonitors()` não lança exceção e devolve dimensões
  plausíveis (isso também serviu como uma verificação real, empírica, de
  que construir `RtcEngine` — que aloca `WindowsAudioEndPoint` no
  construtor — e enumerar monitores via
  `System.Windows.Forms.Screen.AllScreens` funcionam de fato nesta máquina,
  não é só uma suposição de reflexão).
- **`SessionStoreTests`**: round-trip salvar/carregar preserva o token
  exato; `Clear()` remove o arquivo; um arquivo de sessão corrompido é
  tratado como "sem sessão" e se autocorrige (apaga o arquivo ruim, não
  falha para sempre); salvar um segundo token sobrescreve o primeiro.

## Mudança de API necessária para tornar isso testável com segurança

`SessionStore` tinha o caminho do arquivo (`%LOCALAPPDATA%\Talkeando\
session.bin`) fixo como `static readonly`. Testar a classe real contra esse
caminho real teria lido/sobrescrito/apagado a sessão de verdade de quem
rodasse os testes nesta máquina — um efeito colateral destrutivo real, não
hipotético. Corrigido adicionando um parâmetro de construtor opcional
(`SessionStore(string? path = null)`, default preserva o caminho real de
produção inalterado) — `IpcBridge` continua chamando `new SessionStore()`
sem mudança de comportamento; só os testes passam um caminho temporário.

## O que não está coberto aqui

- `IpcBridge` (o dispatcher de IPC) não tem teste unitário — depende de
  `CoreWebView2WebMessageReceivedEventArgs` (tipo do WebView2, não
  trivialmente instanciável fora de um WebView2 real) e orquestra I/O real
  (`NetworkClient`, `RtcEngine`). Um teste significativo exigiria extrair
  uma interface de rede mockável — não feito nesta sessão, registrado como
  possível melhoria futura.
- `NetworkClient` (HTTP/WebSocket real) não tem teste unitário — é testado
  indiretamente pelos testes de integração do servidor (que exercitam o
  protocolo que `NetworkClient` implementa do outro lado).
- Nenhum teste de UI React (`client/ui`) ainda.
