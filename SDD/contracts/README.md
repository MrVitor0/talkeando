# Contratos normativos da v1

Status: Decidido para implementação

## Precedência

`SDD/specs/*.md` é a fonte normativa dos requisitos e do comportamento da
v1. Este diretório traduz essas specs para referências compactas de payload;
o código deve obedecer a ambos. Quando houver conflito entre uma spec e os
documentos históricos `08-api-design.md` ou `09-websocket-protocol.md`, a
spec vence. Os documentos históricos foram substituídos como fonte de shape.

Todos os paths REST públicos são prefixados por `/api`. Todos os envelopes WS
e IPC usam `v: 1`. Uma alteração incompatível exige ADR e aumento de versão.

## Arquivos

- `rest-api.md`: REST e formatos de erro.
- `websocket-events.md`: envelopes de signaling e tempo real.
- `ipc-native-ui.md`: fronteira React ↔ host C#.

