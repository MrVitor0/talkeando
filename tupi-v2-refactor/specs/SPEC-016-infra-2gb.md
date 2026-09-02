# SPEC-016 — Infra: limites de recursos e sobrevivência em 2 GB

## 1. Problema

**Causa raiz:** RC-20 (LiveKit sem limite de memória em uma VM de 2 GB, junto
com servidor, bot, Caddy e coturn).

`infra/docker-compose.production.yml` não define `mem_limit`, `cpus`,
`logging` nem healthcheck para nenhum serviço. O `music-bot` roda `yt-dlp` e
`ffmpeg`, cujos picos de memória são imprevisíveis. Em 2 GB, um pico pode fazer
o OOM killer do Linux escolher o `livekit-server` (derrubando todas as calls)
ou o `tupi-server` (zerando o registry em memória, produzindo o "sumiu todo
mundo" de RC-05).

A migração para SFU previa explicitamente subir a VM para 4 GB
(`docs/sfu-migration/README.md`, coluna "Humano faz depois"), o que não foi
feito. A v2 precisa caber em 2 GB.

**Sintomas que desaparecem:** ocorrências esporádicas de 1 e 2 causadas por
morte de processo, e a decisão de TTL de token de SPEC-007 §4.4.

## 2. Prioridade e dependências

- **Prioridade:** P1
- **Dependências:** nenhuma técnica. Executar **antes** do roteiro manual M-09
  (carga com 10 pessoas), que é quando a VM vai ser realmente pressionada.

## 3. Arquivos afetados

| Arquivo | Ação |
|---|---|
| `infra/docker-compose.production.yml` | editar: limites, logging, healthcheck, TTL de token |
| `infra/livekit/livekit.yaml.tmpl` | editar: limites de sala e logging |
| `infra/README.production.md` | editar: procedimento de verificação |
| `.github/workflows/deploy-production.yml` | editar: verificação pós-deploy |

## 4. Mudança especificada

### 4.1 Orçamento de memória

Alocação alvo em uma VM de 2 GB (2048 MB), deixando margem para o sistema:

| Serviço | Limite | Reserva | Justificativa |
|---|---|---|---|
| `livekit` | 640 MB | 256 MB | O processo que não pode morrer. Encaminha mídia de até 12 participantes. |
| `tupi-server` | 384 MB | 128 MB | Rust com pool de 50 conexões Postgres; o registry é kilobytes. |
| `music-bot` | 320 MB | 64 MB | Node mais `yt-dlp` e `ffmpeg`; é o pico imprevisível e o que **deve** morrer primeiro. |
| `caddy` | 128 MB | 32 MB | Proxy e TLS. |
| `coturn` | 128 MB | 32 MB | Relay UDP. |
| **Total limites** | **1600 MB** | | Deixa cerca de 448 MB para kernel, SSH e Docker. |

O ponto central não é o total, e sim a **ordem de morte**: o `music-bot` tem o
menor limite em relação ao seu consumo variável, então é ele quem estoura
primeiro, e estourar o limite de um container mata só aquele container. Sem
limites, o OOM killer escolhe pelo maior consumo absoluto, que costuma ser o
LiveKit.

```yaml
services:
  tupi-server:
    # ... configuração existente ...
    mem_limit: 384m
    mem_reservation: 128m
    cpus: 1.0
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:8080/api/community"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

O healthcheck usa um endpoint que já existe (`/api/community`,
`server/src/routes/mod.rs`). Ele responde `401` sem autenticação, o que é
suficiente: o que importa é o processo responder HTTP. `wget --spider`
considera `401` uma falha, então usar `curl -fsS -o /dev/null -w "%{http_code}"`
e aceitar qualquer resposta, ou adicionar um endpoint `/api/health` trivial no
servidor que responda `200 {"ok":true}` sem autenticação.

**Decisão: adicionar `GET /api/health`.** É uma rota de três linhas, não expõe
nada, e evita healthcheck frágil baseado em código de erro. Fica em
`server/src/routes/mod.rs` com um handler inline.

```yaml
  music-bot:
    # ... configuração existente ...
    mem_limit: 320m
    mem_reservation: 64m
    cpus: 0.75
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  caddy:
    mem_limit: 128m
    mem_reservation: 32m
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "2" }

  coturn:
    mem_limit: 128m
    mem_reservation: 32m
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "2" }

  livekit:
    mem_limit: 640m
    mem_reservation: 256m
    cpus: 1.5
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

Atenção: `mem_limit` e `cpus` no nível do serviço funcionam com
`docker compose` v2 fora do modo Swarm, que é o caso aqui (o deploy usa
`docker compose -f docker-compose.production.yml up -d`,
`.github/workflows/deploy-production.yml`). Não usar a sintaxe
`deploy.resources`, que é ignorada fora do Swarm.

`coturn` e `livekit` usam `network_mode: host`
(`infra/docker-compose.production.yml:68`, `:89`), o que não impede limites de
memória.

### 4.2 Rotação de log

Sem `max-size`, os logs JSON crescem sem limite e enchem o disco da VM. Com
SPEC-002 adicionando logs de voz, isso passa de teórico a provável.

Os valores acima dão no máximo 30 MB por serviço barulhento e 20 MB pelos
demais, cerca de 130 MB no total. Confortável.

### 4.3 TTL de token de 24 h

Decisão tomada em SPEC-007 §4.4. Adicionar ao ambiente do `tupi-server`:

```yaml
      LIVEKIT_TOKEN_TTL_SECONDS: ${LIVEKIT_TOKEN_TTL_SECONDS:-86400}
```

A variável já é lida (`server/src/config.rs:374`), com default de 21600. Passar
a defini-la explicitamente no compose torna o valor visível para quem opera.

### 4.4 `livekit.yaml.tmpl`

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: true
keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}
webhook:
  api_key: ${LIVEKIT_API_KEY}
  urls:
    - https://${API_DOMAIN}/api/livekit/webhook
turn:
  enabled: false
room:
  empty_timeout: 300
  max_participants: 12
  # Sem isto, uma sala com um participante mudo e ocioso pode ficar viva
  # indefinidamente consumindo memória.
  departure_timeout: 20
logging:
  level: info
  json: true
```

`logging.json: true` alinha o formato ao do `tupi-server`
(`server/src/telemetry.rs:11`), o que facilita correlacionar os dois com `jq`.

`max_participants: 12` fica como está: 10 humanos (INV-F2) mais o bot mais
margem para um espectador transitório.

Verificar os nomes exatos das chaves contra a documentação da versão fixada
(`livekit/livekit-server:v1.9.12`) antes de aplicar. `departure_timeout` e
`logging` existem nessa versão; se algum nome divergir, o container falha ao
subir e o healthcheck do deploy detecta.

### 4.5 Verificação pós-deploy

`.github/workflows/deploy-production.yml`, no fim do passo "Upload and apply
release", depois do `docker compose ps`:

```bash
              # Falhar o deploy se algum serviço não subiu, em vez de
              # descobrir pelo relato de usuário.
              sleep 20
              unhealthy=$(docker compose -f docker-compose.production.yml ps \
                --format '{{.Service}} {{.State}}' | grep -v ' running' || true)
              if [ -n "$unhealthy" ]; then
                echo "Serviços fora do ar após o deploy:"
                echo "$unhealthy"
                docker compose -f docker-compose.production.yml logs --tail 50
                exit 1
              fi
              # Memória: alerta se algum container passa de 90% do limite.
              docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}'
```

O `docker stats` é informativo, impresso no log do workflow para inspeção
manual. Não falhar o deploy por consumo alto: um pico momentâneo durante o
start não é motivo para reverter.

### 4.6 Procedimento de verificação manual

Adicionar a `infra/README.production.md` uma seção intitulada
"Verificar saúde da VM", com estes comandos:

```bash
ssh ubuntu@$HOST
cd /opt/talkeando/infra

# Consumo por container. livekit não pode passar de ~600 MB.
docker stats --no-stream

# Os limites foram realmente aplicados? Deve devolver bytes, nunca 0.
docker inspect infra-livekit-1 --format '{{.HostConfig.Memory}}'

# OOM killer atuou? Zero linhas é o esperado.
dmesg -T | grep -i "killed process"

# Quantas vezes cada container reiniciou desde o deploy.
docker compose -f docker-compose.production.yml ps --format '{{.Service}} {{.Status}}'

# Estado da voz, com a diferença contra o LiveKit.
curl -s -H "Authorization: Bearer $OWNER_TOKEN" \
  "https://$API_DOMAIN/api/debug/voice?live=1" | jq '.livekit_diff'
```

O nome exato do container depende do projeto do compose (`name: talkeando` em
`infra/docker-compose.production.yml:1`), então confirmar com
`docker compose ps` antes de usar no `docker inspect`.

O `grep` de OOM é o que confirma ou refuta RC-20 em produção.

## 5. Contratos de dados

Nenhum. Mudança de configuração de infraestrutura.

Nova rota `GET /api/health`, sem autenticação, resposta `200 {"ok":true}`.

## 6. Casos de borda a tratar

1. `mem_limit` fazendo o `music-bot` morrer no meio de uma música: o container
   reinicia (`restart: unless-stopped`) e a música para. É pior que hoje para
   aquela sessão, mas muito melhor que derrubar o LiveKit. Trade-off explícito
   e aceito.
2. `livekit` batendo no limite de 640 MB com 12 participantes: monitorar em
   M-09. Se acontecer, a resposta é reduzir `max_participants`, não elevar o
   limite, porque não há memória sobrando.
3. Healthcheck falhando durante um deploy: `start_period: 20s` cobre a
   inicialização e a conexão com o Postgres remoto.
4. `docker stats` em uma VM com poucos containers: leve, roda em menos de 2 s.
5. Sintaxe de `mem_limit` ignorada silenciosamente: verificar com
   `docker inspect <container> --format '{{.HostConfig.Memory}}'`, que precisa
   devolver o valor em bytes, não zero. Incluir essa verificação no
   procedimento de §4.6.
6. `departure_timeout` não existir na v1.9.12: o LiveKit falha ao subir com
   erro de config, e a verificação de §4.5 pega. Testar localmente primeiro com
   `infra/docker-compose.yml`.

## 7. Critérios de aceite

- **Dado** o deploy aplicado, **então**
  `docker inspect tupi-livekit --format '{{.HostConfig.Memory}}'` devolve
  `671088640` (640 MB), e não zero.
- **Dado** uma semana de operação, **então** `dmesg | grep -i "killed process"`
  não mostra nenhum kill do `livekit` nem do `tupi-server`.
- **Dado** o roteiro M-09 (10 pessoas, câmeras e uma tela), **então** o
  consumo do `livekit` fica abaixo de 600 MB e nenhum container reinicia.
- **Dado** um mês de logs, **então** o uso de disco por logs de container fica
  abaixo de 150 MB.
- **Dado** um deploy em que um serviço não sobe, **então** o workflow falha em
  vez de reportar sucesso.
- **Dado** `GET /api/health`, **então** responde `200` sem autenticação.

## 8. Como testar

### Local, antes de produção

1. `docker compose -f infra/docker-compose.yml up -d` com os mesmos limites
   aplicados ao compose de desenvolvimento (adicionar lá também, com valores
   proporcionais).
2. Confirmar que o LiveKit sobe com o `livekit.dev.yaml` incluindo
   `departure_timeout` e `logging`.
3. `docker inspect` para confirmar que os limites foram aplicados.

### Em produção

1. Deploy.
2. Rodar o procedimento de §4.6 imediatamente e 24 h depois.
3. Executar M-09 e coletar `docker stats --no-stream` durante o pico.
4. Registrar os números no PR.

### Teste de estresse do OOM (opcional, mas recomendado uma vez)

Em uma janela sem usuários, forçar o `music-bot` a estourar o limite (uma
playlist longa com faixas grandes) e confirmar que:

- só o `music-bot` morre;
- o `livekit` e o `tupi-server` continuam;
- uma call ativa não é afetada.

Esse teste é o que prova que a ordem de morte está correta.

## 9. Riscos e rollback

| Risco | Mitigação |
|---|---|
| Limite muito apertado matando um serviço saudável | Valores com folga sobre o consumo observado; verificar em M-09 antes de considerar concluído |
| `livekit` precisando de mais de 640 MB com 12 pessoas | Reduzir `max_participants`; a VM é o vínculo |
| Sintaxe de recursos ignorada pelo compose | Verificação por `docker inspect` no critério de aceite |
| `departure_timeout` com nome errado quebrando o LiveKit no deploy | Testar local primeiro; a verificação pós-deploy falha o workflow |

**Rollback:** `git revert` e redeploy. A configuração é declarativa e volta ao
estado anterior em um deploy.

## 10. Fora de escopo

- Não migrar para uma VM maior (restrição do pedido).
- Não trocar de provedor nem de orquestrador.
- Não adicionar Prometheus, Grafana ou agente de monitoramento
  (`09-alternatives-rejected.md` §10).
- Não mudar o Caddyfile nem a configuração de TLS.
- Não mudar o coturn além do limite de memória.
- Não mexer no Postgres (é Neon, gerenciado, fora da VM).
