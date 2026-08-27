# Importar histórico do Discord a partir de HAR

Este processo importa apenas mensagens e anexos já presentes no arquivo HAR.
Ele não usa nem extrai token, cookie ou sessão do Discord.

## Mapeamento preparado

| Discord | Canal Talkeando |
| --- | --- |
| `1353746785260015647` | `#monitor-de-noticias` |
| `590274170131185749` | `#átrio-principal` |
| `712339355477344298` | `#setor-habitacional` |
| `666381552648716317` | `#central-de-docs` |
| `693929027316088873` | `#mercado-negro` |
| `1511410023987675328` | `#black-baratheon` |
| `695237283565142027` | `#comandos-de-console` |
| `1518996513584582837` | `#atrio-principlarper` |

## Execução na VPS

1. Copie o HAR para um diretório temporário na VPS, com acesso restrito ao administrador.
2. Confirme que a API já está em execução e que o volume de anexos está montado.
3. Execute dentro do diretório `infra`:

```sh
docker compose -f docker-compose.production.yml run --rm \
  -v /caminho/privado/discord.com.har:/import/discord.com.har:ro \
  talkeando-server import-discord-har --har-path /import/discord.com.har
```

O comando aplica migrations, cria autores de arquivo sem sessão de login, preserva datas e baixa anexos do CDN do Discord para o volume persistente.

## Segurança e reexecução

- Não compartilhe o HAR: ele pode conter cabeçalhos sensíveis mesmo que o importador não os leia.
- O importador só aceita URLs de anexo em `discordapp.com` e `discordapp.net`.
- Cada mensagem e anexo importado é registrado por ID de origem. Rodar novamente não duplica os itens já importados.
- O HAR atual é parcial: para trazer mensagens antigas, gere um novo HAR após carregar páginas anteriores no Discord e rode o mesmo comando outra vez.

Embeds do Discord não têm um modelo próprio no Talkeando ainda. Título, descrição e URL de embeds são preservados como texto; anexos de imagem são copiados como anexos reais.
