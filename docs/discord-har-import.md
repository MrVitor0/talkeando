# Importar histórico do Discord a partir de HAR

Fluxo em **2 passos**: primeiro o HAR vira um JSON local revisável, já na
estrutura das tabelas do Talkeando; depois esse JSON é ingerido pela API, que
baixa as imagens do CDN do Discord para o volume de anexos e passa a servi-las
pelo nosso próprio domínio (`/api/attachments/...`, `/api/message-embeds/...`).

Nenhum passo lê token, cookie ou sessão do HAR — só os corpos JSON de
`GET /api/v9/channels/{id}/messages`.

## Mapeamento de canais

Fica em `scripts/discord-import/har-to-json.mjs` (`CHANNEL_MAPPINGS`). Hoje:

| Discord | Canal Talkeando |
| --- | --- |
| `1353746785260015647` | `#monitor-de-noticias` |
| `590274170131185749` | `#átrio-principal` |
| `712339355477344298` | `#setor-habitacional` |
| `666381552648716317` | `#central-de-docs` |
| `693929027316088873` | `#mercado-negro` |
| `1511410023987675328` | `#black-baratheon` |
| `695237283565142027` | `#comandos-de-console` |
| `1518996513584582837` `1527733306429542491` `1353746748199403540` | `#atrio-principlarper` |

Canais fora dessa lista são ignorados.

## Passo 1 — HAR → JSON

```sh
node scripts/discord-import/har-to-json.mjs "C:\caminho\discord-new.har"
# saída: scripts/discord-import/estacao-finita.json
```

O script deduplica as páginas, classifica cada mensagem (`text`, `link`,
`image`, `text+attachment`, `embed`, `system`), usa `author.global_name` como
nome de exibição (bots caem para `username`), desescapa o Markdown do Discord e
converte `<:emoji:id>` para `:emoji:`. **Nada é baixado aqui.** Revise o JSON
antes do passo 2 — ele é a fonte da verdade do import.

## Passo 2 — JSON → Talkeando

As URLs do CDN do Discord no JSON são assinadas e **expiram em poucas horas**;
rode o passo 2 logo após gerar o JSON.

Local (contra um banco de dev):

```sh
cd server
cargo run -- import-discord-json --path ../scripts/discord-import/estacao-finita.json
```

Produção, dentro de `infra/`:

```sh
docker compose -f docker-compose.production.yml run --rm \
  -v /caminho/privado/estacao-finita.json:/import/estacao-finita.json:ro \
  talkeando-server import-discord-json --path /import/estacao-finita.json
```

O comando aplica migrations, cria autores de arquivo (sem sessão de login),
preserva datas, baixa anexos/avatares/imagens de preview e de embed para o
volume persistente, e grava:

- `messages` — texto já limpo; `client_req_id = discord:<id>`.
- `attachments` — cópia local da imagem; servida por `/api/attachments/:id`.
- `message_link_previews` — card de link (YouTube, X, Steam…) a partir do unfurl.
- `message_embeds` — embeds de bot (enquetes, "tocando agora", notas com card),
  renderizados no cliente pelo componente `MessageEmbedCard`.

## Reexecução e segurança

- Idempotente pelo ID de origem de cada mensagem/anexo (`imported_message_sources`
  / `imported_attachment_sources`). Rodar de novo **atualiza** as mensagens já
  importadas em vez de duplicá-las; os embeds da mensagem são substituídos.
- O importador só aceita URLs de anexo em `discordapp.com` / `discordapp.net`;
  imagens de preview/embed precisam ser HTTPS público.
- Não compartilhe o HAR nem o JSON: podem conter dados sensíveis mesmo que o
  importador não os leia.
- HAR parcial: para trazer mensagens mais antigas, carregue páginas anteriores
  no Discord, gere um novo HAR e rode os 2 passos de novo.

O caminho autenticado (`import-discord-live`, ver `discord-live-import.md`)
continua disponível e não foi alterado.
