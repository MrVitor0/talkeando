# Máquina de estado — call

`not_in_call → joining → in_call → leaving → not_in_call`.

`joining` só vira `in_call` após `call.snapshot`; uma nova entrada implica
`leaving` da call anterior. `in_call → reconnecting` preserva estado local
por até a grace period e retorna por `call.join` novo. `channel_deleted`
força `not_in_call` e encerra todos os peers/streams.
