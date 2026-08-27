# Importação completa do Discord

O comando `import-discord-live` baixa somente os oito canais mapeados no
importador. Ele pagina as mensagens, atualiza os registros que vieram do HAR,
baixa anexos, avatares e imagens de preview para o storage do Talkeando.

O valor de `DISCORD_AUTHORIZATION` é usado apenas na memória do processo.
Não o adicione a `.env`, não o envie em chat e não o coloque em commits.
Use somente uma sessão autorizada a ler o servidor e respeite as regras da
plataforma de origem.

No PowerShell, no computador que possui a sessão autorizada, execute:

```powershell
$secure = Read-Host 'Cole a credencial de sessão do Discord' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:DISCORD_AUTHORIZATION = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  docker compose -f infra/docker-compose.production.yml run --rm -e DISCORD_AUTHORIZATION talkeando-server import-discord-live
} finally {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  Remove-Item Env:DISCORD_AUTHORIZATION -ErrorAction SilentlyContinue
}
```

Para o histórico ir diretamente ao storage de produção, rode o mesmo comando
na Lightsail, dentro de `/opt/talkeando/infra`. Antes disso, atualize o código
e recrie a imagem do servidor. O comando não grava a credencial no container;
`--rm` remove o container temporário ao terminar.

Se o Discord responder `429`, o importador respeita `retry_after` e retoma a
mesma página. Ele é idempotente pelo ID original de cada mensagem/anexo, então
é seguro executar de novo após uma interrupção.

## Resultado no Talkeando

- O apelido do membro no servidor tem prioridade sobre o nome global.
- Avatares e imagens de preview são copiados para o storage privado.
- O texto artificial `[Embed do Discord: ...]` deixa de ser usado; o card do
  preview mostra título, site e imagem, sem a descrição longa/ruidosa.
- A tag de perfil retornada pelo Discord é preservada quando presente.
