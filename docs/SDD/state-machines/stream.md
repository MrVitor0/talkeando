# Máquina de estado — stream

`unpublished → published_zero_viewers → published_with_viewers → unpublished`.

Publish anuncia metadados, mas mantém todos os senders desabilitados.
Subscribe adiciona somente aquele viewer e habilita seu sender. Unsubscribe
remove somente aquele viewer e o desabilita. Unpublish/remove publisher/canal
limpa o conjunto inteiro e notifica viewers. Invariante: zero viewers implica
zero RTP de vídeo daquele stream.
