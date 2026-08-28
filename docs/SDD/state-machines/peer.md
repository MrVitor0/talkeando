# Máquina de estado — peer RTC

`new → negotiating → connecting → connected → reconnecting|failed → closed`.

Cada peer possui uma mailbox; offer, answer, ICE, add/disable track e close
são serializados. Papel é determinístico pelo UUID: o impolite cria a oferta
inicial; o polite faz rollback/aceita offer em colisão. `failed` tenta ICE
restart antes de recriar o peer. `closed` é terminal.
