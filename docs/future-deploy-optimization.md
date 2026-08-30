# Otimização futura do deploy

## Situação atual

O código é enviado à Lightsail e o `docker compose up --build` compila Rust no
VPS de 2 GB. O upload é pequeno; o build é a causa dos cerca de 11 minutos.

## Plano recomendado

1. Construir `tupi-server` e `music-bot` para `linux/amd64` no GitHub Actions,
   usando Buildx e cache, e publicar imagens imutáveis por SHA no GHCR.
2. No deploy, transmitir só `infra/`, executar `docker compose pull` e depois
   `docker compose up -d --no-build`.
3. Passar os nomes/digests das imagens ao compose por variáveis; não usar
   `latest`.
4. Criar um token de leitura de pacotes, limitado à Lightsail, e mantê-lo como
   secret. As imagens permanecem privadas.

## Resultado esperado

O build passa para o runner do GitHub; a etapa de aplicar na Lightsail deve cair
de aproximadamente 11 minutos para 30--90 segundos, conforme o pull inicial.

## Melhorias secundárias

- Construir apenas a imagem afetada por uma alteração.
- Usar `cancel-in-progress: true` quando a prioridade for sempre o commit mais
  recente.
- Subir a Lightsail para 4 GB apenas mitiga builds locais; não substitui imagens
  pré-compiladas.
