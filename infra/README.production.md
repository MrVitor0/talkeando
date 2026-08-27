# Beta em produção

Este compose hospeda a API, o proxy TLS e o TURN. O PostgreSQL fica no Neon.

## Na VPS

1. Instale Docker Engine e o plugin Docker Compose.
2. Clone este repositório e entre na pasta `infra`.
3. Copie `.env.production.example` para `.env` e substitua todos os valores de exemplo.
4. Abra TCP `80`, `443` e `3478`; abra UDP `3478` e `49160-49200` no firewall da AWS e no UFW.
5. Depois de apontar `API_DOMAIN` e `TURN_DOMAIN` para `TURN_EXTERNAL_IP`, execute:

```sh
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml logs -f talkeando-server caddy coturn
```

O servidor aplica as migrations pendentes ao iniciar. Não execute `bootstrap-owner`: o banco Neon já contém a comunidade de produção.

## Antes de empacotar o cliente beta

Copie `client/native/Talkeando.Client/talkeando.settings.production.example.json`
sobre `talkeando.settings.json` e substitua o domínio de exemplo por `API_DOMAIN`.
O arquivo contém apenas URLs públicas e é incluído ao lado do executável no instalador.
