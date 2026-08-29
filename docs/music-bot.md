# Tupi Música (bot residente)

O bot de música roda na VPS. Ele entra no canal de voz como um peer WebRTC e
envia o áudio diretamente pelo mesh existente; `yt-dlp` e `ffmpeg` ficam
somente no container `music-bot`.

Comandos disponíveis: `/play <nome|URL>`, `/pause`, `/resume`, `/skip`,
`/stop` e `/queue`. O comando precisa ser enviado enquanto o usuário está
conectado a um canal de voz.

O bot publica cartões de estado no canal de texto de cada comando. Cada item da
fila preserva o canal que originou o pedido: uma faixa adicionada em `#música`
continua enviando seu “Tocando agora” para `#música`, mesmo que outro usuário
adicione a faixa seguinte em outro canal. Estados recebidos enquanto o canal
está fechado ficam no cache da sessão e marcam o canal como não lido.

O estado `playing` só é emitido depois que o primeiro bloco PCM chega do
`ffmpeg`. Também existem estados para carregamento, item enfileirado, pausa,
retomada, skip, fila, erro, término, stop e desconexão. Links Spotify e YouTube
usam as respectivas marcas vetoriais no cartão; buscas livres usam a marca do
provider vencedor quando disponível.

Faixas e coleções exibem os metadados disponíveis na fonte: capa ou thumbnail,
artista/canal, álbum ou playlist, duração, quantidade de faixas, posição na
fila, estimativa até começar e usuário solicitante. Playlists mostram uma
prévia das cinco primeiras músicas. A API do Spotify fornece capas e durações;
com `YOUTUBE_API_KEY`, o bot consulta `playlists.list`, `playlistItems.list` e
`videos.list` para obter capa, contagem e duração real dos vídeos. Se uma imagem
falhar, a interface volta automaticamente ao ícone do provider.

O texto informado pelo usuário é convertido primeiro em um intent independente
de fonte. Para cada faixa, o bot tenta a cadeia configurada em
`PROVIDER_CHAIN`; o padrão é `cache,library,soundcloud,audius,youtube`.
`cache` e `library` são reservados para implementação futura. Uma falha no
SoundCloud afeta somente a faixa atual: o bot tenta Audius e, por último, o
fallback existente do YouTube.

URLs de vídeo do YouTube usam o oEmbed público para obter título e autor, sem
executar `yt-dlp`. Playlists usam `playlistItems.list` quando
`YOUTUBE_API_KEY` estiver definida. Sem a chave, o link degrada para uma única
busca textual; o bot nunca chama o endpoint caro `search.list`.

Spotify é opcional e requer `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`.
Faixas, álbuns e playlists preservam título, artistas, duração e ISRC durante a
resolução. `AUDIUS_API_KEY` também é opcional e permite usar uma credencial dos
planos atuais da API Audius quando necessário.

Exemplos válidos para a ordem dos providers:

```env
PROVIDER_CHAIN=cache,library,soundcloud,audius,youtube
PROVIDER_CHAIN=["soundcloud","audius","youtube"]
```
