# Beta em produção

Este compose hospeda a API, o proxy TLS, o TURN e o LiveKit SFU. O PostgreSQL fica no Neon.

## Na VPS

1. Instale Docker Engine e o plugin Docker Compose.
2. Clone este repositório e entre na pasta `infra`.
3. Copie `.env.production.example` para `.env` e substitua todos os valores de exemplo.
4. Em deploy manual, copie `music-bot.env.example` para `music-bot.env` e preencha as credenciais dos providers. No deploy automatizado, o GitHub Actions cria esse arquivo com os secrets do environment `production`.
5. Abra TCP `80`, `443` e `3478`; abra UDP `3478` e `49160-49200` no firewall da AWS e no UFW.
6. Depois de apontar `API_DOMAIN`, `TURN_DOMAIN` e `sfu.<API_DOMAIN>` para
   `TURN_EXTERNAL_IP`, abra `7881/TCP` e `50000-50200/UDP` no firewall e execute:

```sh
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml logs -f talkeando-server caddy coturn
```

O servidor aplica as migrations pendentes ao iniciar. Não execute `bootstrap-owner`: o banco Neon já contém a comunidade de produção.

## Secrets do music-bot no GitHub

Cadastre no environment `production` do repositório:

- `SPOTIFY_CLIENT_ID` — obrigatório para links do Spotify.
- `SPOTIFY_CLIENT_SECRET` — obrigatório para links do Spotify.
- `YOUTUBE_API_KEY` — obrigatório: resolve links/playlists do YouTube em título + artista pela Data API v3 (descoberta apenas).
- `AUDIUS_API_KEY` — opcional; deixe ausente se estiver usando o acesso público legado.
- `SPOTIFY_REFRESH_TOKEN` — opcional; só para playlists privadas/colaborativas. Playlists públicas funcionam sem ele.

O YouTube é só descoberta: o áudio sai de SoundCloud/Audius, então não há
`YT_DLP_COOKIES_B64`, sidecar de Proof-of-Origin (`bgutil-provider`) nem
checagem de IP de datacenter. Para reativar o player YouTube como último
recurso, defina `PROVIDER_CHAIN=cache,library,soundcloud,audius,youtube` no
ambiente do bot (sem cookies, o YouTube costuma bloquear).

## Antes de empacotar o cliente beta

Copie `client/native/Talkeando.Client/talkeando.settings.production.example.json`
sobre `talkeando.settings.json` e substitua o domínio de exemplo por `API_DOMAIN`.
O arquivo contém apenas URLs públicas e é incluído ao lado do executável no instalador.
