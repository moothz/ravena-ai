# Observabilidade (OpenTelemetry)

Traces, métricas RED e correlação de logs para o ecossistema Ravena: **ravena-ai**, **waifuletes** e **jardim-das-sombras**. Um trace atravessa os serviços (ex.: `!mu-roll` no Telegram → ravena → waifuletes → Postgres/Redis → ravena). O objetivo é responder rápido **onde está o tempo** e **por que falhou**.

- **Desligado por padrão.** Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, nenhum pacote do SDK é carregado e nada muda.
- **Falha do backend nunca derruba o bot.** O export é assíncrono, a fila é limitada (o excedente é descartado) e o timeout é de 10 s.

## 1. Subir o backend (um comando)

```bash
docker compose -f observability/docker-compose.yml up -d
```

| Componente | Para quê | Endereço |
|---|---|---|
| `obs-otel-collector` | Recebe OTLP dos serviços, mascara PII e gera métricas RED (spanmetrics) | `:4318` (OTLP/HTTP) |
| `obs-jaeger` (Jaeger v2 + Badger) | Armazena e mostra traces: busca, critical path, aba **Monitor** | http://localhost:16686 |
| `obs-prometheus` | Métricas RED e de runtime | http://localhost:9091 |
| `obs-grafana` | Dashboard **Ravena — RED e gargalos** (pasta Ravena) | http://localhost:3001 (anônimo = leitura; admin via `GRAFANA_ADMIN_PASSWORD`) |

Recursos e retenção (variáveis no shell ou num `.env` dentro de `observability/`):

| Variável | Padrão | Efeito |
|---|---|---|
| `JAEGER_RETENTION` | `168h` | TTL dos traces no Badger |
| `PROMETHEUS_RETENTION` / `PROMETHEUS_RETENTION_SIZE` | `15d` / `2GB` | Retenção das métricas |
| `OTEL_BIND_ADDR` | `0.0.0.0` | Interface em que a 4318 é publicada (ver rede abaixo) |
| `OBS_UI_BIND_ADDR` | `127.0.0.1` | Interface das UIs (Jaeger, Grafana, Prometheus) |
| `PROMETHEUS_PORT` | `9091` | Porta do Prometheus no host (a 9090 é usada pelo cobalt) |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / `admin` | Troque no homelab |

Limites de memória: collector 512 MB, Jaeger 1 GB, Prometheus 512 MB, Grafana 384 MB. Em uso real a stack fica bem abaixo disso. Os dados ficam nos volumes `jaeger-badger`, `prometheus-data` e `grafana-data`.

**Disco:** o Badger não tem teto de tamanho, só TTL. No teste local com tráfego sintético intenso (~75 mil spans em 45 min) ocupou cerca de 60 MB. Com o volume real do bot, 7 dias devem ficar na casa de centenas de MB. Se apertar, reduza `JAEGER_RETENTION` (ex.: `72h`). Ver o uso: `docker system df -v | grep jaeger-badger`.

**Healthchecks:** Jaeger, Prometheus e Grafana têm healthcheck. O collector usa imagem distroless (sem shell); a saúde dele aparece no painel "Saúde do pipeline" do dashboard (spans aceitos/recusados).

Para mudar um arquivo de config, recrie o container: `docker compose -f observability/docker-compose.yml up -d --force-recreate <serviço>`. No Docker Desktop, o bind de arquivo único não vê edições feitas com `sed -i`.

### Rede

Os três projetos são composes separados que já se falam por `host.docker.internal` (`extra_hosts: host-gateway`). Os serviços exportam para **`http://host.docker.internal:4318`**. Não usamos uma rede Docker externa compartilhada porque `external: true` faz o `docker compose up` **falhar** quando a stack de observabilidade não existe, e isso quebraria quem não a usa.

- **Docker Desktop (Windows/macOS/WSL):** funciona com o padrão.
- **Linux nativo (homelab):** recomenda-se `OTEL_BIND_ADDR=172.17.0.1` (gateway da `docker0`). Os containers alcançam a porta e ela fica invisível na LAN. O padrão `0.0.0.0` também funciona, mas portas publicadas pelo Docker passam por cima do `ufw`. **Nunca exponha a 4318 à internet** (OTLP não tem autenticação).

## 2. Ligar a telemetria em cada serviço

No `.env` de cada serviço (o `.env.example` traz o bloco comentado):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
OTEL_ID_SALT=<o mesmo segredo nos 3 serviços>   # openssl rand -hex 24
# OTEL_SERVICE_NAME=ravena-ai   (padrão)
```

Depois, `docker compose up -d --build ravena-ai`. O log deve mostrar `[otel] telemetria ligada → ...`.

| Variável | Padrão | Descrição |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (vazio = desligado) | Endpoint OTLP/HTTP do collector |
| `OTEL_SDK_DISABLED` | — | `true` desliga mesmo com o endpoint definido |
| `OTEL_SERVICE_NAME` | `ravena-ai` | Nome do serviço |
| `OTEL_ID_SALT` | aleatório por processo | Segredo do HMAC que pseudonimiza IDs. Igual nos 3 serviços correlaciona usuários entre eles |
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
| `chat.message process` | CONSUMER (raiz por mensagem) | `messaging.system` (telegram/whatsapp/discord), `ravena.chat.type`, `ravena.message.type`, `ravena.message.lag_ms` (atraso entre o envio e o processamento), `ravena.chat.id_hash`, `ravena.user.id_hash`, `app.outcome`/`app.reject.reason` (spam, blocked_user, debounce, spam_ban) |
| `command <nome>` / `command custom` | INTERNAL | `app.command.name`, `app.command.category`, `app.command.type` (fixed/custom/auto), `app.outcome` (ok/rejected/error), `app.reject.reason` (cooldown, rate_limit, muted, time_window), eventos `command.checks_passed` e `command.method_done` |
| `llm.request` | INTERNAL | fila: `ravena.llm.queue_wait_ms`, `ravena.llm.priority`, `ravena.llm.tool_calling`, `ravena.llm.has_image` |
| `chat <modelo>` | CLIENT (GenAI semconv) | `gen_ai.operation.name=chat`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`/`output_tokens` (somados entre rodadas de tool), `ravena.llm.rounds`, `ravena.llm.provider` |
| `execute_tool <ferramenta>` | INTERNAL | `gen_ai.tool.name` |
| `sqlite <OP> <tabela>` | CLIENT, só se ≥ `OTEL_SQLITE_SLOW_MS` | `db.system.name=sqlite`, `db.operation.name`, `db.collection.name`. Todo span também acumula `ravena.sqlite.total_ms` e `ravena.sqlite.calls` (o better-sqlite3 é síncrono e bloqueia o event loop) |
| `market transfer.runas` / `market transfer.farm` | INTERNAL | dentro de `POST /api/market/transfer` (chamado pelo waifuletes). Contagens (`ravena.market.*`), evento `market.compensation.started`, `ravena.market.compensated` |
| `fazenda harvest.reconcile` | INTERNAL | dentro de `POST /api/games/fazenda/harvest` (chamado pelo Jardim). `ravena.fazenda.credited_count` |

`app.outcome` e `app.reject.reason` são comuns aos 3 serviços e viram dimensões das métricas RED. Rejeição de negócio esperada (cooldown, saldo, limite) **não** é erro: o span fica sem status ERROR e recebe `app.outcome=rejected`. Exceções inesperadas recebem status ERROR, `error.type` e o evento `exception`.

## 4. Privacidade (política obrigatória)

**Nunca** entram em atributo, nome de span, evento ou baggage:
- telefone ou ID cru de usuário, grupo ou chat (`...@c.us`, `@g.us`, `@lid`, IDs do Telegram/Discord);
- nome ou apelido;
- texto de mensagem ou argumentos de comando;
- prompt ou resposta de LLM (o conteúdo GenAI é opt-in e fica desligado);
- tokens, chaves, segredos ou headers de autenticação.

Regras que valem para os spans:
- **IDs só como pseudônimo:** `HMAC-SHA256(OTEL_ID_SALT, id)` truncado em 16 hex (`*.id_hash`). Hash sem segredo seria reversível por força bruta, porque o espaço de telefones é pequeno.
- **URLs:** query string removida e token de bot do Telegram (`/bot<token>/`) mascarado já no SDK.
- **Rede de segurança no collector** (`transform/pii`, `attributes/pii`):
  - mascara sequências de ≥ 6 dígitos (`{n}`) em URLs, rotas, nomes de span e mensagens/stack de exceção;
  - mascara tokens do Telegram, `key=`/`token=`/`auth=` e argumentos de comandos Redis;
  - apaga headers de auth e `user.*`/`enduser.id`.
- **Baggage não é usado**, porque ele se propaga para todos os serviços downstream.

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
- **Fire-and-forget:** com a telemetria ligada, `chat.message process` espera os comandos e respostas disparados sem `await` antes de terminar (teto de 120 s), então a duração do span da mensagem é o fim a fim. Trabalho agendado depois disso (`setTimeout`, crons) não entra no trace.
- **Sem cobertura:** `impit` (cliente HTTP em Rust), WebSocket do ComfyUI e processos filhos (ffmpeg, yt-dlp) não geram spans automáticos.
- **Grafana sem traces:** o datasource Jaeger do Grafana não funciona com o Jaeger 2.23 (API de busca legada removida). Os traces ficam na UI do Jaeger, e o dashboard tem link para ela.
