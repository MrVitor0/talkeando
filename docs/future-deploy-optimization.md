# Otimização do deploy

## Situação atual

O código é enviado à Lightsail e o `docker compose up --build` compila Rust no
VPS de 2 GB. O upload é pequeno; o build é a causa dos cerca de 11 minutos.

## Implementado

1. O GitHub Actions constrói `tupi-server` e `music-bot` para `linux/amd64`,
   com Buildx e cache, e publica imagens imutáveis por SHA no GHCR.
2. A Lightsail recebe somente `infra/`, faz `docker compose pull` e sobe com
   `docker compose up -d --no-build`.
3. Os nomes das imagens chegam ao Compose por variáveis; `latest` não é usado.
4. A Lightsail recebe a credencial temporária do `GITHUB_TOKEN` só para o pull
   daquele deploy e executa `docker logout` em seguida.

## Resultado esperado

O build passa para o runner do GitHub; a etapa de aplicar na Lightsail deve cair
de aproximadamente 11 minutos para 30--90 segundos, conforme o pull inicial.

## Melhorias secundárias

- Construir apenas a imagem afetada por uma alteração.
- Usar `cancel-in-progress: true` quando a prioridade for sempre o commit mais
  recente.
- Subir a Lightsail para 4 GB apenas mitiga builds locais; não substitui imagens
  pré-compiladas.
