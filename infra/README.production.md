# Beta em produção

Este compose hospeda a API, o proxy TLS e o TURN. O PostgreSQL fica no Neon.

## Na VPS

1. Instale Docker Engine e o plugin Docker Compose.
2. Clone este repositório e entre na pasta `infra`.
3. Copie `.env.production.example` para `.env` e substitua todos os valores de exemplo.
4. Em deploy manual, copie `music-bot.env.example` para `music-bot.env` e preencha as credenciais dos providers. No deploy automatizado, o GitHub Actions cria esse arquivo com os secrets do environment `production`.
5. Abra TCP `80`, `443` e `3478`; abra UDP `3478` e `49160-49200` no firewall da AWS e no UFW.
6. Depois de apontar `API_DOMAIN` e `TURN_DOMAIN` para `TURN_EXTERNAL_IP`, execute:

```sh
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml logs -f talkeando-server caddy coturn
```

O servidor aplica as migrations pendentes ao iniciar. Não execute `bootstrap-owner`: o banco Neon já contém a comunidade de produção.

## Secrets do music-bot no GitHub

Cadastre no environment `production` do repositório:

- `SPOTIFY_CLIENT_ID` — obrigatório para links do Spotify.
- `SPOTIFY_CLIENT_SECRET` — obrigatório para links do Spotify.
- `YOUTUBE_API_KEY` — obrigatório para expandir playlists do YouTube pela Data API v3.
- `AUDIUS_API_KEY` — opcional; deixe ausente se estiver usando o acesso público legado.

`YT_DLP_COOKIES_B64` continua opcional e pertence somente ao último fallback do
YouTube. Ele não substitui `YOUTUBE_API_KEY`, pois cookies são usados para abrir
o áudio e a chave da Data API é usada apenas para ler playlists.

## Antes de empacotar o cliente beta

Copie `client/native/Talkeando.Client/talkeando.settings.production.example.json`
sobre `talkeando.settings.json` e substitua o domínio de exemplo por `API_DOMAIN`.
O arquivo contém apenas URLs públicas e é incluído ao lado do executável no instalador.
