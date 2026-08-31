# AtualizaÃ§Ãµes automÃ¡ticas do Tupi para Windows

## Contrato de compatibilidade

Existem dois protocolos de update, isolados de propÃ³sito:

| Cliente | Fonte | Limite |
| --- | --- | --- |
| InstalaÃ§Ãµes Inno antigas | GitHub `releases/latest` | Apenas `v0.1.999` |
| Bridge `v0.1.999` | `tupi-update-feed/Tupi.Client-Setup.exe` | Migra para Velopack |
| InstalaÃ§Ãµes Velopack | `tupi-update-feed/releases.win-x64-<canal>.json` | Todas as releases futuras |

`v0.1.999` Ã© a **Ãºltima** release marcada como GitHub latest. Nunca anexe o
setup Velopack a ela: clientes legados escolhem o primeiro `.exe` encontrado e
nÃ£o sabem ler pacotes Velopack.

O release tÃ©cnico `tupi-update-feed` Ã© prerelease e nÃ£o deve ser instalado
manualmente. Ele mantÃ©m os `.nupkg`, o setup inicial e os Ã­ndices Velopack.
Os releases `v1+` sÃ£o voltados a pessoas e sempre sÃ£o publicados com
`--latest=false`.

## Ordem obrigatÃ³ria do primeiro lanÃ§amento

1. Execute `Release Windows client (Velopack)` para `1.0.0` no canal `stable`.
   Isso cria o release tÃ©cnico `tupi-update-feed` e envia
   `Tupi.Client-Setup.exe` + `releases.win-x64-stable.json`.
2. Em mÃ¡quinas limpas, instale o setup e valide update `1.0.0 -> 1.0.1` no
   canal beta antes de atingir stable.
3. Execute `Release final legacy bridge`, digitando a confirmaÃ§Ã£o exigida.
   O workflow publica `v0.1.999` como o Ãºnico GitHub latest.
4. Confirme que um cliente Inno antigo encontra `v0.1.999`; depois de abri-lo,
   ele baixa silenciosamente o setup Velopack e passa a atualizar pelo feed.

NÃ£o publique tags `v0.1.999` pelo workflow moderno: ele possui guarda para
ignorÃ¡-la. NÃ£o use o workflow `Build Windows client (internal artifact)` para
distribuiÃ§Ã£o; ele produz somente artifacts e nÃ£o cria releases.

## Assinatura de cÃ³digo

Assinatura nÃ£o Ã© requisito para Velopack, GitHub Releases ou update
automÃ¡tico. O pipeline publica builds sem assinatura por padrÃ£o para permitir
o beta sem custo e sem instalar certificado nos testers.

O Windows pode mostrar um aviso de publisher desconhecido/SmartScreen ao
instalar ou executar uma build sem assinatura, inclusive em alguma versÃ£o
nova. Isso afeta a experiÃªncia e a confianÃ§a, nÃ£o o protocolo de update: uma
vez executado, o Tupi baixa e aplica pacotes Velopack normalmente. Quando
houver orÃ§amento e necessidade de distribuiÃ§Ã£o ampla, assinatura pÃºblica pode
ser adicionada como etapa opcional, sem mudar o protocolo de update.

## OperaÃ§Ã£o e rollback

- Stable usa `win-x64-stable`; beta usa `win-x64-beta`.
- Nunca delete um `.nupkg` ainda referenciado por `releases.*.json`.
- Para interromper rollout, publique uma versÃ£o corrigida maior. O cliente
  somente avanÃ§a de versÃ£o; rollback exige uma release de recuperaÃ§Ã£o maior ou
  intervenÃ§Ã£o explicitamente planejada.
- `TUPI_DISABLE_AUTO_UPDATE=1` continua sendo obrigatÃ³rio nos scripts locais.
  `TUPI_UPDATE_FEED_URL` permite apontar uma instalaÃ§Ã£o de QA para outro feed.

Logs do setup Velopack ficam em `%LocalAppData%\velopack\velopack.log`.
