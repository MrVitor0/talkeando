# Tupi Música (bot residente)

O bot de música roda na VPS. Ele entra no canal de voz como um peer WebRTC e
envia o áudio diretamente pelo mesh existente; `yt-dlp` e `ffmpeg` ficam
somente no container `music-bot`.

Comandos disponíveis: `/play <nome|URL>`, `/pause`, `/resume`, `/skip`,
`/stop` e `/queue`. O comando precisa ser enviado enquanto o usuário está
conectado a um canal de voz.

Buscas, URLs e playlists do YouTube funcionam sem configuração adicional.
Spotify é opcional: só funciona quando `SPOTIFY_CLIENT_ID` e
`SPOTIFY_CLIENT_SECRET` forem definidos no ambiente de produção.
