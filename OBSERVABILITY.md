# Observabilidade (OpenTelemetry)

Traces, métricas RED e correlação de logs para o ecossistema Ravena: **ravena-ai**, **waifuletes** e **jardim-das-sombras**. Um trace atravessa os serviços (ex.: `!mu-roll` no Telegram → ravena → waifuletes → Postgres/Redis → ravena). O objetivo é responder rápido **onde está o tempo** e **por que falhou**.

- **Desligado por padrão.** Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, nenhum pacote do SDK é carregado e nada muda.
- **Falha do backend nunca derruba o bot.** O export é assíncrono, a fila é limitada (o excedente é descartado) e o timeout é de 10 s.

## 0. Implantação no servidor (passo a passo)

Resumo do que é preciso para ligar no servidor. Os detalhes estão nas seções seguintes.

1. **Atualizar os 3 repositórios** (ravena-ai, waifuletes, jardim-das-sombras) com a branch de telemetria. Sem as variáveis abaixo nada muda: a telemetria vem desligada.
2. **Configurar a stack** (no repo ravena-ai):
   ```bash
   cp observability/.env.example observability/.env
   # editar: GRAFANA_ADMIN_PASSWORD=<openssl rand -base64 24>
   #         OTEL_BIND_ADDR=172.17.0.1      (conferir com: ip -4 addr show docker0)
   docker compose -f observability/docker-compose.yml up -d
   ```
3. **Conferir que nada ficou exposto:** `ss -ltnp | grep -E ':(4318|16686|3001|9091)\b'` deve mostrar só `127.0.0.1` e `172.17.0.1`. Nunca `0.0.0.0` nem `*`.
4. **Ligar em cada serviço**, no `.env` de cada repo:

   | Repo | Variável | Recriar |
   |---|---|---|
   | ravena-ai | `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` | `docker compose up -d --build ravena-ai` |
   | waifuletes | `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` | `docker compose up -d --build api` |
   | jardim-das-sombras | `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318` | `docker compose up -d --build api` |

   Opcionais: `OTEL_SERVICE_NAME`, `OTEL_DEPLOYMENT_ENVIRONMENT`, `OTEL_LOG_LEVEL` (tabelas abaixo e no `OBSERVABILITY.md` de cada repo). A ordem entre os serviços não importa.
5. **Validar:**
   - o log de cada serviço mostra `[otel] telemetria ligada → …`;
   - de dentro de um container, o collector responde: `docker exec ravena-ai node -e "fetch('http://host.docker.internal:4318/v1/traces',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"` deve imprimir `200`;
   - por túnel SSH (seção 4), o Jaeger lista `ravena-ai`, `waifuletes` e `jardim-das-sombras` depois de alguns comandos.
6. **Desligar (rollback):** apagar `OTEL_EXPORTER_OTLP_ENDPOINT` do `.env` do serviço e recriar o container. Para apagar os dados guardados: `docker compose -f observability/docker-compose.yml down -v`.

## 1. Subir o backend

```bash
cp observability/.env.example observability/.env   # defina GRAFANA_ADMIN_PASSWORD (e OTEL_BIND_ADDR no Linux)
docker compose -f observability/docker-compose.yml up -d
```

| Componente | Para quê | Endereço no host |
|---|---|---|
| `obs-otel-collector` | Recebe OTLP dos serviços, mascara segredos e gera métricas RED (spanmetrics) | `${OTEL_BIND_ADDR}:4318` (OTLP/HTTP), padrão `127.0.0.1` |
| `obs-jaeger` (Jaeger v2 + Badger) | Armazena e mostra traces: busca, critical path, aba **Monitor**. **Sem login** | `127.0.0.1:16686` |
| `obs-prometheus` | Métricas RED e de runtime (sem IDs de usuário) | `127.0.0.1:9091` |
| `obs-grafana` | Dashboard **Ravena — RED e gargalos** (pasta Ravena). Login obrigatório, sem anônimo | `127.0.0.1:3001` |

Variáveis em `observability/.env` (modelo em `observability/.env.example`; o `.env` fica fora do git):

| Variável | Padrão | Efeito |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | **obrigatória** | Senha do admin do Grafana. O compose não sobe sem ela. Só vale na criação do volume `grafana-data`; para trocar depois: `docker exec obs-grafana grafana cli admin reset-admin-password <nova>` |
| `GRAFANA_ADMIN_USER` | `admin` | Usuário admin do Grafana |
| `OTEL_BIND_ADDR` | `127.0.0.1` | Interface da 4318. No **Linux nativo use `172.17.0.1`** (ver Rede) |
| `JAEGER_RETENTION` | `168h` | TTL dos traces no Badger (é por quanto tempo os IDs ficam guardados) |
| `PROMETHEUS_RETENTION` / `PROMETHEUS_RETENTION_SIZE` | `15d` / `2GB` | Retenção das métricas |
| `PROMETHEUS_PORT` | `9091` | Porta do Prometheus no host (a 9090 é usada pelo cobalt) |
| `ECONOMY_ANALYTICS_DIR_HOST` | `../data/economia` | Diretório no host onde a ravena-ai publica o `analytics.db` do painel da economia (montado só-leitura no Grafana; ver abaixo) |

**Painel da economia** (dashboard **Ravena — Economia**, fonte `Economia (SQLite)`, plugin `frser-sqlite-datasource` 4.0.6 instalado em segundo plano via `GF_PLUGINS_PREINSTALL`; com `_SYNC`, uma falha de download derruba a subida do Grafana 13.2.6). A ravena-ai (`ECONOMY_ANALYTICS_ENABLED=true`, `.env.example` seção 14; não roda com `DISABLE_ACTIVITY=true`) carrega de hora em hora (minuto 5) num banco de trabalho fora de `data/sqlites` (o backup e o `!sa` varrem essa pasta) e, ao fim de cada rodada, publica um retrato com `VACUUM INTO` + rename atômico em `data/economia/analytics.db`. O Grafana monta só esse diretório, só-leitura, e abre com `mode=ro&immutable=1`. Se o diretório não existir no `up`, o Docker cria (dono root; a ravena roda como root no contêiner e escreve nele) e o painel fica sem dados até a primeira carga. Só totais por moeda, motivo e hora, retratos de saldo e faixas (quintos com menos de 10 contas ficam nulos); nenhum dado por jogador.
Estado da carga: `docker exec ravena-ai node scripts/economy-status.js`. Anotação (mudança de regra, correção de extrato; aparece no gráfico de massa): `docker exec ravena-ai node scripts/economy-annotate.js "Descrição curta" [zinthos|petalitas|runas|todas]`. Tipos de motivo e mapeamento: `src/services/EconomyAnalyticsMapping.js` (`non_monetary` = linha que não mexe no saldo, fora de todas as somas).

As UIs ficam sempre em `127.0.0.1` (fixo no compose). Para abrir de outra máquina, use túnel SSH (seção 4).

Limites de memória: collector 512 MB, Jaeger 1 GB, Prometheus 512 MB, Grafana 512 MB. Em uso real a stack fica bem abaixo disso. Os dados ficam nos volumes `jaeger-badger`, `prometheus-data` e `grafana-data`.

**Disco:** o Badger não tem teto de tamanho, só TTL. No teste local com tráfego sintético intenso (~75 mil spans em 45 min) ocupou cerca de 60 MB. Com o volume real do bot, 7 dias devem ficar na casa de centenas de MB. Se apertar, reduza `JAEGER_RETENTION` (ex.: `72h`). Ver o uso: `docker system df -v | grep jaeger-badger`.

**Healthchecks:** Jaeger, Prometheus e Grafana têm healthcheck. O collector usa imagem distroless (sem shell); a saúde dele aparece no painel "Saúde do pipeline" do dashboard (spans aceitos/recusados).

Para mudar um arquivo de config, recrie o container: `docker compose -f observability/docker-compose.yml up -d --force-recreate <serviço>`. No Docker Desktop, o bind de arquivo único não vê edições feitas com `sed -i`.

### Rede

Os três projetos são composes separados que já se falam por `host.docker.internal` (`extra_hosts: host-gateway`). Os serviços exportam para **`http://host.docker.internal:4318`**. Não usamos uma rede Docker externa compartilhada porque `external: true` faz o `docker compose up` **falhar** quando a stack de observabilidade não existe, e isso quebraria quem não a usa.

- **Linux nativo (servidor):** `OTEL_BIND_ADDR=172.17.0.1` (gateway da `docker0`). Os containers alcançam a porta e ela fica invisível na LAN e na internet. Com o padrão `127.0.0.1` os containers **não** alcançam o collector (a telemetria simplesmente não chega). Confira o IP com `ip -4 addr show docker0`.
- **Docker Desktop (Windows/macOS/WSL):** funciona com o padrão `127.0.0.1`.
- **Nunca `0.0.0.0`:** portas publicadas pelo Docker passam por cima do `ufw`/iptables do host, e o OTLP não tem autenticação.

## 2. Ligar a telemetria em cada serviço

No `.env` de cada serviço (o `.env.example` traz o bloco comentado):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
# OTEL_SERVICE_NAME=ravena-ai   (padrão)
```

Depois, `docker compose up -d --build ravena-ai`. O log deve mostrar `[otel] telemetria ligada → ...`.

| Variável | Padrão | Descrição |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (vazio = desligado) | Endpoint OTLP/HTTP do collector |
| `OTEL_SDK_DISABLED` | — | `true` desliga mesmo com o endpoint definido |
| `OTEL_SERVICE_NAME` | `ravena-ai` | Nome do serviço |
| `OTEL_DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | `deployment.environment.name` |
| `OTEL_SQLITE_SLOW_MS` | `20` | Consultas SQLite acima disso viram span próprio |
| `OTEL_METRIC_EXPORT_INTERVAL` | `30000` | ms entre envios de métricas |
| `OTEL_LOG_LEVEL` | `error` | Log interno do SDK |

Como carrega: `node --require ./src/telemetry/otel.js index.js` (CMD do Dockerfile e `npm start`). Os helpers de spans de negócio ficam em `src/telemetry/index.js` e só usam `@opentelemetry/api`. Desligado, tudo é no-op.

Versões: o SDK está fixado na linha `@opentelemetry/sdk-node@0.223.x`, a última compatível com Node 20 (a 0.300+ exige Node ≥ 22.15). Ao migrar a imagem para Node 22, dá para subir para a linha 0.30x.

## 3. O que é instrumentado

**Automático:**
- HTTP de entrada: BotAPI Express, webhooks.
- HTTP de saída: **axios** (via `http`) e **fetch** (via `undici`), que injetam `traceparent` (W3C) nas chamadas ao waifuletes, ao Jardim e aos LLMs.
- ioredis.
- Runtime Node: event loop, GC, heap.

**Ruído descartado:**
- `/health`, estáticos e o long-poll `getUpdates` do Telegram;
- chamadas HTTP de saída **sem span pai**, como os health-checks periódicos dos serviços de IA e da whatsgoapi (sem isso, viravam dezenas de traces soltos por minuto);
- no collector, comandos Redis com menos de 1 ms (eram cerca de metade dos spans do waifuletes; os lentos continuam).

**Spans de negócio** (nomes de baixa cardinalidade; IDs nunca no nome):

| Span | Kind | Atributos principais |
|---|---|---|
| `chat.message process` | CONSUMER (raiz por mensagem) | `messaging.system` (telegram/whatsapp/discord), `ravena.chat.type`, `ravena.message.type`, `ravena.message.lag_ms` (atraso entre o envio e o processamento), `ravena.chat.id`, `ravena.user.id`, `ravena.user.alt_id` (LID/telefone alternativo), `app.outcome`/`app.reject.reason` (spam, blocked_user, debounce, spam_ban, filtered_nsfw, filtered_words, filtered_links, filtered_person, filtered_regex) |
| `nsfw detect` | INTERNAL | `ravena.chat.id`, `ravena.user.id`, `ravena.nsfw.media_type`, `ravena.nsfw.is_group_filter`, `ravena.nsfw.detect_all`, `ravena.nsfw.is_nsfw`, `ravena.nsfw.reason`, `ravena.nsfw.category`, `app.outcome`/`app.reject.reason` (filtered_nsfw se o filtro do grupo atuar) |
| `command <nome>` / `command custom` | INTERNAL | `app.command.name`, `app.command.category`, `app.command.type` (fixed/custom/auto), `app.outcome` (ok/rejected/error), `app.reject.reason` (cooldown, rate_limit, muted, time_window, `downstream_<status>`), `ravena.downstream.*` (chamadas, falhas, último status/serviço), eventos `command.checks_passed` e `command.method_done` |
| `llm.request` | INTERNAL | fila: `ravena.llm.queue_wait_ms`, `ravena.llm.priority`, `ravena.llm.tool_calling`, `ravena.llm.has_image`, `ravena.llm.humanize` |
| `chat <modelo>` | CLIENT (GenAI semconv) | `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`/`output_tokens` (somados entre rodadas de tool), `ravena.llm.rounds`, `ravena.llm.provider` |
| `execute_tool <ferramenta>` | INTERNAL | `gen_ai.tool.name` |
| `sqlite <OP> <tabela>` | CLIENT, só se ≥ `OTEL_SQLITE_SLOW_MS` | `db.system.name=sqlite`, `db.operation.name`, `db.collection.name`. Todo span também acumula `ravena.sqlite.total_ms` e `ravena.sqlite.calls` (o better-sqlite3 é síncrono e bloqueia o event loop) |
| `market transfer.runas` / `market transfer.farm` | INTERNAL | dentro de `POST /api/market/transfer` (chamado pelo waifuletes). Contagens (`ravena.market.*`), evento `market.compensation.started`, `ravena.market.compensated` |
| `fazenda harvest.reconcile` | INTERNAL | dentro de `POST /api/games/fazenda/harvest` (chamado pelo Jardim). `ravena.fazenda.credited_count` |
| `slots history.write` | INTERNAL | grava o histórico dos giros do `!slots` numa transação só (até 500 linhas). `ravena.slots.history_rows`. O span `command slots` que o contém acumula `ravena.slots.rolls`, `ravena.slots.wins`, `ravena.slots.partial_wins`, `ravena.slots.diamond_jackpot` e `app.outcome`/`app.reject.reason` (invalid_quantity, no_coins, insufficient_coins) |
| `waifu marry.scheduled` | INTERNAL (raiz) | casamento agendado do `!mu-casar` quando o timer dispara: trace próprio com link para o comando que agendou. `ravena.marry.wait_ms`, `app.outcome` (inclui `already_claimed` e a resposta do waifuletes) |
| `economy.analytics.run` / `economy.analytics.load` | INTERNAL (raiz) / INTERNAL | carga horária do painel da economia (`ECONOMY_ANALYTICS_ENABLED=true`). Por fonte: `economy.source` (zinthos/petalitas/runas), `economy.window.from`/`to` (epoch ms), `economy.live` (janela que chega à hora atual), `economy.rows`, `economy.unknown_reasons`. Sem ID de usuário |
| `command mu-foto` (atributos extras) | INTERNAL | `ravena.waifu.photo.requested`/`used`/`total` e `ravena.waifu.photo.fallback` (foto pedida inválida, caiu na padrão) |
| `command mu-diario` / `command mu-r*` / `command faz-*` (atributos extras) | INTERNAL | check-in diário: `ravena.waifu.daily.source` (api_claimed, api_cooldown, api_error, api_unexpected, cache_claimed, cache_cooldown) e `ravena.waifu.daily.amount`; `ravena.fazenda.daily.source` (api_claimed, api_cooldown, api_error, cache), `ravena.fazenda.daily.coins`/`items`. Quando o cache local (`src/services/DailyCheckinCache.js`) responde sem chamar o microsserviço, o 400 do parceiro não acontece, então o `!mu-diario` já resgatado grava `app.outcome=rejected` + `app.reject.reason=daily_already_claimed` |
| `storage get` / `storage upload` / `storage delete` / `storage delete_group` | INTERNAL | Operações de mídia no storage S3/disco: `ravena.storage.bucket`, `ravena.storage.key`, `ravena.storage.filename`, `ravena.storage.category`, `ravena.chat.id`, `ravena.storage.source` (s3/s3-legacy/cache/disk), `ravena.storage.size`, `ravena.storage.deleted_count`, `app.outcome` (ok/rejected/error), `app.reject.reason` (not_found) |

**Resultado do comando quando o microsserviço rejeita.** Os hooks de HTTP ligam cada chamada ao waifuletes/Jardim ao span do comando. Se o código do comando não definiu `app.outcome`, vale a última resposta de parceiro a uma **operação mutável** (POST/PUT/PATCH/DELETE). Se o comando só fez leituras, vale a última resposta:
- 4xx → `rejected` + `downstream_<status>`;
- 5xx ou erro de rede → `error`;
- 2xx → `ok`.

Assim, uma pré-checagem recusada seguida da ação OK não marca o comando (ex.: `kakera/daily` antes do roll). Já uma ação recusada seguida de leituras marca (ex.: colheita recusada e depois `harvest-totals`). Os atributos `ravena.downstream.last_action`, `last_action_status`, `failures` e `calls` mostram o detalhe.

`/api/market/transfer` grava motivos específicos: `insufficient_runas`, `insufficient_petalitas`, `insufficient_farm_item`, `same_user`, `invalid_*`, `buff_*`, `farm_validation_failed`. As duas rotas do mercado também gravam o resultado dos 401/429 dos guards.

`app.outcome` e `app.reject.reason` são comuns aos 3 serviços e viram dimensões das métricas RED. Rejeição de negócio esperada (cooldown, saldo, limite) **não** é erro: o span fica sem status ERROR e recebe `app.outcome=rejected`. Exceções inesperadas recebem status ERROR, `error.type` e o evento `exception`.

## 4. Segurança e dados pessoais

**O que entra nos traces:** o **ID do usuário** (telefone no WhatsApp, ID numérico no Telegram/Discord) e o **ID do grupo/chat**, para poder investigar uma reclamação ou um erro de um jogador. Por isso **a stack de observabilidade guarda dado pessoal e não pode ficar exposta**:

- **Tudo só no host.** UIs em `127.0.0.1` (fixo no compose) e collector em `127.0.0.1`/`172.17.0.1`. Nada de `0.0.0.0`, port-forward no roteador, proxy reverso público ou túnel (Cloudflare, ngrok) para essas portas. O Jaeger **não tem login**: quem alcança a 16686 vê todos os traces.
- **Acesso remoto só por túnel SSH:**
  ```bash
  ssh -L 16686:127.0.0.1:16686 -L 3001:127.0.0.1:3001 usuario@servidor
  # depois: http://localhost:16686 (Jaeger) e http://localhost:3001 (Grafana)
  ```
- **Grafana:** sem acesso anônimo, sem cadastro, senha do admin obrigatória (`GRAFANA_ADMIN_PASSWORD`).
- **Conferir depois de subir:** `ss -ltnp | grep -E '4318|16686|3001|9091'` deve mostrar só `127.0.0.1` ou `172.17.0.1`.
- **Retenção:** os IDs ficam no volume `jaeger-badger` pelo tempo de `JAEGER_RETENTION` (padrão 7 dias). Para apagar tudo: `docker compose -f observability/docker-compose.yml down` e `docker volume rm ravena-observability_jaeger-badger`. As métricas do Prometheus não têm IDs.
- **Não exportar os dados:** não cole IDs de traces com telefone em issue, chat ou log público; prints do Jaeger mostram os atributos.

**Nunca** entram em atributo, nome de span, evento ou baggage:
- nome ou apelido;
- texto de mensagem ou argumentos de comando;
- prompt ou resposta de LLM (o conteúdo GenAI é opt-in e fica desligado);
- tokens, chaves, segredos ou headers de autenticação.

Regras que valem para os spans:
- **IDs só em atributos próprios**, via `userIdAttr()`/`chatIdAttr()` de `src/telemetry/index.js`, nunca no nome do span (o nome vira dimensão de métrica).
- **URLs:** query string removida e token de bot do Telegram (`/bot<token>/`) mascarado já no SDK.
- **Rede de segurança no collector** (`transform/pii`, `attributes/pii`):
  - mascara sequências de ≥ 6 dígitos (`{n}`) em URLs, rotas, nomes de span e mensagens/stack de exceção (o ID fica só nos atributos `*.id`);
  - mascara tokens do Telegram, `key=`/`token=`/`auth=` e argumentos de comandos Redis;
  - apaga headers de auth e `user.*`/`enduser.id`.
- **Baggage não é usado**, porque ele se propaga para todos os serviços downstream.

### Achar os traces de um usuário ou grupo

Mesmo formato nos 3 serviços:
- **usuário:** ID sem sufixo, cortado no primeiro `@` e no primeiro `:` (`5511…@c.us`, `5511…:3@s.whatsapp.net` e `5511…` viram `5511…`) → `ravena.user.id`, `waifu.user.id`, `jds.user.id`. Também existem `ravena.from_user.id`/`to_user.id` e `jds.from_user.id`/`to_user.id` (transferências) e `waifu.buyer.id`/`seller.id` (mercado);
- **grupo/chat:** ID completo → `ravena.chat.id`, `waifu.group.id`.

No Jaeger: *Service* `ravena-ai`, *Tags* `ravena.user.id=5511999999999` (ou `waifu.user.id=…` / `jds.user.id=…`). No Grafana, a variável **`id`** (caixa de texto no topo) e os links "Traces do ID: …" abrem o Jaeger já filtrado no intervalo do dashboard.

Onde o ID aparece:
- na ravena, no span `chat.message process` de cada mensagem e no span SERVER de toda rota da BotAPI com `:userId`/`:groupId`, além de `/api/market/transfer` e do webhook de colheita;
- no waifuletes e no Jardim, no SERVER de toda rota com usuário e nos spans de negócio.

**LID:** quando o WhatsApp manda só o LID e a ravena não sabe o telefone, `ravena.user.id` é o LID. Se a mensagem traz os dois, o outro vai em `ravena.user.alt_id`. Uma mesma pessoa pode, então, aparecer com dois IDs até existir um ID interno unificado.

**Logs:** o `Logger` acrescenta `[trace_id=… span_id=…]` quando há span ativo. Os logs continuam só no `docker logs` e em `logs/`; não são exportados (os logs atuais têm IDs crus e não devem sair da máquina).

## 5. Como achar gargalos

**No Jaeger (http://localhost:16686):**
- **Comando lento:** Service `ravena-ai`, Operation `command mu-roll`, *Min Duration* `1s`. Abra o trace e ative **Critical Path**: o caminho em destaque é o que determina a duração.
- **Fila do LLM:** Operation `llm.request`; compare a duração com a do filho `chat <modelo>`. A diferença é fila, fallback ou retry (o atributo `ravena.llm.queue_wait_ms` e o evento `llm.dequeued` mostram a espera na fila).
- **Por que falhou:** Tags `error=true`, ou `app.outcome=error`; rejeições de negócio com `app.outcome=rejected` (veja `app.reject.reason`).
- **Jardim:** Service `jardim-das-sombras`, Operation `farm render`, Tags `jds.render.cache=miss`.
- **Mercado (3 serviços):** Service `waifuletes`, Operation `market offer.accept`. O trace desce até `POST /api/market/transfer` na ravena e `transfer` no Jardim.
- **SQLite:** Operation `sqlite SELECT <tabela>`. Em qualquer span de comando, compare `ravena.sqlite.total_ms` com a duração.
- **Aba Monitor:** RED dos spans SERVER por serviço e operação (taxa, erros, p95).
- **Comparar:** selecione dois traces da mesma operação → *Compare*.

**No Grafana (dashboard "Ravena — RED e gargalos"):**
- RED por serviço;
- top rotas por tempo total consumido (taxa × latência = onde vale otimizar);
- comandos por resultado e p95 por categoria;
- top 15 comandos mais lentos;
- LLM por modelo e fila;
- p95 do render do Jardim;
- event loop p99 e utilização (bloqueio por canvas/SQLite síncrono);
- Prisma por operação;
- saúde do pipeline (spans aceitos/recusados).

**PromQL úteis (Prometheus em http://localhost:9091):**

```promql
# p95 por comando nos últimos 30 min
histogram_quantile(0.95, sum by (le, span_name) (rate(traces_span_metrics_duration_milliseconds_bucket{service_name="ravena-ai", span_name=~"command .*"}[30m])))
# taxa de rejeição por motivo
sum by (app_outcome) (rate(traces_span_metrics_calls_total{span_name=~"command .*"}[30m]))
# tokens: some gen_ai.usage.* nos traces; as métricas RED não carregam tokens (seria cardinalidade alta)
```

**Logs ↔ trace:** `docker logs ravena-ai 2>&1 | grep <trace_id>`.

**Gerar tráfego de teste** (usuários e grupos falsos, nada é enviado a terceiros). Por padrão não chama IA. `--com-ia` inclui uma única vez `!mu-casar` (foto do casal: bonsai + LLM) e `!ai`, que usam os serviços remotos de IA; não use isso para volume:

```bash
docker compose exec ravena-ai node --require ./src/telemetry/otel.js src/testing/otel_traffic.js 2
```

## 6. Amostragem e volume

Amostra **100%** (`parentbased_always_on`), porque o volume do homelab é baixo e o spanmetrics só é fiel com 100%. O tamanho é controlado pela retenção. Se o volume crescer, use tail sampling no collector (manter erros e lentos, mais 10% do resto), com o `tailsamplingprocessor` do contrib.

## 7. Limitações conhecidas

- **WhatsApp (whatsgoapi, Go):** não instrumentado. O trace de WA começa no webhook HTTP da ravena. Para continuar o trace a partir do Go: `otelhttp.NewHandler` no servidor e `otelhttp.NewTransport` no cliente que chama o webhook, com `req.WithContext(ctx)` (pacote `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`).
- **Fire-and-forget:** com a telemetria ligada, `chat.message process` espera os comandos e respostas disparados sem `await` antes de terminar (teto de 120 s), então a duração do span da mensagem é o fim a fim. Trabalho agendado depois disso (`setTimeout`, crons) não entra no trace; a exceção é o casamento agendado, que abre o próprio trace (`waifu marry.scheduled`).
- **Sem cobertura:** `impit` (cliente HTTP em Rust), WebSocket do ComfyUI e processos filhos (ffmpeg, yt-dlp) não geram spans automáticos.
- **Jaeger:** não rastreia as próprias consultas (`enable_tracing: false`). O Badger não apaga por serviço; um serviço de teste some só quando o TTL expira.
- **Grafana sem traces:** o datasource Jaeger do Grafana não funciona com o Jaeger 2.23 (API de busca legada removida). Os traces ficam na UI do Jaeger, e o dashboard tem link para ela.
