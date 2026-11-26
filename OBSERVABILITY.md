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
6. **Painéis novos numa stack que já roda** (botões de moeda, Uso de LLM, provedor do LLM): `docker compose -f observability/docker-compose.yml up -d grafana otel-collector` recria os dois com a lista de plugins e a dimensão `gen_ai.provider.name` novas. O plugin `volkovlabs-variable-panel` baixa em segundo plano (precisa de acesso a grafana.com na subida; sem ele os botões mostram "plugin não encontrado" e a lista Moedas do topo continua valendo). Conferir: `docker logs obs-grafana 2>&1 | grep -i volkovlabs`.
7. **Desligar (rollback):** apagar `OTEL_EXPORTER_OTLP_ENDPOINT` do `.env` do serviço e recriar o container. Para apagar os dados guardados: `docker compose -f observability/docker-compose.yml down -v`.

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

**Painel da economia** (dashboard **Ravena — Economia**, fonte `Economia (SQLite)`, plugins `frser-sqlite-datasource` 4.0.6 e `volkovlabs-variable-panel` 5.2.0 — botões de moeda — instalados em segundo plano via `GF_PLUGINS_PREINSTALL`; com `_SYNC`, uma falha de download derruba a subida do Grafana 13.2.6). A ravena-ai (`ECONOMY_ANALYTICS_ENABLED=true`, `.env.example` seção 14; não roda com `DISABLE_ACTIVITY=true`) carrega uma vez cerca de 1 minuto depois da subida (`ECONOMY_ANALYTICS_START_DELAY_MS`, padrão 60000; `ECONOMY_ANALYTICS_RUN_ON_START=false` desliga) e depois de hora em hora (minuto 5), num banco de trabalho fora de `data/sqlites` (o backup e o `!sa` varrem essa pasta) e, ao fim de cada rodada, publica um retrato com a API de backup do SQLite (`db.backup`, assíncrona) num temporário + `journal_mode=DELETE` + rename atômico em `data/economia/analytics.db` (temporário `.analytics.db.tmp-*` que sobrou de publicação interrompida é apagado na seguinte). A carga roda num **`worker_threads` próprio** (`EconomyAnalyticsWorkerHost` sobe `EconomyAnalyticsWorker.js`): leitura do `bank.db`, cálculo e publicação ficam fora da thread que atende o WhatsApp; a thread principal só guarda um proxy (estado, rodar agora) e, no encerramento, pede parada e espera no máximo 3 s antes de `terminate()`. Se o worker cair, sobe de novo em 60 s. Os scripts usam o serviço direto, sem worker. Logs do worker vão para o mesmo `logs/<data>-economy-analytics.log`; os spans do worker saem pelo mesmo bootstrap OpenTelemetry (no worker só traces e a instrumentação do `fetch`, sem métricas, para não duplicar as séries do bot). Permissão do retrato: `0640` quando o arquivo sai com grupo 0 (ravena como root no contêiner; o Grafana oficial roda como uid 472 **grupo 0**), senão `0644` (ravena fora do Docker, como usuário comum). O Grafana monta só esse diretório, só-leitura, e abre com `mode=ro&immutable=1`. Se o diretório não existir no `up`, o Docker cria (dono root; a ravena roda como root no contêiner e escreve nele) e o painel fica sem dados até a primeira carga. Totais por moeda, motivo e hora, retratos de saldo e faixas (quintos), sem anular faixas pequenas: é moeda de jogo, sem valor financeiro, e identificar jogadores é aceito.

**Ravena — Economia** usa o formato novo de dashboard do Grafana 13 (`dashboard.grafana.app/v2`, abas e seções) e tem seis abas, cada uma respondendo a uma pergunta: **Resumo** (situação por moeda — veredito da semana, de quando são os dados e o agendamento da carga —, alertas disparados, massa das moedas e as últimas mudanças, numa tela de 1920×1080), **Moeda** (por moeda: saldo da semana em texto — "+11.600 Zinthos, criou mais do que destruiu", âmbar só acima de 1% da massa, o limite de atenção do crescimento — e de onde vem e para onde vai em barras divergentes, saída à esquerda e entrada à direita, sem transferências entre jogadores; criado e destruído por dia; concentração — fatia dos 20% maiores e massa em cada quinto, moedas sobrepostas porque é %; mediana e p90 do saldo, quem recebe; detalhe por motivo e conferência estoque × fluxos; tabela por motivo; câmbio e transferências; e o ciclo da alma gêmea, só com Zinthos entre as moedas escolhidas: vem do `soulmateCycle` do resumo do waifuletes; `above_cost` conta só divórcio com custo de cotas > 0 e pago > custo, `without_quota` = divórcios sem cotas, NULL nas horas carregadas de um waifuletes anterior ao campo), **Jogadores** (maiores saldos lado a lado e, numa seção por moeda, anomalias, quem mais ganhou e quem mais perdeu), **Atividade** (pessoas e comandos, do `cmd_usage.db`, só leitura), **Mudanças** (ficha de antes e depois de cada mudança; mudança sem moeda aparece uma vez por moeda escolhida) e **Diagnóstico** (alertas, confiança dos dados por fonte, moeda sem origem por moeda, motivos sem mapear, cargas, disponibilidade e glossário). Painéis que dependem da fase 2 aparecem com o selo "Indisponível — depende de: …" e se ligam sozinhos quando o dado existir (tabela `features`, regravada a cada carga); Petalitas (sem extrato) aparece nos painéis por moeda com "sem extrato (fase 2)". **Moedas**: botões no topo de Resumo, Moeda, Jogadores e Mudanças (All · Zinthos · Petalitas · Runas; cada um liga/desliga uma moeda, desligar a última volta para All) — painel Business Variable ligado à variável `moedas`, a mesma da lista suspensa "Moedas" do topo, que continua funcionando sem o plugin. Valor absoluto (fluxos, mediana/p90, rankings) é **um gráfico por moeda** (painel ou seção repetida pela variável; dentro da cópia `${moedas}` vale uma moeda só, por isso o SQL usa sempre `IN (${moedas:sqlstring})`); sobreposição só onde a escala é comparável (%, índice); nunca eixo duplo. **Escala** da massa no Resumo: índice (cada moeda dividida pelo próprio primeiro retrato da janela, início = 100, eixo logarítmico: mesma inclinação = mesmo crescimento %), valor, ou separado (um gráfico por moeda, com eixo próprio). Buraco de extrato já conhecido (moeda sem origem que não passa da maior das 8 semanas anteriores) fica em "atenção · conhecido"; "agir" é para desvio da própria base. Os JSON são gerados por `observability/grafana/tools/mkdash.py` (ver o LEIAME da pasta): não edite à mão. Cada moeda tem cor fixa em todo gráfico, nos dois temas (Zinthos #7D9DE3, Runas #82DFEA, Petalitas #B76271; Petalitas ficou com o tom mais escuro porque separa melhor de Zinthos para daltonismo — ΔE 16,4 contra 10,8 do rosa claro — e passa de 3:1 no tema claro; Runas tem pouco contraste no tema claro, por isso toda série tem legenda e nome). Emblemas das moedas (originais) aparecem como imagem nos cabeçalhos de texto; os botões só mostram o nome e a cor (o plugin não aceita imagem no modo botão). Expandir um painel é o modo View do Grafana (tecla `v` ou menu do painel): títulos e descrições valem sozinhos e um clique na legenda isola a série. Link direto para uma aba: `?dtab=<aba sem acentos e sem o caractere acentuado>`, ex. `dtab=moeda`, `dtab=mudanas`, `dtab=diagnstico` (o Grafana remove o caractere acentuado do slug); moedas pela URL: `&var-moedas=zinthos&var-moedas=runas`.

**Ravena — Uso de LLM** (`llm.json`, uid `ravena-llm`, link no admin; fonte Prometheus): requisições, falhas (contagem e %), latência p95 da requisição inteira (`llm.request`: fila, tentativas e fallback) e da chamada ao provedor (`chat <modelo>`), chamadas por modelo e por provedor ao longo do tempo, tabela por modelo (chamadas, falhas, p95) e ferramentas chamadas pelo LLM (`execute_tool <nome>`). Tudo das métricas que o `span_metrics` do collector deriva dos spans (`traces_span_metrics_calls_total` e `traces_span_metrics_duration_milliseconds_bucket`, dimensões `span_name`, `status_code`, `gen_ai_request_model`). Provedor depende da dimensão `gen_ai.provider.name` no `otel-collector.yaml` (recriar o `obs-otel-collector` depois de atualizar; antes disso a série aparece como "sem provedor"). Ficam fora (só nos traces, no Jaeger): tokens (`gen_ai.usage.*`; o span_metrics não soma atributos), tempo de fila (`ravena.llm.queue_wait_ms`) e tipo do pedido (imagem, tool calling). Sem OpenTelemetry ligado na ravena (`OTEL_ENABLED`) o dashboard fica vazio.

**Ravena — Jogador** (`jogador.json`, link no topo do painel da economia e em todo nome das tabelas): busca por nome, telefone ou ID e a ficha de um jogador (saldo por dia, fluxo por motivo, extrato diário e comandos). Fica num dashboard à parte para as caixas Buscar e Jogador não aparecerem no topo de todas as abas. A carga pede `GET /internal/economy/players` no waifuletes e no Jardim, um dia econômico por vez (o dia corrente é refeito a cada hora), e lê as Runas do bank.db; guarda `ECONOMY_ANALYTICS_PLAYER_DAYS` dias (padrão 90). Aumentar esse número não busca os dias antigos que faltam: a carga continua do último dia carregado e os dias a mais se enchem com o tempo (para tê-los já, recomeçar do zero). As Runas por jogador são geradas um dia por vez, cedendo o laço de eventos entre os dias; os retratos diários de Runas (`bank_daily_quotas`) saem agregados do SQLite por data. Uma pessoa junta os IDs dela nas três fontes: o número antes do `@`/`:`, celular do Brasil de 12 dígitos vira 13 (como o `PhoneUtils`), e LID do WhatsApp vira telefone pela `memory_identities` do `memory.db` (só leitura); LID sem correspondência aparece como "LID …". Mostra nome e telefone: decisão de produto (moeda de jogo, sem valor financeiro; o Grafana só é acessado por túnel ou com senha).

**Alertas** (`grafana/provisioning/alerting/economia.yaml`, pasta Economia, a cada 10 min): carga atrasada (intervalo da carga + 2 h, 3 h no padrão de hora em hora; só fontes que carregaram nas últimas 48 h; pausada não dispara), motivo sem mapear, moeda sem origem acima de 5% do criado na semana (Zinthos e Runas começam disparando por buracos de extrato conhecidos; some na fase 2) e divórcio de alma gêmea que pagou mais que as cotas. Não há ponto de contato configurado: aparecem em Alerting e no painel "Alertas da economia"; para receber aviso, configurar um contact point no Grafana.
**Mudanças registradas sozinhas.** A cada carga a ravena lê os parâmetros de balanceamento em produção (`GET /internal/economy/params` no waifuletes e no Jardim, mesma autenticação do resumo; Runas: `src/services/economyConstants.js`, o módulo puro de câmbio, cotas e loja que o `BankService` importa e que a carga lê direto no worker) e compara com a leitura anterior (tabela `params_current`). O que mudou vira uma anotação `origin = 'auto'` com valor antigo e novo (`annotations.detail.changes`). Hora: a mudança aconteceu entre a leitura anterior e esta (o teto é o instante em que a leitura voltou; `detail.between`); se o serviço subiu nesse intervalo (`startedAt`, também no detalhe) é a hora exata, senão vai para a hora cheia da leitura e, se o intervalo passa de 2 h (ravena parada, reload sem reiniciar), o rótulo termina em "(hora aproximada)". Mudança de câmbio das Runas (`cambio.*`) é anotada em **todas** as moedas (mexe também em Zinthos e Petalitas). Chave acrescentada vira anotação ("<chave> novo (valor)") quando a `version` do serviço é a mesma da leitura anterior (dado ou catálogo mudou sem deploy de código) ou quando começa com `catalog.` (item novo de catálogo, como planta nova relida a quente no Jardim). Não viram anotação: a primeira leitura (só guarda), chave acrescentada junto com `version` nova ou sem `version` (deploy que passou a expor constantes, nada mudou no jogo: vai para a base, para o log e para `detail.added`) e leitura com `schemaVersion` diferente da anterior (formato mudou: só regrava a base). Serviço sem a rota (404) fica de fora sem erro. Constante nova no `BankService` precisa vir de `economyConstants.js` ou entrar na lista de ignoradas do teste de guarda, com motivo (`test_economy_analytics.js`); números soltos no código e as regras do SlotsGame/FishingGame não aparecem na rota. Uma vez por dia econômico, para cada moeda com extrato, a carga também procura **possíveis mudanças** em cada dia completo desde o último olhado (até 35 dias para trás, depois de uma pausa): motivo novo (nenhuma linha nos 35 dias antes, e só com 35 dias de histórico carregado), motivo que sumiu (presente nos 7 dias antes com pelo menos 3 transações por dia) e valor médio por transação 30% fora do normal num motivo estável (variação abaixo de 10% nos 7 dias antes, pelo menos 20 transações no dia). Dia sem dados (total de transações 0 ou abaixo de 25% da mediana dos 28 dias antes: serviço fora, extrato incompleto) não emite nada. Valor por transação no mesmo dia de uma mudança automática da mesma moeda (ou de todas) já entra como `descartada`, com a referência dela em `detail.ref`. As outras entram como `origin = 'possivel'`, com marca âmbar, e se decidem com `economy-annotate.js --listar [--possiveis]` (mostra um id curto), `--confirmar <id> ["texto novo"]` ou `--descartar <id>` (a forma antiga `<ts> "<texto>"` continua valendo; manual e automática não se decidem). Descartada some da aba e dos gráficos, mas fica no banco. `--import` só acrescenta: anotação que já existe fica com a origem e o detalhe dela. **Voltar a ravena para uma versão anterior:** a partir da marca do banco (`application_id`, PR da carga) a guarda aceita tabelas desconhecidas; só uma versão anterior à marca recusaria o `analytics.db` por causa de `params_current` (carga para com "recusado: … não é do painel", sem apagar nada; desligue `ECONOMY_ANALYTICS_ENABLED` ou mova `data/economia-carga/` e `data/economia/analytics.db` para o lado). Se a carga recomeçar do zero, exporte antes as anotações com `--export`.

**Admin da carga** (`/admin` → **Carga da economia**; a tela antiga `/banco/admin?legado=1` ainda tem o cartão Painel da economia; rotas `src/BotAPI/routes/economyRoutes.js`, mesma autenticação do admin): estado por fonte (dados até, atraso, última tentativa e erro), agendamento (a cada 1, 2, 3, 6, 12 ou 24 h, cron `5 */N * * *`; pausar/retomar; rodar agora), possíveis mudanças com Confirmar/Descartar e o formulário "Registrar mudança" (texto, moeda, hora opcional). Rotas: `GET /api/economy/admin/status`, `POST …/schedule {everyHours}` (ou `{useDefault: true}`, a opção "padrão do .env" do seletor de intervalo, que apaga a escolha do admin), `POST …/pause`, `POST …/resume`, `POST …/run` (202 na hora; rodada em andamento não é duplicada), `GET|POST …/annotations`, `POST …/annotations/decide {id, decision, texto?}`. Os POST exigem `Content-Type: application/json` (415) e recusam `Sec-Fetch-Site: cross-site` e `Origin` de outro host (403); com `ECONOMY_ANALYTICS_ENABLED` diferente de `true` (ou a carga parada) respondem 409. Tudo passa pelo worker da carga. O agendamento fica em `meta` (`schedule.every_hours`, `schedule.paused`, `schedule.updated_at`; a escolha do admin vale mais que `ECONOMY_ANALYTICS_EVERY_HOURS`, que vale mais que 1 h) e o retrato é republicado na hora, então o Grafana pode mostrar "ativa/pausada/a cada N h". O intervalo em vigor (qualquer que seja a origem) vai para `schedule.effective_every_hours` na subida e a cada rodada; é ele que o painel e o alerta de carga atrasada leem (com `schedule.every_hours` e 1 h de reserva). Pausada, a carga não agenda nem roda a rodada da subida; "rodar agora" continua valendo. A retomada continua de onde parou, em pedaços de 30 dias (como a primeira carga); por jogador, um dia por vez; a detecção de possíveis mudanças olha os dias pulados (até 35). "Quem recebe" é calculado uma vez por dia econômico, só para o dia da rodada: com intervalo de 12/24 h ou depois de uma pausa, os dias sem rodada ficam sem essa linha (é um retrato dos 7 dias anteriores com o saldo daquele momento; não dá para refazer depois). `ECONOMY_ANALYTICS_RUN_WITH_DISABLE_ACTIVITY=true` liga a carga mesmo com `DISABLE_ACTIVITY=true` (só demo/teste com bancos próprios).

Estado da carga: `docker exec ravena-ai node scripts/economy-status.js`. Anotação (mudança de regra, correção de extrato; aparece como marca nos gráficos de tempo e vira uma linha na aba Mudanças, com antes e depois, Δ comparado com a variação semanal normal, situação e os motivos que mais mudaram): `docker exec ravena-ai node scripts/economy-annotate.js "Descrição curta" [zinthos|petalitas|runas|todas] [data ISO]`; `--export` / `--import` (stdin) salvam e restauram as anotações. Os scripts rodam da raiz do projeto (`/app` no contêiner): leem o `.env` e resolvem os caminhos a partir dela. Tipos de motivo e mapeamento: `src/services/EconomyAnalyticsMapping.js` (`non_monetary` = linha que não mexe no saldo, fora de todas as somas).

A carga nunca apaga nem altera dado existente: o `bank.db` é aberto só-leitura e ela só escreve no banco de trabalho e no retrato publicado. O banco de trabalho e o diretório publicado são recusados (erro na subida da carga e nos scripts) se estiverem em `data/sqlites`, apontarem para o `bank.db` ou caírem sobre um SQLite que não seja do painel. "Do painel" = tem a marca `PRAGMA application_id = 0x45434F4E` ("ECON", gravada pela carga nos dois arquivos); com a marca, tabela desconhecida é aceita (voltar a ravena para uma versão anterior com o banco de uma mais nova não é recusado). Banco sem marca só é aceito se todas as tabelas forem do painel (criado antes da marca) e passa a ser marcado; outra marca ou tabela alheia = recusado.

Massa histórica de Zinthos: no primeiro retrato alinhado (`totalAtWindowEnd`), a carga anda para trás pelos fluxos já carregados e grava a massa total de cada virada de dia (04:00 BRT) desde o primeiro fluxo, uma vez só (meta `mass_reconstructed:zinthos`), sem sobrescrever retrato real. Faixas, percentis e concentração do passado ficam vazios. Mesma ressalva de `totalAtWindowEnd` (mudança de saldo sem linha no extrato cai antes dela) e os retratos reconstruídos ficam fora da conferência de moeda sem origem, onde dariam zero por construção. Uma recarga de fluxos (`economy-reload`) não refaz essa massa nem o detalhe por jogador (`player_daily`): só os totais por hora. A massa desconta todo motivo `non_monetary` do mapeamento (hoje `HOSTING_FEE_WAIFU`). Runas já tem retratos diários reais (`bank_daily_quotas`); Petalitas não tem extrato.

Antes da primeira publicação (cerca de 1 minuto depois da subida) os painéis mostram erro da fonte ("unable to open database file"), não "No data". Se a ravena rodar fora do Docker, como usuário comum, e o compose do Grafana tiver criado `data/economia` como root, a publicação falha com `EACCES`: crie o diretório antes (`mkdir -p data/economia`, como o usuário do bot); o `economy-status` mostra a data do retrato publicado.

Resumo: confiança (de quando são os dados, atraso, extrato e motivos sem mapear por fonte), veredito por moeda (situação ok / atenção / agir pelo pior entre crescimento semanal — 1% / 3%, contra um retrato de 7 a 9 dias antes, senão "sem dados" — moeda sem origem em % da massa — 0,1% / 0,5% — e em % do criado — 1% / 5% — e motivo sem mapear, que deixa pelo menos em atenção; a coluna "Por quê" diz qual critério pesou; limites provisórios; Zinthos e Runas já começam em "agir" por buracos de extrato conhecidos), de onde vem e para onde vai cada moeda escolhida (aba Moeda: barras por motivo e, na tabela, os 8 motivos de maior líquido por moeda, todo motivo sem mapear e "Outros") e as últimas mudanças registradas. Nomes legíveis dos motivos: tabela `reason_labels`, preenchida de `EconomyAnalyticsMapping.LABELS`; a cada subida a carga regrava o tipo de toda linha do histórico (`flows_hourly` e `player_daily`, na mesma transação) que difere do mapeamento atual (não depende de subir `MAPPING_VERSION`). Para corrigir uma janela de fluxos sem tocar nos saldos (motivo novo, extrato corrigido no serviço): `docker exec ravena-ai node scripts/economy-reload.js --moeda zinthos --de 2026-11-01 --ate 2026-11-15` (até 90 dias; `--saldos-runas` preenche retratos diários de Runas que faltam). Como os retratos de saldo guardados nunca são reescritos, uma correção retroativa recarregada desloca a moeda sem origem para o dia antigo; é esperado. Os pedaços históricos da carga inicial pedem `balances=0` aos serviços; o Jardim (sem extrato) é uma chamada só.

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
| `telegram polling.state` | INTERNAL (raiz) | mudança de estado do long-poll do Telegram, não uma por pedido (`src/services/TelegramPollingBackoff.js`): uma `failing` a cada troca de tipo de falha, uma `recovered` na volta e uma `stopped` quando o token é recusado por cerca de 1 minuto seguido (recusas antes disso e tempo esgotado não geram span). `ravena.telegram.polling.loop` (notifications/bot; `bot` inclui o `getMe` da inicialização), `ravena.telegram.polling.state` (failing/recovered/stopped), `ravena.telegram.polling.failure` (token_rejected, conflict, rate_limited, http_error, network), `ravena.telegram.polling.status` (HTTP), `ravena.telegram.polling.attempts`, `app.outcome` (ok na volta, error nos demais). Sem token nem ID |
| `whatsgo instance.cleanup` | INTERNAL (raiz) | limpeza da instância WhatsApp 15 min depois de desconectar ou de sair da tela de pareamento. `ravena.bot.id`, `ravena.instance.cleanup.action` (postponed: tela aberta ou estado mudou durante a consulta; unavailable: a whatsgoapi não informou o status; absent: a instância não existe mais; synced; reconnected; deleted). unavailable e falha ao apagar tentam de novo em 15 min |
| `economy.analytics.run` / `economy.analytics.load` | INTERNAL (raiz) / INTERNAL | carga horária do painel da economia (`ECONOMY_ANALYTICS_ENABLED=true`), emitidos pelo worker da carga. Por fonte: `economy.source` (zinthos/petalitas/runas), `economy.window.from`/`to` (epoch ms), `economy.live` (janela que chega à hora atual), `economy.rows`, `economy.unknown_reasons`. Sem ID de usuário |
| `command mu-foto` (atributos extras) | INTERNAL | `ravena.waifu.photo.requested`/`used`/`total` e `ravena.waifu.photo.fallback` (foto pedida inválida, caiu na padrão) |
| `command mu-diario` / `command mu-r*` / `command faz-*` (atributos extras) | INTERNAL | check-in diário: `ravena.waifu.daily.source` (api_claimed, api_cooldown, api_error, api_unexpected, cache_claimed, cache_cooldown) e `ravena.waifu.daily.amount`; `ravena.fazenda.daily.source` (api_claimed, api_cooldown, api_error, cache), `ravena.fazenda.daily.coins`/`items`. Quando o cache local (`src/services/DailyCheckinCache.js`) responde sem chamar o microsserviço, o 400 do parceiro não acontece, então o `!mu-diario` já resgatado grava `app.outcome=rejected` + `app.reject.reason=daily_already_claimed` |
| `command d-botname` / `command d-botavatar` / `command d-botavatar-reset` (atributos extras) e `discord avatar.download` / `discord profile.update` | INTERNAL | personalização do bot por servidor do Discord (`src/functions/DiscordCommands.js`). Recusas no span do comando: `app.outcome=rejected` e `app.reject.reason` (not_discord, not_guild, no_permission, missing_name, name_too_long, no_image, image_too_large, download_failed, bot_missing_permission). `discord avatar.download` baixa o anexo (até 8 MB): `ravena.discord.avatar.bytes`, `ravena.discord.avatar.type`. `discord profile.update` envolve o `editMe`: `ravena.discord.profile.field` (nick/avatar) |
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
