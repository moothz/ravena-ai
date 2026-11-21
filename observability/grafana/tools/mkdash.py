#!/usr/bin/env python3
"""Gera os dashboards da economia (economia.json, jogador.json) e as regras de alerta (economia.yaml).

Uso: python3 observability/grafana/tools/mkdash.py <raiz do repo> [diretório de saída]
O diretório de saída (padrão: a raiz) recebe observability/grafana/{dashboards,provisioning/alerting}/.
Ver LEIAME.md nesta pasta."""
import json, sys, os
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import v2

if len(sys.argv) < 2:
    sys.exit("uso: mkdash.py <raiz do repo> [diretório de saída]")
REPO = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else REPO
# Mudanças automáticas (rota /internal/economy/params, detecção de possíveis mudanças, --listar/--confirmar/--descartar):
# o texto e a anotação que dependem delas só entram quando o repo tem o serviço.
AUTO = os.path.exists(os.path.join(REPO, "src/services/EconomyAnalyticsChanges.js"))

DS = {"type": "frser-sqlite-datasource", "uid": "economia-sqlite"}
TO = "$__to"
FROM = "$__from"
WEEK = 604800000
M = "'${moeda}'"
LATE_H = 3  # "dados atrasados" no padrão (carga de hora em hora): every_hours + 2; tabela, descrições e alerta
# Agendamento da carga (meta, gravado pela ravena): a cada N horas e pausa. Sem as chaves: 1 h, ativa.
# schedule.effective_every_hours é o intervalo em vigor (admin > ECONOMY_ANALYTICS_EVERY_HOURS > 1), gravado
# pela carga na subida e a cada rodada; schedule.every_hours, só o escolhido no admin (banco de antes da chave
# efetiva).
SCHED_CTE = """sched AS (
  SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schedule.effective_every_hours'),
    (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schedule.every_hours'), 1) AS ev,
    COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schedule.paused'), 0) AS pz,
    (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schedule.updated_at') AS desde
)"""
PROV = " Limites de cor PROVISÓRIOS, ponto de partida para calibrar."
TIME_NOTE = ("O analytics.db guarda epoch em ms; o frser-sqlite-datasource lê colunas de tempo em segundos, "
             "por isso o / 1000 nos SELECT.")

MS = "${moedas:sqlstring}"
# Botões de moeda (v4): a variável `moedas` (várias, com "All" = todas) dirige as abas Resumo, Moeda, Jogadores e
# Mudanças. Valor absoluto (fluxos, mediana/p90, rankings) = um gráfico por moeda, repetido pela variável: dentro da
# cópia, ${moedas} vale só aquela moeda (o SQL usa sempre IN (...), que serve para uma ou várias). Sobreposição só onde
# a escala é comparável (%, índice com início 100). Nunca eixo duplo.
MT = "${moedas:text}"
REPEAT_H = {"mode": "variable", "value": "moedas", "direction": "h", "maxPerRow": 3}
REPEAT_V = {"mode": "variable", "value": "moedas", "direction": "v"}
# Painéis "(12 semanas)": a janela sai do SQL, ancorada no fim do período ($__to − 12 semanas). O timeFrom "84d"
# continua para o eixo do gráfico mostrar as 12 semanas com período relativo (o padrão); com período absoluto o
# Grafana ignora o timeFrom e o eixo mostra o período escolhido, por isso o MIN com $__from (nada some à esquerda).
# Barras por dia: do início do dia econômico (04:00 BRT) em que $__from cai até o início do dia corrente (que ainda
# está pela metade e fica de fora): só dias inteiros.
DAY0_FROM = f"(({FROM} - 25200000) / 86400000) * 86400000 + 25200000"
DAY0_TO = f"(({TO} - 25200000) / 86400000) * 86400000 + 25200000"
FULL_DAYS_NOTE = " Só dias inteiros: o dia corrente (incompleto) fica de fora."
W12 = f"MIN({FROM}, {TO} - 12 * {WEEK})"
W12_NOTE = " Com período absoluto no seletor, o Grafana mostra o período escolhido em vez das 12 semanas."
# Cor fixa por moeda, a mesma nos dois temas. Petalitas #B76271 (e não o #E08A9A do mock): no validador de paleta
# (dataviz, todos os pares, fundo escuro #181b1f e claro #ffffff) o pior par para daltonismo fica em ΔE 16,4 (deutan),
# contra 10,8 (protan, Petalitas × Zinthos) com #E08A9A, e passa de 3:1 de contraste no tema claro. Zinthos e Runas são
# as cores das moedas (fixas); Runas fica com contraste baixo no tema claro, por isso toda série tem legenda/nome.
CUR_COLOR = {"Zinthos": "#7D9DE3", "Runas": "#82DFEA", "Petalitas": "#B76271"}
AMBER, CRIT, OKC = "#e5a650", "#e0645c", "#6fb98a"
CUR_LABEL = "CASE {c} WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' ELSE 'Runas' END"
def cur_colors():
    return [by_name(n, ("color", {"mode": "fixed", "fixedColor": c})) for n, c in CUR_COLOR.items()]
def coin_named(suffix, *props, color=True):
    """Overrides para colunas "<Moeda>: <suffix>" (nome montado com ${moedas:text} no SQL do painel repetido): a cor
    da moeda (ou nenhuma) e as propriedades extras."""
    out = []
    for n, c in CUR_COLOR.items():
        pr = ([("color", {"mode": "fixed", "fixedColor": c})] if color else []) + list(props)
        if pr:
            out.append(by_name(f"{n}: {suffix}", *pr))
    return out
def thousands(v):
    """Inteiro com ponto de milhar (pt-BR), como texto."""
    return f"replace(printf('%,d', CAST(ROUND({v}) AS INTEGER)), ',', '.')"

CUR = """cur(currency, nome, ordem) AS (VALUES ('zinthos', 'Zinthos', 1), ('petalitas', 'Petalitas', 2), ('runas', 'Runas', 3))"""
KIND_PT = """CASE kind WHEN 'creation' THEN 'Criação' WHEN 'destruction' THEN 'Destruição'
    WHEN 'transfer' THEN 'Transferência' WHEN 'exchange_in' THEN 'Câmbio (entrada)'
    WHEN 'exchange_out' THEN 'Câmbio (saída)' WHEN 'non_monetary' THEN 'Fora do dinheiro'
    ELSE 'Sem mapeamento' END"""
LABEL = "COALESCE((SELECT l.label FROM reason_labels l WHERE l.currency = f.currency AND l.reason = f.reason), f.reason)"
CD = "kind IN ('creation', 'destruction')"
AVAIL = "COALESCE((SELECT available FROM ledger_status s WHERE s.currency = {c}), 1)"

# Moeda sem origem, a partir do primeiro retrato de cada dia econômico (04:00 BRT = 07:00 UTC) até o
# primeiro retrato do próximo dia que tiver retrato: Δ total − Σ(entradas − saídas) das horas entre os dois
# (corte na hora cheia). Dia sem retrato não some (o intervalo fica no último dia com retrato).
# non_monetary fica fora; moeda sem extrato fica de fora. `criado` = creation/destruction no intervalo.
# Retratos reconstruídos pelo extrato (antes de meta mass_reconstructed_before:<moeda>, sem holders) ficam
# fora: neles o Δ massa é o próprio extrato e a conferência daria zero por construção.
ORPHAN_CTE = """snap AS (
  SELECT currency, ts, total, (ts - 25200000) / 86400000 AS d,
         ROW_NUMBER() OVER (PARTITION BY currency, (ts - 25200000) / 86400000 ORDER BY ts) AS rn
  FROM balances b
  WHERE NOT (b.holders IS NULL AND b.ts < COALESCE((SELECT CAST(m.value AS INTEGER) FROM meta m
                                                    WHERE m.key = 'mass_reconstructed_before:' || b.currency), 0))
),
op AS (SELECT currency, d, ts, total FROM snap WHERE rn = 1),
dl AS (
  SELECT currency, d, ts AS ta, total AS t0,
         LEAD(d) OVER (PARTITION BY currency ORDER BY d) AS d_next,
         LEAD(ts) OVER (PARTITION BY currency ORDER BY d) AS tb,
         LEAD(total) OVER (PARTITION BY currency ORDER BY d) AS t1
  FROM op
),
x AS (
  SELECT dl.currency, dl.d, dl.d_next - dl.d AS dias, dl.t1 AS total_fim,
         (dl.t1 - dl.t0) - COALESCE((SELECT SUM(f.amount_in - f.amount_out) FROM flows_hourly f
                               WHERE f.currency = dl.currency AND f.kind <> 'non_monetary'
                                 AND f.hour >= dl.ta - dl.ta % 3600000
                                 AND f.hour <  dl.tb - dl.tb % 3600000), 0) AS so
  FROM dl
  WHERE dl.tb IS NOT NULL
    AND COALESCE((SELECT available FROM ledger_status s WHERE s.currency = dl.currency), 1) = 1
)"""

def so_sql_m(where_cur=None):
    w = where_cur or f"currency IN ({MS})"
    return f"""
WITH {ORPHAN_CTE}
SELECT (d * 86400000 + 25200000) / 1000 AS time,
  ROUND(100.0 * so / NULLIF(ABS(total_fim), 0), 3) AS "% da massa", so AS "Sem origem", dias AS "Dias no intervalo"
FROM x
WHERE {w} AND d * 86400000 + 25200000 >= {FROM} AND d * 86400000 + 25200000 < {TO}
ORDER BY d
"""

pid = [0]
def nid():
    pid[0] += 1
    return pid[0]

def target(sql, time_cols=None, qtype="table"):
    return {"refId": "A", "datasource": DS, "queryType": qtype, "queryText": sql.strip(),
            "rawQueryText": sql.strip(), "timeColumns": time_cols or []}

def steps(*pairs):
    return {"mode": "absolute", "steps": [{"color": c, "value": v} for v, c in pairs]}

def panel(ptype, title, sql, x, y, w, h, desc="", time_cols=None, defaults=None, overrides=None, options=None, extra=None, qtype="table"):
    p = {"id": nid(), "type": ptype, "title": title, "description": desc, "datasource": DS,
         "gridPos": {"x": x, "y": y, "w": w, "h": h}, "targets": [target(sql, time_cols, qtype)],
         "fieldConfig": {"defaults": defaults or {}, "overrides": overrides or []}, "options": options or {}}
    if extra:
        p.update(extra)
    return p

def row(title, y, children=None):
    return {"id": nid(), "type": "row", "title": title, "collapsed": children is not None,
            "gridPos": {"x": 0, "y": y, "w": 24, "h": 1}, "panels": children or []}

def by_name(col, *props):
    return {"matcher": {"id": "byName", "options": col}, "properties": [{"id": k, "value": v} for k, v in props]}

def cell(col, thr, mode="color-background"):
    return by_name(col, ("thresholds", thr), ("custom.cellOptions", {"type": mode}))

SIT_MAP = [{"type": "regex", "options": {"pattern": "^(ok.*)", "result": {"color": "#6fb98a", "text": "● $1", "index": 0}}},
           {"type": "regex", "options": {"pattern": "^(atenção.*)", "result": {"color": "#e5a650", "text": "▲ $1", "index": 1}}},
           {"type": "regex", "options": {"pattern": "^(dados atrasados.*)", "result": {"color": "#e5a650", "text": "▲ $1", "index": 4}}},
           {"type": "regex", "options": {"pattern": "^(agir.*)", "result": {"color": "#e0645c", "text": "■ $1", "index": 2}}},
           {"type": "regex", "options": {"pattern": "^sem .*", "result": {"color": "text", "index": 3}}}]
NEUTRAL_T = ("thresholds", {"mode": "absolute", "steps": [{"color": "text", "value": None}]})
KIND_MAP = [{"type": "value", "options": {"Sem mapeamento": {"color": CRIT, "index": 0},
                                          "Fora do dinheiro": {"color": "text", "index": 1}}}]
TABLE_OPTS = {"cellHeight": "sm", "showHeader": True}
WHEN = "time:DD/MM HH:mm"
def when(*cols):
    return [by_name(c, ("unit", WHEN)) for c in cols]
def num(*cols):
    return [by_name(c, ("unit", "locale")) for c in cols]

state, moeda_p, quem_p, cambio_p, diag_p = [], [], [], [], []

# ============================================================================ Estado (4 painéis)
UNK7 = "(SELECT COUNT(DISTINCT f.reason) FROM flows_hourly f WHERE f.currency = {c} AND f.kind = 'unknown' AND f.hour >= {TO} - {WEEK} AND f.hour < {TO})"
state.append(panel("table", "Confiança: de quando são os dados (agora)", f"""
WITH {CUR}
SELECT cur.nome AS "Fonte",
  (SELECT MAX(window_to) FROM load_runs l WHERE l.source = cur.currency AND l.ok = 1) / 1000 AS "Dados até",
  ROUND((CAST(strftime('%s', 'now') AS INTEGER) * 1000
         - (SELECT MAX(window_to) FROM load_runs l WHERE l.source = cur.currency AND l.ok = 1)) / 3600000.0, 1) AS "Atraso (h)",
  CASE COALESCE((SELECT available FROM ledger_status s WHERE s.currency = cur.currency), -1)
    WHEN 1 THEN 'com extrato' WHEN 0 THEN 'sem extrato' ELSE 'sem dados' END AS "Extrato",
  {UNK7.format(c="cur.currency", TO=TO, WEEK=WEEK)} AS "Motivos sem mapear (7 dias)",
  COALESCE((SELECT CASE WHEN ok = 0 THEN error END FROM load_runs l WHERE l.source = cur.currency ORDER BY ts DESC LIMIT 1), '') AS "Último erro"
FROM cur ORDER BY cur.ordem
""", 0, 1, 24, 6,
    desc="Até que hora cheia cada fonte está carregada. A carga roda no minuto 5, então o atraso normal fica entre ~0,1 e ~1,1 h; "
         f"acima de {LATE_H} h a carga está falhando (ver Último erro, vazio quando a última carga deu certo). "
         "Motivos sem mapear: motivos do extrato que a ravena ainda não sabe classificar (Diagnóstico mostra quais). "
         "Petalitas: o Jardim ainda não tem extrato, só o saldo." + PROV,
    time_cols=["Dados até"], defaults={"noValue": "—"},
    overrides=when("Dados até") + [by_name("Dados até", ("noValue", "nunca")), by_name("Atraso (h)", ("decimals", 1)),
               cell("Atraso (h)", steps((None, OKC), (LATE_H, CRIT)), "color-text"),
               cell("Motivos sem mapear (7 dias)", steps((None, "green"), (1, "red")), "color-text"),
               by_name("Extrato", ("mappings", [{"type": "value", "options": {"sem extrato": {"color": "text"}, "com extrato": {"color": "green"}}}]),
                       ("custom.cellOptions", {"type": "color-text"})),
               by_name("Fonte", ("custom.width", 110)), by_name("Dados até", ("custom.width", 110)), by_name("Atraso (h)", ("custom.width", 90)),
               by_name("Extrato", ("custom.width", 120)), by_name("Motivos sem mapear (7 dias)", ("custom.width", 240))],
    options=TABLE_OPTS))

NOW_MS_SQL = "CAST(strftime('%s', 'now') AS INTEGER) * 1000"
# Situação por moeda (Resumo): veredito da semana + de quando são os dados, numa tabela de 3 linhas.
# "conhecido": a moeda sem origem da semana não passa da maior das 8 semanas anteriores (com pelo menos 4 semanas
# de histórico), em % do criado e em % da massa. Buraco conhecido fica em "atenção · conhecido"; "agir" fica para
# crescimento forte ou sem origem acima da própria base.
state.append(panel("table", "Situação por moeda (últimos 7 dias)", f"""
WITH {CUR}, {ORPHAN_CTE}, {SCHED_CTE},
-- semanas inteiras antes do fim do período: k = 0 é a semana atual, 1 a 8 o histórico (uma passada por tabela)
xw AS (
  SELECT currency, ({TO} - 1 - (d * 86400000 + 25200000)) / {WEEK} AS k, SUM(so) AS so_k FROM x
  WHERE d * 86400000 + 25200000 >= {TO} - 9 * {WEEK} AND d * 86400000 + 25200000 < {TO} GROUP BY 1, 2
),
fw AS (
  SELECT currency, ({TO} - 1 - hour) / {WEEK} AS k, SUM(amount_in) AS cri_k FROM flows_hourly f
  WHERE f.{CD} AND hour >= {TO} - 9 * {WEEK} AND hour < {TO} GROUP BY 1, 2
),
hk AS (
  SELECT xw.currency, xw.k, xw.so_k, fw.cri_k,
    (SELECT total FROM balances z WHERE z.currency = xw.currency AND z.ts <= {TO} - xw.k * {WEEK} ORDER BY z.ts DESC LIMIT 1) AS massa_k
  FROM xw LEFT JOIN fw ON fw.currency = xw.currency AND fw.k = xw.k
  WHERE xw.k BETWEEN 1 AND 8
),
h AS (
  SELECT currency, COUNT(*) AS semanas, MAX(ABS(100.0 * so_k / NULLIF(cri_k, 0))) AS max_sc,
    MAX(ABS(100.0 * so_k / NULLIF(ABS(massa_k), 0))) AS max_sm
  FROM hk WHERE so_k IS NOT NULL GROUP BY currency
),
b AS (
  SELECT cur.currency, cur.nome, cur.ordem,
    (SELECT total FROM balances x WHERE x.currency = cur.currency AND x.ts <= {TO} ORDER BY ts DESC LIMIT 1) AS massa,
    -- base do crescimento: retrato com 7 a 9 dias antes do último; sem ele, sem dados (nada de "dobra em" falso)
    (SELECT total FROM balances x WHERE x.currency = cur.currency
       AND x.ts <= (SELECT MAX(ts) FROM balances y WHERE y.currency = cur.currency AND y.ts <= {TO}) - {WEEK}
       AND x.ts >= (SELECT MAX(ts) FROM balances y WHERE y.currency = cur.currency AND y.ts <= {TO}) - 9 * 86400000
       ORDER BY ts DESC LIMIT 1) AS massa_antes,
    (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = cur.currency AND f.{CD}
       AND f.hour >= {TO} - {WEEK} AND f.hour < {TO}) AS criado,
    (SELECT SUM(so) FROM x WHERE x.currency = cur.currency
       AND x.d * 86400000 + 25200000 >= {TO} - {WEEK} AND x.d * 86400000 + 25200000 < {TO}) AS so7,
    (SELECT {LABEL} FROM flows_hourly f WHERE f.currency = cur.currency AND f.kind = 'creation'
       AND f.hour >= {TO} - {WEEK} AND f.hour < {TO} GROUP BY f.reason ORDER BY SUM(f.amount_in) DESC LIMIT 1) AS maior_fonte,
    {UNK7.format(c="cur.currency", TO=TO, WEEK=WEEK)} AS unk,
    {AVAIL.format(c="cur.currency")} AS avail,
    (SELECT MAX(window_to) FROM load_runs l WHERE l.source = cur.currency AND l.ok = 1) AS carga
  FROM cur
),
c AS (
  SELECT b.*, h.semanas, h.max_sc, h.max_sm, sched.ev, sched.pz, sched.desde,
    (massa - massa_antes) * 1.0 / NULLIF(ABS(massa_antes), 0) AS g,
    100.0 * so7 / NULLIF(ABS(massa), 0) AS so_massa,
    100.0 * so7 / NULLIF(criado, 0) AS so_criado,
    ({NOW_MS_SQL} - carga) / 3600000.0 AS atraso
  FROM b LEFT JOIN h ON h.currency = b.currency, sched
),
n AS (
  SELECT *,
    CASE WHEN g IS NULL THEN NULL WHEN ABS(g) * 100 <= 1 THEN 0 WHEN ABS(g) * 100 <= 3 THEN 1 ELSE 2 END AS lv_g,
    CASE WHEN avail = 0 OR so7 IS NULL OR so_massa IS NULL THEN NULL
      WHEN ABS(so_massa) < 0.1 THEN 0 WHEN ABS(so_massa) < 0.5 THEN 1 ELSE 2 END AS lv_sm,
    CASE WHEN avail = 0 OR so7 IS NULL OR so_criado IS NULL THEN NULL
      WHEN ABS(so_criado) < 1 THEN 0 WHEN ABS(so_criado) < 5 THEN 1 ELSE 2 END AS lv_sc,
    CASE WHEN unk > 0 THEN 1 ELSE 0 END AS lv_u,
    CASE WHEN semanas >= 4 AND (so_criado IS NULL OR ABS(so_criado) <= max_sc)
      AND (so_massa IS NULL OR ABS(so_massa) <= max_sm) THEN 1 ELSE 0 END AS conh,
    CASE WHEN pz = 0 AND (carga IS NULL OR atraso > ev + 2) THEN 1 ELSE 0 END AS late
  FROM c
),
v0 AS (SELECT *, MAX(COALESCE(lv_sm, -1), COALESCE(lv_sc, -1)) AS lv_so_bruto FROM n),
v1 AS (SELECT *, CASE WHEN conh = 1 AND lv_so_bruto >= 1 THEN 1 ELSE lv_so_bruto END AS lv_so FROM v0),
v AS (
  SELECT *,
    CASE WHEN lv_g IS NULL AND lv_sm IS NULL AND lv_sc IS NULL AND lv_u = 0 THEN -1
      ELSE MAX(COALESCE(lv_g, -1), lv_so, lv_u) END AS lv
  FROM v1
)
SELECT nome AS "Moeda",
  CASE WHEN late = 1 THEN 'dados atrasados'
    ELSE CASE lv WHEN 0 THEN 'ok' WHEN 1 THEN 'atenção' WHEN 2 THEN 'agir' ELSE 'sem dados' END
      || CASE WHEN lv = 1 AND lv_so >= 1 AND conh = 1 AND COALESCE(lv_g, -1) < 1 AND lv_u < 1 THEN ' · conhecido' ELSE '' END END
    || CASE WHEN avail = 0 THEN ' · sem extrato' ELSE '' END AS "Situação",
  COALESCE(NULLIF(substr(
    CASE WHEN lv_g >= 1 THEN ' + crescimento' ELSE '' END
    || CASE WHEN lv_so >= 1 THEN ' + sem origem' || CASE WHEN conh = 1 THEN ' (na faixa das 8 semanas)' ELSE '' END ELSE '' END
    || CASE WHEN lv_u >= 1 THEN ' + motivo sem mapear' ELSE '' END
    || CASE WHEN late = 1 THEN ' + carga atrasada' ELSE '' END, 4), ''), '—') AS "Por quê",
  CASE WHEN carga IS NULL THEN 'nunca carregou'
    ELSE strftime('%d/%m %H:%M', carga / 1000, 'unixepoch', '-3 hours') || ' · ' || printf('%.1f h', atraso) END AS "Dados até · atraso",
  CASE WHEN pz = 1 THEN 'pausada' || COALESCE(' desde ' || strftime('%d/%m %H:%M',
         CASE WHEN desde > 100000000000 THEN desde / 1000 ELSE desde END, 'unixepoch', '-3 hours'), '')
    ELSE 'ativa a cada ' || ev || ' h' END AS "Carga",
  ROUND(100.0 * g, 2) AS "Crescimento (%)",
  CASE WHEN g >= 0.005 AND ln(2) / ln(1 + g) <= 104 THEN ROUND(ln(2) / ln(1 + g), 1) END AS "Dobra em (semanas)",
  CASE WHEN lv_so_bruto IS NULL OR lv_so_bruto < 0 THEN NULL
       WHEN COALESCE(lv_sc, -1) >= COALESCE(lv_sm, -1) THEN printf('%.2f%% do criado', so_criado)
       ELSE printf('%.3f%% da massa', so_massa) END AS "Sem origem",
  ROUND(so_criado, 2) AS "Sem origem (% do criado)",
  ROUND(so_massa, 3) AS "Sem origem (% da massa)",
  ROUND(max_sc, 2) AS "Maior sem origem em 8 semanas (% do criado)",
  CASE WHEN avail = 0 THEN 'sem extrato' ELSE maior_fonte END AS "Maior fonte"
FROM v WHERE currency IN ({MS}) ORDER BY ordem
""", 0, 2, 24, 5,
    desc=f"Situação = o pior entre: crescimento da massa na semana (ok até 1%, atenção até 3%, agir acima, nos dois sentidos; comparado com "
         "o retrato de 7 a 9 dias antes, senão 'sem dados'), moeda sem origem na semana em % da massa (0,1% / 0,5%) e em % do criado "
         "(1% / 5%), e motivo sem mapear no extrato (pelo menos atenção). "
         "Sem origem 'conhecido' = não passa do maior valor das 8 semanas anteriores (com pelo menos 4 semanas de histórico): os buracos "
         "de extrato já sabidos (give-all, sobra do confisco, créditos de Runas sem linha) ficam em 'atenção · conhecido', e 'agir' fica "
         "para crescimento forte ou sem origem acima da própria base. "
         f"Dados até = última hora cheia carregada (horário de Brasília) e o atraso até agora; a carga roda no minuto 5, então o normal é "
         f"~0,1 a ~1,1 h. Acima do intervalo da carga + 2 h ({LATE_H} h no padrão, de hora em hora) a situação vira 'dados atrasados' "
         "(mesmo limite do alerta; com a carga pausada, nunca; ver Diagnóstico → Confiança). Carga = agendamento atual (a cada N h ou pausada). "
         "Dobra em = semanas para a massa dobrar no ritmo desta semana (ln 2 / ln(1+g)); só aparece com crescimento de pelo menos 0,5% "
         "por semana e até 104 semanas. Sem origem = Δ massa − Σ(entradas − saídas) do extrato: positivo apareceu sem linha no extrato, "
         "negativo sumiu; mostra o critério pior, os dois valores e a maior fonte ficam em colunas ocultas (Inspecionar → Dados)." + PROV,
    defaults={"noValue": "—"},
    overrides=[
        by_name("Situação", ("mappings", SIT_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 230)),
        by_name("Moeda", ("custom.width", 100)),
        by_name("Dados até · atraso", ("custom.width", 170)), by_name("Carga", ("custom.width", 190)),
        cell("Crescimento (%)", steps((None, CRIT), (-3, AMBER), (-1, OKC), (1, AMBER), (3, CRIT)), "color-text"),
        by_name("Crescimento (%)", ("mappings", [{"type": "special", "options": {"match": "null", "result": {"text": "sem dados", "color": "text", "index": 0}}}]),
                ("custom.width", 130)),
        by_name("Dobra em (semanas)", ("custom.width", 150)), by_name("Sem origem", ("custom.width", 160)),
        by_name("Sem origem (% do criado)", ("custom.hidden", True)), by_name("Sem origem (% da massa)", ("custom.hidden", True)),
        by_name("Maior sem origem em 8 semanas (% do criado)", ("custom.hidden", True)), by_name("Maior fonte", ("custom.hidden", True))],
    options=TABLE_OPTS))

TOPN = 8
# Número com sinal, como texto neutro (destruir moeda não é erro: sem vermelho)
SIGNED = "printf('%+,d', {v})"  # mesma separação de milhar do resto do painel
state.append(panel("table", "De onde vem e para onde vai: tabela por motivo (últimos 7 dias)", f"""
WITH {CUR}, r AS (
  SELECT f.currency, f.reason, f.kind, {LABEL} AS motivo,
    SUM(amount_in) AS ent, SUM(amount_out) AS sai, SUM(amount_in - amount_out) AS liq, SUM(tx_count) AS tx
  FROM flows_hourly f
  WHERE f.currency IN ({MS}) AND f.hour >= {TO} - {WEEK} AND f.hour < {TO}
  GROUP BY f.currency, f.reason, f.kind
),
k AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY currency
    ORDER BY CASE WHEN kind = 'non_monetary' THEN 0 ELSE ABS(liq) END DESC, tx DESC) AS pos FROM r
),
shown AS (SELECT * FROM k WHERE pos <= {TOPN} OR kind = 'unknown'),
rest AS (SELECT * FROM k WHERE NOT (pos <= {TOPN} OR kind = 'unknown'))
SELECT "Moeda", "Motivo", "Tipo", "Entrou", "Saiu", "Líquido", "Transações" FROM (
  SELECT cur.ordem, 0 AS grp, pos, cur.nome AS "Moeda", motivo AS "Motivo", {KIND_PT} AS "Tipo",
    CASE WHEN kind = 'non_monetary' THEN NULL ELSE ent END AS "Entrou",
    CASE WHEN kind = 'non_monetary' THEN NULL ELSE sai END AS "Saiu",
    CASE WHEN kind = 'non_monetary' THEN NULL ELSE {SIGNED.format(v="liq")} END AS "Líquido",
    tx AS "Transações"
  FROM shown JOIN cur ON cur.currency = shown.currency
  UNION ALL
  SELECT cur.ordem, 1, 0, cur.nome, 'Outros (' || COUNT(*) || CASE WHEN COUNT(*) = 1 THEN ' motivo)' ELSE ' motivos)' END, '—',
    SUM(CASE WHEN kind = 'non_monetary' THEN 0 ELSE ent END), SUM(CASE WHEN kind = 'non_monetary' THEN 0 ELSE sai END),
    {SIGNED.format(v="SUM(CASE WHEN kind = 'non_monetary' THEN 0 ELSE liq END)")}, SUM(tx)
  FROM rest JOIN cur ON cur.currency = rest.currency GROUP BY cur.currency
) ORDER BY ordem, grp, pos
""", 0, 0, 24, 11,
    desc=f"Extrato das moedas escolhidas (botões no topo): por moeda, os {TOPN} motivos que mais mexeram no saldo (|líquido|), mais todo "
         "motivo sem mapear, e o resto somado em 'Outros'. Tipo vem do mapeamento da ravena (EconomyAnalyticsMapping.js): 'Sem mapeamento' = "
         "motivo novo que alguém precisa mapear; 'Fora do dinheiro' (ex.: waifu confiscada na taxa de hospedagem) não mexe no saldo e só "
         "mostra a contagem. Inclui transferências entre jogadores. Petalitas: sem extrato.",
    defaults={"noValue": "sem extrato / sem movimento"},
    overrides=num("Entrou", "Saiu", "Transações") + [
        by_name("Moeda", ("custom.width", 100)), by_name("Motivo", ("custom.width", 260)), by_name("Tipo", ("custom.width", 130)),
        by_name("Tipo", NEUTRAL_T, ("mappings", KIND_MAP), ("custom.cellOptions", {"type": "color-text"})),
        by_name("Líquido", ("custom.align", "right"))],
    options=TABLE_OPTS))

# Ficha de cada mudança (scorecard): criado/destruído por dia nos 7 dias antes x depois (até a última hora
# carregada, no máximo 7 dias), faixa de ruído = variação semanal típica do criado nas 8 semanas antes da
# mudança (média de |Δ%| entre semanas seguidas), status pelo tempo decorrido e os 3 motivos que mais mudaram.
# Mudança sem moeda (todas) vira uma linha por moeda escolhida nos botões. origin: NULL/manual, auto (parâmetro mudou), possivel.
# Horizonte do "depois": até onde a moeda foi carregada (load_runs); sem carga registrada, a última hora com fluxo.
# Moeda sem extrato (Petalitas) também avança pelo load_runs.
# Mudanças descartadas (--descartar, só com as automáticas) somem da ficha e dos gráficos
# Fichas de antes/depois só com mudanças decididas: automáticas, manuais (NULL = 'manual') e possíveis confirmadas.
# Possível ainda a decidir fica na tabela própria da aba Mudanças; descartada some de tudo.
ANNO_KEEP = " AND COALESCE(an.origin, 'manual') NOT IN ('possivel', 'descartada')" if AUTO else ""
LAST_H = ("COALESCE((SELECT MAX(window_to) FROM load_runs l WHERE l.source = a.c AND l.ok = 1), "
          "(SELECT MAX(hour) + 3600000 FROM flows_hourly z WHERE z.currency = a.c))")
FICHA_CTE = f"""{CUR}, a AS (
  SELECT ROW_NUMBER() OVER (ORDER BY an.ts DESC, an.label, cur.ordem) AS id, an.ts, an.currency, an.label,
    COALESCE(an.origin, 'manual') AS origin, cur.currency AS c
  FROM annotations an JOIN cur ON cur.currency IN ({MS}) AND (an.currency IS NULL OR an.currency = cur.currency)
  WHERE an.ts <= {TO}{ANNO_KEEP} ORDER BY an.ts DESC, cur.ordem LIMIT {{n}}
),
k(n) AS (VALUES (1), (2), (3), (4), (5), (6), (7), (8), (9)),
wk AS (
  SELECT a.id, k.n, (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = a.c AND f.kind = 'creation'
                     AND f.hour >= a.ts - k.n * {WEEK} AND f.hour < a.ts - (k.n - 1) * {WEEK}) AS v
  FROM a, k
),
noise AS (
  SELECT w1.id, 100.0 * AVG(ABS(w1.v - w2.v) * 1.0 / w2.v) AS ruido, COUNT(*) AS semanas
  FROM wk w1 JOIN wk w2 ON w2.id = w1.id AND w2.n = w1.n + 1
  WHERE w1.v IS NOT NULL AND w2.v > 0 GROUP BY w1.id
),
m AS (
  SELECT a.*,
    MAX(0, MIN({WEEK}, COALESCE({LAST_H}, a.ts) - a.ts)) / 86400000.0 AS dias,
    (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = a.c AND f.kind = 'creation' AND f.hour >= a.ts - {WEEK} AND f.hour < a.ts) / 7.0 AS cri_a,
    (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = a.c AND f.kind = 'creation' AND f.hour >= a.ts AND f.hour < a.ts + {WEEK}) AS cri_d_tot,
    (SELECT SUM(amount_out) FROM flows_hourly f WHERE f.currency = a.c AND f.kind = 'destruction' AND f.hour >= a.ts - {WEEK} AND f.hour < a.ts) / 7.0 AS des_a,
    (SELECT SUM(amount_out) FROM flows_hourly f WHERE f.currency = a.c AND f.kind = 'destruction' AND f.hour >= a.ts AND f.hour < a.ts + {WEEK}) AS des_d_tot,
    (SELECT total FROM balances b WHERE b.currency = a.c AND b.ts <= a.ts - {WEEK} ORDER BY b.ts DESC LIMIT 1) AS massa_ant,
    (SELECT total FROM balances b WHERE b.currency = a.c AND b.ts <= a.ts ORDER BY b.ts DESC LIMIT 1) AS massa_na,
    (SELECT total FROM balances b WHERE b.currency = a.c AND b.ts <= a.ts + {WEEK} ORDER BY b.ts DESC LIMIT 1) AS massa_dep,
    {AVAIL.format(c="a.c")} AS avail,
    -- jogadores/dia = média dos distintos de cada dia (o "depois" só com dias inteiros já carregados)
    (SELECT AVG(n) FROM (SELECT COUNT(DISTINCT player_id) AS n FROM player_daily d
       WHERE d.currency = a.c AND d.day >= a.ts - {WEEK} AND d.day < a.ts GROUP BY d.day)) AS jog_a,
    (SELECT AVG(n) FROM (SELECT COUNT(DISTINCT player_id) AS n FROM player_daily d
       WHERE d.currency = a.c AND d.day >= a.ts AND d.day < a.ts + {WEEK} AND d.day + 86400000 <= COALESCE({LAST_H}, 0)
       GROUP BY d.day)) AS jog_d
  FROM a
),
rm AS (
  SELECT m.id, {LABEL} AS motivo,
    COALESCE(SUM(CASE WHEN f.hour >= m.ts THEN f.amount_in - f.amount_out END) / m.dias, 0)
      - COALESCE(SUM(CASE WHEN f.hour < m.ts THEN f.amount_in - f.amount_out END) / 7.0, 0) AS d
  FROM m JOIN flows_hourly f ON f.currency = m.c AND f.kind <> 'non_monetary' AND f.hour >= m.ts - {WEEK} AND f.hour < m.ts + {WEEK}
  WHERE m.dias >= 1 GROUP BY m.id, f.reason
),
top AS (
  SELECT id, GROUP_CONCAT(motivo || ' ' || CASE WHEN d >= 0 THEN '+' ELSE '−' END || replace(printf('%,d', CAST(ABS(ROUND(d)) AS INTEGER)), ',', '.') || '/dia', ' · ') AS motivos
  FROM (SELECT id, motivo, d, ROW_NUMBER() OVER (PARTITION BY id ORDER BY ABS(d) DESC) AS rn FROM rm WHERE ABS(d) >= 1) WHERE rn <= 3
  GROUP BY id
),
r AS (
  -- sem nenhuma linha depois da mudança: 0 (recurso desligado não some), se a moeda tem extrato
  SELECT m.*, CASE WHEN dias >= 1 THEN COALESCE(cri_d_tot, CASE WHEN avail = 1 THEN 0 END) / dias END AS cri_d,
    CASE WHEN dias >= 1 THEN COALESCE(des_d_tot, CASE WHEN avail = 1 THEN 0 END) / dias END AS des_d,
    noise.ruido, noise.semanas, top.motivos
  FROM m LEFT JOIN noise ON noise.id = m.id LEFT JOIN top ON top.id = m.id
),
rs AS (
  SELECT r.*, 100.0 * (cri_d - cri_a) / NULLIF(cri_a, 0) AS dcri,
    CASE WHEN dias < 1 THEN 'cedo demais (< 1 dia)' WHEN dias < 7 THEN printf('acompanhando (%d de 7 dias)', CAST(dias AS INTEGER))
         ELSE 'fechada' END
      AS situacao
  FROM r
)"""
# Δ só ganha ▲▼ (e cor) com a ficha fechada (7 dias); antes disso, texto neutro "parcial"
DCRI_TXT = """CASE WHEN dcri IS NULL THEN '—'
    WHEN dias < 7 THEN printf('parcial: %+.1f%%', dcri)
    WHEN ruido IS NULL THEN printf('%+.1f%% (sem histórico para o normal)', dcri)
    WHEN ABS(dcri) > ruido THEN CASE WHEN dcri > 0 THEN '▲ ' ELSE '▼ ' END || printf('%+.1f%% (normal ±%.0f%%', dcri, ruido) || NSEM || ')'
    ELSE printf('dentro do normal: %+.1f%% (±%.0f%%', dcri, ruido) || NSEM || ')' END"""
# normal medido com menos de 4 semanas: diz com quantas (pouco histórico, faixa pouco confiável)
DCRI_TXT = DCRI_TXT.replace("NSEM", "CASE WHEN semanas < 4 THEN printf(', %d semana%s', semanas, CASE WHEN semanas = 1 THEN '' ELSE 's' END) ELSE '' END")
ORIGIN_PT = "CASE origin WHEN 'auto' THEN 'automática' WHEN 'possivel' THEN 'possível' WHEN 'confirmada' THEN 'possível, confirmada' ELSE 'manual' END"
ORIGIN_COL = f'{ORIGIN_PT} AS "Origem", ' if AUTO else ""
CUR_NAME = "CASE c WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' ELSE 'Runas' END"
EMPTY_MUD = ("Nenhuma mudança registrada ainda. " + ("As automáticas aparecem sozinhas quando um parâmetro de balanceamento muda; "
             "para registrar à mão: " if AUTO else "Para registrar: ") + "docker exec ravena-ai node scripts/economy-annotate.js \"descrição\" zinthos")
NEUTRAL = ("thresholds", {"mode": "absolute", "steps": [{"color": "text", "value": None}]})
DELTA_MAP = [{"type": "regex", "options": {"pattern": "^[▲▼].*", "result": {"color": AMBER, "index": 0}}},
             {"type": "regex", "options": {"pattern": "^cedo.*|^acompanhando.*", "result": {"color": "text", "index": 1}}},
             ]
MUD_DESC = ("Leitura antes/depois, não causal: um evento, um feriado ou a variação normal também mexem nos números. "
            "Criado e destruído = médias diárias dos motivos de criação/destruição nos 7 dias antes e depois (depois = até a "
            "última hora carregada, no máximo 7 dias). 'Normal' = variação semanal típica do criado nas 8 semanas antes da "
            "mudança; o Δ só ganha cor (▲▼ âmbar) quando passa dela. "
            + ("Origem: automática (um parâmetro de balanceamento mudou "
               "no serviço; a de câmbio vale para todas as moedas), possível confirmada (detectada nos dados e confirmada com "
               "--confirmar) ou manual (scripts/economy-annotate.js). Possível ainda a decidir fica na tabela 'Possíveis mudanças a "
               "decidir' (aba Mudanças); descartada some de tudo. Rótulo terminado em '(hora aproximada)' = a hora exata da mudança "
               "não é conhecida (entre duas leituras). " if AUTO else
               "Registradas à mão com scripts/economy-annotate.js. ")
            + "Só as moedas escolhidas nos botões do topo; mudança sem moeda (todas) aparece uma vez por moeda escolhida.")
state.append(panel("table", "Últimas mudanças (3)", f"""
WITH {FICHA_CTE.replace("{n}", "3")}
SELECT ts / 1000 AS "Quando", label AS "O que mudou", {DCRI_TXT} AS "Criado/dia: Δ", situacao AS "Situação",
  {ORIGIN_COL}{CUR_NAME} || CASE WHEN currency IS NULL THEN ' (todas)' ELSE '' END AS "Moeda"
FROM rs ORDER BY ts DESC
""", 0, 24, 24, 6, desc=MUD_DESC + " A ficha completa fica na aba Mudanças.",
    time_cols=["Quando"], defaults={"noValue": EMPTY_MUD},
    overrides=when("Quando") + [
        by_name("Quando", ("custom.width", 95)), by_name("Origem", ("custom.width", 100)), by_name("Moeda", ("custom.width", 90)),
        by_name("Criado/dia: Δ", NEUTRAL, ("mappings", DELTA_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 260)),
        by_name("Situação", NEUTRAL, ("mappings", DELTA_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 330))],
    options=TABLE_OPTS))

LEGEND_BOTTOM = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi", "sort": "desc"}}
# ============================================================================ Aba Moeda (v4: um gráfico por moeda)
# Entradas e saídas por motivo (barras divergentes: saiu à esquerda, entrou à direita) e o saldo da semana em texto.
# Transferências entre jogadores ficam fora das barras e do saldo (só mudam de mão; a taxa aparece em Câmbio e
# transferências). Âmbar só quando cria bem mais do que destrói: saldo acima de 1% da massa na semana, o mesmo limite
# de "atenção" do crescimento na Situação por moeda.
FLOW_KINDS = "f.kind NOT IN ('non_monetary', 'transfer')"
FLOW_TOP = 10
saldo_semana = panel("stat", f"Saldo da semana — {MT} (últimos 7 dias)", f"""
WITH s AS (
  SELECT SUM(amount_in - amount_out) AS liq, SUM(amount_in) AS ent, SUM(amount_out) AS sai FROM flows_hourly f
  WHERE f.currency IN ({MS}) AND {FLOW_KINDS} AND f.hour >= {TO} - {WEEK} AND f.hour < {TO}
),
m AS (SELECT currency, total FROM balances WHERE currency IN ({MS}) AND ts <= {TO} ORDER BY ts DESC LIMIT 1)
SELECT CASE WHEN s.ent IS NULL THEN NULL ELSE
    CASE WHEN s.liq < 0 THEN '−' ELSE '+' END || {thousands("ABS(s.liq)")} || ' ' || {CUR_LABEL.format(c="m.currency")}
    || CASE WHEN s.liq > 0.01 * ABS(m.total) THEN ', criou bem mais do que destruiu'
            WHEN s.liq > 0 THEN ', criou mais do que destruiu'
            WHEN s.liq < -0.01 * ABS(m.total) THEN ', destruiu bem mais do que criou'
            WHEN s.liq < 0 THEN ', destruiu mais do que criou' ELSE ', equilibrado' END
  END AS "Saldo da semana",
  'entrou ' || {thousands("s.ent")} || ' · saiu ' || {thousands("s.sai")} AS "Entrou e saiu"
FROM s LEFT JOIN m ON 1 = 1
""", 0, 0, 24, 3,
    desc="Entrou − saiu da moeda nos últimos 7 dias, somando criação, destruição e câmbio (transferências entre jogadores ficam de "
         "fora: só mudam de mão). Âmbar ('criou bem mais do que destruiu') quando o saldo passa de 1% da massa, o mesmo limite de "
         "atenção do crescimento na Situação por moeda (aba Resumo). O detalhe por motivo está no gráfico logo abaixo. "
         "Petalitas: sem extrato (fase 2).",
    defaults={"noValue": "sem extrato (Petalitas: fase 2)", "color": {"mode": "fixed", "fixedColor": "text"},
              "mappings": [{"type": "regex", "options": {"pattern": ".*bem mais do que destruiu$", "result": {"color": AMBER, "index": 0}}}]},
    options={"reduceOptions": {"calcs": ["lastNotNull"], "fields": "/^Saldo da semana$/", "values": True}, "colorMode": "value",
             "graphMode": "none", "textMode": "value", "justifyMode": "center", "text": {"valueSize": 22}, "wideLayout": True,
             "showPercentChange": False},
    extra={"repeat": REPEAT_H})
entradas_saidas = panel("barchart", f"De onde vem e para onde vai — {MT} (últimos 7 dias)", f"""
WITH r AS (
  SELECT {LABEL} AS motivo, SUM(amount_in) AS ent, SUM(amount_out) AS sai FROM flows_hourly f
  WHERE f.currency IN ({MS}) AND {FLOW_KINDS} AND f.hour >= {TO} - {WEEK} AND f.hour < {TO}
  GROUP BY f.reason
),
k AS (SELECT *, ROW_NUMBER() OVER (ORDER BY ent + sai DESC) AS pos FROM r WHERE ent + sai > 0)
SELECT "Motivo", "{MT}: saiu", "{MT}: entrou" FROM (
  SELECT pos, motivo AS "Motivo", -sai AS "{MT}: saiu", ent AS "{MT}: entrou" FROM k WHERE pos <= {FLOW_TOP}
  UNION ALL
  SELECT {FLOW_TOP} + 1, 'Outros (' || COUNT(*) || CASE WHEN COUNT(*) = 1 THEN ' motivo)' ELSE ' motivos)' END, -SUM(sai), SUM(ent)
  FROM k WHERE pos > {FLOW_TOP} HAVING COUNT(*) > 0
) ORDER BY pos
""", 0, 3, 24, 11,
    desc=f"Por motivo, o que saiu (à esquerda, negativo) e o que entrou (à direita) nos últimos 7 dias: os {FLOW_TOP} motivos que mais "
         "movimentaram e o resto em 'Outros'. Criação, destruição e câmbio; transferências entre jogadores ficam de fora. Clique na "
         "legenda para isolar entradas ou saídas. A tabela com tipo e transações fica na seção 'Tabela por motivo'. "
         "Petalitas: sem extrato (fase 2).",
    defaults={"unit": "locale", "noValue": "sem extrato (Petalitas: fase 2) / sem movimento",
              "custom": {"fillOpacity": 85, "lineWidth": 0, "gradientMode": "none", "axisCenteredZero": True,
                         "axisPlacement": "auto", "axisSoftMin": 0}},
    overrides=coin_named("entrou") + coin_named("saiu", color=False) + [
        {"matcher": {"id": "byRegexp", "options": ".*: saiu$"}, "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": "#8a94a3"}}]}],
    options={"orientation": "horizontal", "xField": "Motivo", "stacking": "normal", "showValue": "never", "groupWidth": 0.75,
             "barWidth": 0.9, "barRadius": 0.1, "xTickLabelMaxLength": 30, "xTickLabelSpacing": 0, "fullHighlight": False,
             "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
             "tooltip": {"mode": "multi", "sort": "none"}},
    extra={"repeat": REPEAT_H})

criado_dia = panel("timeseries", f"Criado e destruído por dia — {MT} (período selecionado)", f"""
SELECT (((hour - 25200000) / 86400000) * 86400000 + 25200000) / 1000 AS time,
  SUM(amount_in) AS "Criado", -SUM(amount_out) AS "Destruído", SUM(amount_in - amount_out) AS "Líquido"
FROM flows_hourly
WHERE currency IN ({MS}) AND {CD} AND hour >= {DAY0_FROM} AND hour < {DAY0_TO}
GROUP BY 1 ORDER BY 1
""", 0, 0, 24, 8, desc="Só motivos de criação e destruição (câmbio e transferências na seção própria), por dia econômico (04:00 BRT): "
                       "criado acima de zero, destruído abaixo, e o líquido (criado − destruído) em linha. Um gráfico por moeda: "
                       "cada uma na própria escala." + FULL_DAYS_NOTE,
    time_cols=["time"], defaults={"unit": "locale", "noValue": "sem extrato / sem movimento",
                                  "custom": {"drawStyle": "bars", "fillOpacity": 70, "lineWidth": 1}},
    overrides=[by_name("Criado", ("color", {"mode": "fixed", "fixedColor": "#9aa4b2"})),
               by_name("Destruído", ("color", {"mode": "fixed", "fixedColor": "#5f6b7a"})),
               by_name("Líquido", ("color", {"mode": "fixed", "fixedColor": "text"}), ("custom.drawStyle", "line"),
                       ("custom.lineWidth", 2), ("custom.fillOpacity", 0), ("custom.showPoints", "always"), ("custom.pointSize", 4))],
    options={"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi", "sort": "none"}},
    extra={"repeat": REPEAT_H})
fluxo_motivo = panel("timeseries", f"Fluxo por motivo e dia — {MT} (período selecionado)", f"""
SELECT (((hour - 25200000) / 86400000) * 86400000 + 25200000) / 1000 AS time,
  {LABEL} AS "Motivo", SUM(amount_in - amount_out) AS "Líquido"
FROM flows_hourly f
WHERE f.currency IN ({MS}) AND f.kind <> 'non_monetary' AND f.hour >= {DAY0_FROM} AND f.hour < {DAY0_TO}
GROUP BY 1, f.reason ORDER BY 1
""", 0, 0, 24, 9, desc="Líquido (entrou − saiu) por motivo e dia econômico, empilhado. Clique num motivo na legenda para isolá-lo." + FULL_DAYS_NOTE,
    time_cols=["time"], defaults={"unit": "locale", "displayName": "${__field.labels.Motivo}", "custom": {"drawStyle": "bars", "fillOpacity": 60, "stacking": {"mode": "normal"}}, "noValue": "sem extrato"},
    options={"legend": {"displayMode": "table", "placement": "right", "calcs": ["sum"]}}, qtype="time series",
    extra={"repeat": REPEAT_V})
TOP20 = "COALESCE(q1_sum, 0) + COALESCE(q2_sum, 0) + COALESCE(q3_sum, 0) + COALESCE(q4_sum, 0) + COALESCE(q5_sum, 0)"
fatia20 = panel("timeseries", "Fatia da massa com os 20% maiores saldos, por moeda (12 semanas)", f"""
SELECT ts / 1000 AS time, {CUR_LABEL.format(c="currency")} AS "Moeda",
  ROUND(100.0 * q5_sum / NULLIF({TOP20}, 0), 2) AS "20% maiores (% da massa)"
FROM balances
WHERE currency IN ({MS}) AND ts >= {W12} AND ts < {TO} AND q5_sum IS NOT NULL ORDER BY ts
""", 0, 0, 12, 8, desc="Parte da massa nas mãos do quinto de contas com mais saldo (entre quem tem saldo > 0). Em %, a mesma escala "
                       "para toda moeda, por isso as moedas escolhidas ficam sobrepostas. Clique numa moeda na legenda para isolá-la." + W12_NOTE,
    time_cols=["time"], qtype="time series", extra={"timeFrom": "84d"},
    defaults={"unit": "percent", "min": 0, "max": 100, "noValue": "sem retrato", "displayName": "${__field.labels.Moeda}",
              "custom": {"lineWidth": 2, "fillOpacity": 0, "showPoints": "never", "spanNulls": True}},
    overrides=cur_colors(), options=LEGEND_BOTTOM)
quintos = panel("barchart", "Massa em cada quinto de saldo, por moeda (retrato mais recente)", f"""
WITH {CUR},
b AS (
  SELECT currency, q1_sum, q2_sum, q3_sum, q4_sum, q5_sum, ROW_NUMBER() OVER (PARTITION BY currency ORDER BY ts DESC) AS rn
  FROM balances WHERE currency IN ({MS}) AND ts <= {TO} AND q5_sum IS NOT NULL
),
k(q, nome) AS (VALUES (1, '1º (menores)'), (2, '2º'), (3, '3º'), (4, '4º'), (5, '5º (maiores)'))
SELECT k.nome AS "Quinto", cur.nome AS "Moeda",
  ROUND(100.0 * COALESCE(CASE k.q WHEN 1 THEN q1_sum WHEN 2 THEN q2_sum WHEN 3 THEN q3_sum WHEN 4 THEN q4_sum ELSE q5_sum END, 0)
        / NULLIF({TOP20}, 0), 1) AS "% da massa"
FROM b JOIN cur ON cur.currency = b.currency, k
WHERE b.rn = 1 ORDER BY k.q, cur.ordem
""", 12, 0, 12, 8, desc="Contas com saldo > 0 em 5 grupos pelo saldo, do 1º (menores saldos) ao 5º (maiores); cada barra = % da massa "
                        "da moeda naquele grupo. Em %, as moedas ficam lado a lado em cada quinto. Com menos de 5 contas com saldo, "
                        "algum quinto fica vazio.",
    defaults={"unit": "percent", "min": 0, "noValue": "sem retrato", "decimals": 1,
              "custom": {"fillOpacity": 85, "lineWidth": 0, "gradientMode": "none"}},
    overrides=cur_colors(),
    options={"orientation": "vertical", "xField": "Quinto", "stacking": "none", "showValue": "auto", "groupWidth": 0.75,
             "barWidth": 0.9, "barRadius": 0.1, "xTickLabelSpacing": 0, "fullHighlight": False,
             "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True}, "tooltip": {"mode": "multi", "sort": "none"}},
    extra={"transformations": [{"id": "groupingToMatrix", "options": {"columnField": "Moeda", "rowField": "Quinto",
                                                                       "valueField": "% da massa", "emptyValue": "null"}}]})
saldo_tipico = panel("timeseries", f"Mediana e p90 do saldo — {MT}", f"""
SELECT ts / 1000 AS time, p50 AS "{MT}: mediana", p90 AS "{MT}: p90" FROM balances
WHERE currency IN ({MS}) AND ts >= {W12} AND ts < {TO} AND p50 IS NOT NULL ORDER BY ts
""", 0, 0, 24, 7, desc="Entre as contas com saldo > 0. Um gráfico por moeda (valores absolutos, cada moeda na própria grandeza). "
                       "Escala logarítmica: mediana e p90 costumam ficar em grandezas diferentes. Mediana na cor da moeda, p90 tracejado." + W12_NOTE,
    time_cols=["time"], extra={"timeFrom": "84d", "repeat": REPEAT_H},
    defaults={"unit": "locale", "noValue": "sem retrato", "custom": {"scaleDistribution": {"type": "log", "log": 10}, "lineWidth": 2,
                                                                    "fillOpacity": 0, "showPoints": "never", "spanNulls": True}},
    overrides=coin_named("mediana") + [{"matcher": {"id": "byRegexp", "options": ".*: p90$"}, "properties": [
        {"id": "color", "value": {"mode": "fixed", "fixedColor": "#c4cad3"}},
        {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [8, 6]}}]}],
    options=LEGEND_BOTTOM)
conferencia = panel("timeseries", f"Conferência: estoque × fluxos — {MT} (período selecionado)", so_sql_m(), 0, 0, 24, 6,
    desc="Por dia: Δ massa − Σ(entradas − saídas) do extrato, em % da massa. Zero = o estoque fecha com o extrato. Fora de zero = moeda "
         "que apareceu ou sumiu sem linha no extrato (cor a partir de 0,1%). Petalitas: indisponível, depende do extrato do Jardim (fase 2).",
    time_cols=["time"], defaults={"unit": "percent", "decimals": 3, "noValue": "sem extrato / sem retrato",
                                  "custom": {"drawStyle": "bars", "fillOpacity": 70, "thresholdsStyle": {"mode": "dashed"}},
                                  "thresholds": steps((None, CRIT), (-0.5, AMBER), (-0.1, "#9aa4b2"), (0.1, AMBER), (0.5, CRIT)),
                                  "color": {"mode": "thresholds"}},
    overrides=[by_name(c, ("custom.hideFrom", {"viz": True, "legend": True, "tooltip": False}), ("unit", "none")) for c in ("Sem origem", "Dias no intervalo")],
    extra={"repeat": REPEAT_H})

# ============================================================================ Quem recebe (um por moeda)
quem_p.append(panel("table", f"Quem recebe — {MT} (últimos 7 dias)", f"""
SELECT 'Q' || q || CASE q WHEN 1 THEN ' (menores)' WHEN 5 THEN ' (maiores)' ELSE '' END AS "Faixa",
  n AS "Contas", received_sum AS "Recebido", received_median AS "Mediana por conta",
  ROUND(100.0 * received_sum / NULLIF(SUM(received_sum) OVER (), 0), 1) AS "% do recebido"
FROM received_by_quintile
WHERE currency IN ({MS}) AND day = (SELECT MAX(day) FROM received_by_quintile WHERE currency IN ({MS}) AND day <= {TO})
ORDER BY q
""", 0, 0, 24, 7,
    desc="Contas com saldo > 0 em 5 faixas pelo saldo atual; quanto cada faixa recebeu de motivos de criação nos 7 dias antes do último dia "
         "carregado. Um por moeda. Petalitas: sem extrato.",
    defaults={"noValue": "sem extrato / sem dados"},
    overrides=num("Contas", "Recebido", "Mediana por conta") + [by_name("% do recebido", ("unit", "percent"), ("displayName", "% recebido")),
        by_name("Faixa", ("custom.width", 115)), by_name("Contas", ("custom.width", 70)), by_name("Recebido", ("custom.width", 95)),
        by_name("Mediana por conta", ("custom.width", 90)), by_name("Mediana por conta", ("displayName", "Mediana"))],
    options=TABLE_OPTS, extra={"repeat": REPEAT_H}))
quem_p.append(panel("timeseries", f"Fatia recebida por Q5 e Q1 — {MT}", f"""
SELECT day / 1000 AS time,
  ROUND(100.0 * SUM(CASE WHEN q = 5 THEN received_sum END) / NULLIF(SUM(received_sum), 0), 1) AS "Q5 (maiores saldos)",
  ROUND(100.0 * SUM(CASE WHEN q = 1 THEN received_sum END) / NULLIF(SUM(received_sum), 0), 1) AS "Q1 (menores saldos)"
FROM received_by_quintile
WHERE currency IN ({MS}) AND day >= {W12} AND day < {TO}
GROUP BY day ORDER BY day
""", 0, 7, 24, 7, desc="Quanto do recebido de motivos de criação foi para a faixa de maior e de menor saldo, por dia. Um por moeda "
                       "(duas linhas por moeda: sobrepor as três daria seis linhas)." + W12_NOTE,
    time_cols=["time"], defaults={"unit": "percent", "min": 0, "max": 100, "noValue": "sem extrato / sem dados",
                                  "custom": {"lineWidth": 2, "fillOpacity": 0, "showPoints": "never", "spanNulls": True}},
    overrides=[by_name("Q5 (maiores saldos)", ("color", {"mode": "fixed", "fixedColor": "#c4cad3"})),
               by_name("Q1 (menores saldos)", ("color", {"mode": "fixed", "fixedColor": "#8a94a3"}),
                       ("custom.lineStyle", {"fill": "dash", "dash": [8, 6]}))],
    extra={"timeFrom": "84d", "repeat": REPEAT_H}, options=LEGEND_BOTTOM))

# ============================================================================ Câmbio e transferências (recolhido)
WK = f"f.hour >= {TO} - {WEEK} AND f.hour < {TO}"
EX = "f.kind IN ('exchange_in', 'exchange_out')"
cambio_p.append(panel("table", "Câmbio e transferências (últimos 7 dias)", f"""
WITH {CUR}
SELECT cur.nome AS "Moeda",
  (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = cur.currency AND {EX} AND {WK}) AS "Câmbio: entrou",
  (SELECT SUM(amount_out) FROM flows_hourly f WHERE f.currency = cur.currency AND {EX} AND {WK}) AS "Câmbio: saiu",
  (SELECT SUM(amount_in - amount_out) FROM flows_hourly f WHERE f.currency = cur.currency AND {EX} AND {WK}) AS "Câmbio: líquido",
  (SELECT SUM(amount_in) FROM flows_hourly f WHERE f.currency = cur.currency AND f.kind = 'transfer' AND {WK}) AS "Transferido entre jogadores",
  (SELECT SUM(amount_in - amount_out) FROM flows_hourly f WHERE f.currency = cur.currency AND f.kind = 'transfer' AND {WK}) AS "Transferência: líquido (taxa)",
  (SELECT SUM(tx_count) FROM flows_hourly f WHERE f.currency = cur.currency AND f.kind = 'non_monetary' AND {WK}) AS "Linhas fora do dinheiro"
FROM cur WHERE cur.currency IN ({MS}) ORDER BY cur.ordem
""", 0, 2, 24, 5,
    desc="Câmbio no RavenaBank e transferências entre jogadores, fora do criado/destruído. Transferência líquida diferente de zero = taxa "
         "do mercado (ex.: 5% do MARKET_TRADE some). Linhas fora do dinheiro = waifu confiscada na taxa de hospedagem (não mexe no saldo).",
    defaults={"noValue": "—", "unit": "locale"}, options=TABLE_OPTS))

# ============================================================================ Diagnóstico (recolhido)
SO_STEPS = steps((None, "red"), (-0.5, "yellow"), (-0.1, "green"), (0.1, "yellow"), (0.5, "red"))
SO_DESC = ("Por dia econômico (04:00 BRT): Δ massa entre o primeiro retrato do dia e o do próximo dia com retrato − Σ(entradas − saídas) "
           "das horas entre eles (linhas fora do dinheiro não entram), em % da massa. Cor nos dois sentidos: positivo = moeda apareceu sem "
           "linha no extrato, negativo = sumiu (verde até 0,1%, amarelo até 0,5%, vermelho acima). Dia sem retrato não some: o intervalo "
           "fica no último dia com retrato (ver 'Dias no intervalo' na dica). O dia mais recente só aparece quando o seguinte tem retrato." + PROV)
def so_sql(cur):
    return f"""
WITH {ORPHAN_CTE}
SELECT (d * 86400000 + 25200000) / 1000 AS time,
  ROUND(100.0 * so / NULLIF(ABS(total_fim), 0), 3) AS "% da massa", so AS "Sem origem", dias AS "Dias no intervalo"
FROM x
WHERE currency = '{cur}' AND d * 86400000 + 25200000 >= {FROM} AND d * 86400000 + 25200000 < {TO}
ORDER BY d
"""
MULTI_SO = f"""
WITH {ORPHAN_CTE}
SELECT (d * 86400000 + 25200000) / 1000 AS time, {CUR_LABEL.format(c="currency")} AS "Moeda",
  ROUND(100.0 * so / NULLIF(ABS(total_fim), 0), 3) AS "Sem origem (% da massa)"
FROM x
WHERE currency IN ({MS}) AND d * 86400000 + 25200000 >= {FROM} AND d * 86400000 + 25200000 < {TO}
ORDER BY d
"""
diag_p.append(panel("timeseries", "Sem origem por dia, por moeda (período selecionado)", MULTI_SO, 0, 2, 24, 7,
    desc=SO_DESC + " Use o filtro Moedas no topo para pôr e tirar moedas. Petalitas não tem série: o Jardim ainda não tem extrato.",
    time_cols=["time"], qtype="time series",
    defaults={"unit": "percent", "decimals": 3, "noValue": "sem dados", "displayName": "${__field.labels.Moeda}",
              "custom": {"drawStyle": "bars", "fillOpacity": 70, "thresholdsStyle": {"mode": "dashed"}},
              "thresholds": steps((None, CRIT), (-0.5, AMBER), (-0.1, "transparent"), (0.1, AMBER), (0.5, CRIT))},
    overrides=cur_colors(), options={"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi", "sort": "none"}}))
diag_p.append(panel("table", "Motivos sem mapeamento (últimos 7 dias)", f"""
SELECT CASE currency WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' ELSE 'Runas' END AS "Moeda",
  reason AS "Motivo (cru)", SUM(amount_in) AS "Entrou", SUM(amount_out) AS "Saiu", SUM(tx_count) AS "Transações"
FROM flows_hourly f WHERE kind = 'unknown' AND {WK}
GROUP BY currency, reason ORDER BY "Transações" DESC
""", 0, 9, 10, 7, desc="Motivos que caíram em 'Sem mapeamento' (também contados na faixa de confiança e no veredito). Mapear em "
                       "src/services/EconomyAnalyticsMapping.js (com nome em LABELS): na próxima subida da ravena a carga regrava o tipo do "
                       "histórico inteiro.",
    defaults={"noValue": "nenhum"}, overrides=num("Entrou", "Saiu", "Transações") + [
        by_name("Moeda", ("custom.width", 90)), by_name("Motivo (cru)", ("custom.width", 230))], options=TABLE_OPTS))
diag_p.append(panel("table", "Histórico de cargas (últimas 50)", """
SELECT ts / 1000 AS "Quando", source AS "Fonte", CASE ok WHEN 1 THEN 'ok' ELSE 'falhou' END AS "Resultado",
  window_from / 1000 AS "Janela de", window_to / 1000 AS "Janela até", rows AS "Linhas", error AS "Erro"
FROM load_runs ORDER BY ts DESC LIMIT 50
""", 10, 9, 14, 7, desc="Cada pedaço carregado (load_runs). '.received' = quem recebe (1x/dia); '.reload' = recarga manual (economy-reload.js).",
    time_cols=["Quando", "Janela de", "Janela até"],
    overrides=when("Quando", "Janela de", "Janela até") + [
               by_name("Quando", ("custom.width", 95)), by_name("Fonte", ("custom.width", 140)), by_name("Resultado", ("custom.width", 85)),
               by_name("Janela de", ("custom.width", 95)), by_name("Janela até", ("custom.width", 95)), by_name("Linhas", ("custom.width", 70)),by_name("Resultado", ("mappings", [{"type": "value", "options": {"ok": {"color": "green"}, "falhou": {"color": "red"}}}]),
                       ("custom.cellOptions", {"type": "color-text"}))],
    options=TABLE_OPTS))


# ============================================================================ Mudanças (recolhido)
mud_p = []
mud_p.append(panel("table", "Ficha de antes e depois (últimas 20)", f"""
WITH {FICHA_CTE.replace("{n}", "20")}
SELECT ts / 1000 AS "Quando", label AS "O que mudou", {DCRI_TXT} AS "Criado/dia: Δ", situacao AS "Situação",
  COALESCE(motivos, '—') AS "Motivos que mais mudaram",
  {CUR_NAME} || CASE WHEN currency IS NULL THEN ' (todas)' ELSE '' END AS "Moeda", {ORIGIN_COL}
  ROUND(cri_a) AS "Criado/dia antes", ROUND(cri_d) AS "Criado/dia depois",
  ROUND(des_a) AS "Destruído/dia antes", ROUND(des_d) AS "Destruído/dia depois",
  ROUND(100.0 * (massa_dep - massa_na) / NULLIF(ABS(massa_na), 0), 2) AS "Massa: Δ em 7 dias (%)",
  ROUND(100.0 * (massa_na - massa_ant) / NULLIF(ABS(massa_ant), 0), 2) AS "Massa: Δ nos 7 dias antes (%)",
  ROUND(jog_a, 1) AS "Jogadores/dia antes", ROUND(jog_d, 1) AS "Jogadores/dia depois",
  semanas AS "Semanas no normal"
FROM rs ORDER BY ts DESC
""", 0, 2, 24, 11 if AUTO else 17, desc=MUD_DESC + " Motivos que mais mudaram = os 3 com maior diferença de líquido por dia entre antes e depois. "
                       "Massa: Δ nos 7 dias antes = a mesma conta na semana anterior à mudança, como referência. Com menos de 4 "
                       "semanas de histórico o Δ diz com quantas semanas o normal foi medido.",
    time_cols=["Quando"], defaults={"noValue": EMPTY_MUD, "custom": {"wrapText": True}},
    overrides=when("Quando") + num("Criado/dia antes", "Criado/dia depois", "Destruído/dia antes", "Destruído/dia depois") + [
        by_name("Quando", ("custom.width", 95)), by_name("Origem", ("custom.width", 100)), by_name("Moeda", ("custom.width", 90)),
        by_name("O que mudou", ("custom.width", 340)), by_name("Motivos que mais mudaram", ("custom.width", 560)),
        by_name("Criado/dia: Δ", NEUTRAL, ("mappings", DELTA_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 250)),
        by_name("Situação", NEUTRAL, ("mappings", DELTA_MAP), ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 300)),
        by_name("Semanas no normal", ("custom.hidden", True))],
    options=TABLE_OPTS))
if AUTO:
    mud_p.append(panel("table", "Possíveis mudanças a decidir", f"""
SELECT rowid AS "Id", ts / 1000 AS "Quando",
  CASE currency WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' WHEN 'runas' THEN 'Runas' ELSE 'Todas' END AS "Moeda",
  label AS "O que pode ter mudado", printf('--confirmar %d  ·  --descartar %d', rowid, rowid) AS "Decidir com economy-annotate.js"
FROM annotations WHERE origin = 'possivel' AND ts <= {TO} AND (currency IS NULL OR currency IN ({MS}))
ORDER BY ts DESC LIMIT 50
""", 0, 13, 24, 8,
        desc="Detectadas nos dados (motivo novo, motivo que sumiu ou valor médio por transação diferente de um dia para o outro), ainda "
             "sem decisão: não entram nas fichas nem nas Últimas mudanças. Aparecem como marca cinza nos gráficos (Possíveis mudanças). "
             "Decidir: docker exec ravena-ai node scripts/economy-annotate.js --confirmar <Id> [\"texto novo\"] ou --descartar <Id>.",
        time_cols=["Quando"], defaults={"noValue": "nenhuma possível mudança a decidir"},
        overrides=when("Quando") + [by_name("Id", ("custom.width", 70)), by_name("Quando", ("custom.width", 95)),
                                    by_name("Moeda", ("custom.width", 90)), by_name("O que pode ter mudado", ("custom.width", 700))],
        options=TABLE_OPTS))
mud_p.append(panel("text", "Como registrar e ler", "", 0, 21 if AUTO else 19, 24, 4, extra={"targets": [], "datasource": None, "options": {"mode": "markdown", "content": (
    ("**Automáticas**: a cada carga a ravena lê os parâmetros de balanceamento dos serviços (`/internal/economy/params`) e registra o que mudou, "
     "com valor antigo e novo. **Possíveis**: motivo novo, motivo que sumiu ou valor médio por transação diferente de um dia para o outro; "
     "elas ficam na tabela acima até alguém decidir: `docker exec ravena-ai node scripts/economy-annotate.js --confirmar <id> [\"texto novo\"]` "
     "(entra nas fichas) ou `--descartar <id>` (some), com o Id da tabela (ou do `--listar --possiveis`). **Manuais**: " if AUTO else "**Registrar**: ")
    + "`docker exec ravena-ai node scripts/economy-annotate.js \"descrição\" "
    "[zinthos|petalitas|runas|todas] [data ISO]`.\n\n"
    "Leitura antes/depois, não causal. Até 1 dia depois a linha fica \"cedo demais\"; até 7 dias, \"acompanhando\" e os números ainda mudam.")}}))

# ============================================================================ Ciclo da alma gêmea (recolhido)
SM_ON = "(SELECT available FROM features WHERE key = 'ciclo_alma_gemea') = 1"
SM_OFF = "Indisponível — depende de: waifuletes com soulmateCycle no resumo da economia"
# without_quota (divórcios sem cotas): NULL = hora carregada de um waifuletes anterior ao campo (desconhecido, não 0).
# Percentual sobre os divórcios com cotas: divorces − COALESCE(without_quota, 0).
SC = """sc AS (SELECT hour, divorces, paid, quota_cost, above_cost, max_return, without_quota AS wq FROM soulmate_cycle_hourly)"""
STAT_OPTS = {"graphMode": "none", "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}}
alma_p = []
alma_p.append(panel("stat", "Divórcios de alma gêmea que pagaram mais que as cotas (últimos 7 dias)", f"""
WITH {SC}
SELECT COALESCE(SUM(above_cost), 0) AS "Pagou mais que as cotas" FROM sc
WHERE {SM_ON} AND hour >= {TO} - {WEEK} AND hour < {TO}
HAVING {SM_ON}
""", 0, 2, 6, 6,
    desc="Regressão do ciclo cotas → alma gêmea → divórcio (fechado no 148d21d: retorno 0,09×). Conta divórcios de alma gêmea em que "
         "o pagamento foi estritamente maior que o que o jogador gastou em cotas daquele personagem (custo > 0) desde o divórcio "
         "anterior; divórcio sem cotas fica de fora (painel ao lado). Deve ficar em 0; qualquer valor acima é o ciclo voltando a "
         "imprimir moeda (também vira alerta).",
    defaults={"noValue": SM_OFF, "thresholds": steps((None, "green"), (1, "red")), "color": {"mode": "thresholds"}, "unit": "none"},
    options={**STAT_OPTS, "colorMode": "background", "textMode": "value"}))
alma_p.append(panel("stat", "Maior retorno de um divórcio de alma gêmea (últimos 7 dias)", f"""
SELECT MAX(max_return) AS "Maior retorno" FROM soulmate_cycle_hourly
WHERE {SM_ON} AND hour >= {TO} - {WEEK} AND hour < {TO}
HAVING {SM_ON}
""", 6, 2, 6, 6,
    desc="Pagamento do divórcio ÷ custo das cotas, o maior da semana. Abaixo de 1 = o ciclo dá prejuízo (fechado). Vazio = nenhum divórcio "
         "de alma gêmea com custo de cotas na semana.",
    defaults={"noValue": "nenhum divórcio de alma gêmea", "decimals": 2, "unit": "none",
              "thresholds": steps((None, "green"), (0.5, "yellow"), (1, "red")), "color": {"mode": "thresholds"}},
    options={**STAT_OPTS, "colorMode": "value"}))
alma_p.append(panel("stat", "Divórcios de alma gêmea (últimos 7 dias)", f"""
SELECT COALESCE(SUM(divorces), 0) AS "Divórcios" FROM soulmate_cycle_hourly
WHERE {SM_ON} AND hour >= {TO} - {WEEK} AND hour < {TO}
HAVING {SM_ON}
""", 12, 2, 6, 6, defaults={"noValue": SM_OFF, "unit": "locale"}, options={**STAT_OPTS, "colorMode": "none"}))
alma_p.append(panel("stat", "Divórcios de alma gêmea sem cotas (últimos 7 dias)", f"""
WITH {SC}
SELECT CASE WHEN COUNT(wq) = 0 THEN 'desconhecido' ELSE CAST(SUM(wq) AS TEXT) END AS "Sem cotas" FROM sc
WHERE {SM_ON} AND hour >= {TO} - {WEEK} AND hour < {TO}
HAVING {SM_ON}
""", 18, 2, 6, 6, desc="Divórcios de alma gêmea sem nenhuma cota comprada (não entram no 'pagou mais que as cotas' nem nos percentuais). "
                     "'desconhecido' quando as horas da semana vieram de um waifuletes anterior a esse número.",
    defaults={"noValue": SM_OFF, "unit": "locale"}, options={**STAT_OPTS, "colorMode": "none"}))
alma_p.append(panel("table", "Ciclo da alma gêmea por dia (período selecionado)", f"""
WITH {SC}
SELECT (((hour - 25200000) / 86400000) * 86400000 + 25200000) / 1000 AS "Dia",
  SUM(divorces) AS "Divórcios", SUM(wq) AS "Sem cotas", SUM(paid) AS "Pago nos divórcios", SUM(quota_cost) AS "Custo das cotas",
  ROUND(1.0 * SUM(paid) / NULLIF(SUM(quota_cost), 0), 2) AS "Retorno (pago ÷ custo)",
  SUM(above_cost) AS "Pagou mais que as cotas",
  ROUND(100.0 * SUM(above_cost) / NULLIF(SUM(divorces) - COALESCE(SUM(wq), 0), 0), 1) AS "% dos com cotas",
  ROUND(MAX(max_return), 2) AS "Maior retorno"
FROM sc
WHERE {SM_ON} AND hour >= {FROM} AND hour < {TO}
GROUP BY (hour - 25200000) / 86400000 ORDER BY 1 DESC
""", 0, 8, 24, 7, desc="Por dia econômico (04:00 BRT). Retorno abaixo de 1 = o jogador gastou mais em cotas do que recebeu no divórcio. "
                       "Pagou mais que as cotas = pagamento estritamente maior que o custo das cotas (custo > 0); o % é sobre os divórcios "
                       "com cotas (divórcios − sem cotas; sem cotas desconhecido, de waifuletes antigo, conta como 0).",
    time_cols=["Dia"], defaults={"noValue": SM_OFF + " (ou nenhum divórcio de alma gêmea no período)"},
    overrides=[by_name("Dia", ("unit", "time:DD/MM")), by_name("Sem cotas", ("noValue", "desconhecido"))]
              + num("Divórcios", "Sem cotas", "Pago nos divórcios", "Custo das cotas") + [
        by_name("% dos com cotas", ("unit", "percent")),
        cell("Retorno (pago ÷ custo)", steps((None, "green"), (0.5, "yellow"), (1, "red")), "color-text"),
        cell("Pagou mais que as cotas", steps((None, "green"), (1, "red")), "color-text")],
    options=TABLE_OPTS))

# ============================================================================ Atividade (recolhido)
AT_ON = "(SELECT available FROM features WHERE key = 'atividade') = 1"
AT_OFF = "Indisponível — depende de: cmd_usage.db legível pela ravena"
ativ_p = []
ativ_p.append(panel("timeseries", "Pessoas ativas por dia (período selecionado)", f"""
SELECT a.day / 1000 AS time, COUNT(DISTINCT COALESCE(i.person, a.player_id)) AS "Pessoas que usaram comandos"
FROM player_activity_daily a LEFT JOIN identities i ON i.player_id = a.player_id
WHERE {AT_ON} AND a.day >= {DAY0_FROM} AND a.day < {DAY0_TO}
GROUP BY a.day ORDER BY a.day
""", 0, 2, 12, 8,
    desc="Pessoas distintas que usaram algum comando no dia econômico (04:00 BRT), com LID e variantes de telefone unidas. Fonte: "
         "cmd_usage.db (sem comandos automáticos nem interação passiva, como o resumo semanal). Guardado por "
         "ECONOMY_ANALYTICS_PLAYER_DAYS dias (padrão 90)." + FULL_DAYS_NOTE,
    time_cols=["time"], defaults={"noValue": AT_OFF, "unit": "locale", "min": 0, "custom": {"drawStyle": "bars", "fillOpacity": 60}}))
ativ_p.append(panel("timeseries", "Jogadores com movimento por dia, por moeda (período selecionado)", f"""
SELECT d.day / 1000 AS time, CASE d.currency WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' ELSE 'Runas' END AS "Moeda",
  COUNT(DISTINCT d.player_id) AS "Jogadores"
FROM player_daily d
WHERE d.currency IN ({MS}) AND d.day >= {DAY0_FROM} AND d.day < {DAY0_TO}
GROUP BY d.day, d.currency ORDER BY d.day
""", 12, 2, 12, 8,
    desc="Jogadores com pelo menos uma linha no extrato da moeda no dia. Petalitas não aparecem: o Jardim ainda não tem extrato." + FULL_DAYS_NOTE,
    time_cols=["time"], defaults={"noValue": "sem dados", "unit": "locale", "min": 0, "displayName": "${__field.labels.Moeda}"},
    overrides=cur_colors(), options={"legend": {"displayMode": "list", "placement": "bottom"}}, qtype="time series"))
ativ_p.append(panel("timeseries", "Comandos por hora (período selecionado)", f"""
SELECT hour / 1000 AS time, uses AS "Comandos" FROM activity_hourly
WHERE {AT_ON} AND hour >= {FROM} AND hour < {TO} ORDER BY hour
""", 0, 10, 12, 7, time_cols=["time"], defaults={"noValue": AT_OFF, "unit": "locale"}))
ativ_p.append(panel("table", "Comandos mais usados (últimos 7 dias)", f"""
SELECT command AS "Comando", SUM(uses) AS "Usos", MAX(users) AS "Pessoas (maior dia)",
  ROUND(100.0 * SUM(uses) / NULLIF((SELECT SUM(uses) FROM activity_daily_command WHERE day >= {TO} - {WEEK} AND day < {TO}), 0), 1) AS "% dos usos"
FROM activity_daily_command
WHERE {AT_ON} AND day >= {TO} - {WEEK} AND day < {TO}
GROUP BY command ORDER BY "Usos" DESC LIMIT 25
""", 12, 10, 12, 7, desc="Top 25 comandos nos 7 dias, com o maior número de pessoas distintas num dia.",
    defaults={"noValue": AT_OFF}, overrides=num("Usos", "Pessoas (maior dia)") + [
        by_name("% dos usos", ("unit", "percent"), ("custom.cellOptions", {"type": "gauge", "mode": "basic"}), ("max", 100), ("min", 0))],
    options=TABLE_OPTS))

# ============================================================================ Em preparação (recolhido)
prep_p = []
prep_p.append(panel("table", "Disponibilidade dos painéis", """
SELECT title AS "Painel", CASE available WHEN 1 THEN 'ativo' ELSE 'indisponível' END AS "Situação",
  COALESCE(depends_on, '') AS "Depende de", COALESCE(detail, '') AS "Detalhe", ts / 1000 AS "Conferido em"
FROM features ORDER BY available, title
""", 0, 2, 24, 6,
    desc="Painéis que dependem de dado que pode não existir ainda. Indisponível = o painel aparece com o selo 'Indisponível — depende de: …' "
         "em vez de números. A carga regrava esta tabela a cada hora.",
    time_cols=["Conferido em"], defaults={"noValue": "carga ainda não rodou", "custom": {"wrapText": True}},
    overrides=when("Conferido em") + [
        by_name("Situação", ("mappings", [{"type": "value", "options": {"ativo": {"color": "green", "index": 0}, "indisponível": {"color": "text", "index": 1}}}]),
                ("custom.cellOptions", {"type": "color-text"}), ("custom.width", 120)),
        by_name("Painel", ("custom.width", 230)), by_name("Conferido em", ("custom.width", 110))],
    options=TABLE_OPTS))
CAUSA_OFF = ("Indisponível — depende de: fase 2, extrato completo (give-all, sobra do confisco e exclusão de usuário nos Zinthos; "
             "transbordo e Carteira Furada nas Runas)")
prep_p.append(panel("table", "Causa da moeda sem origem (últimos 7 dias)", f"""
SELECT f.currency AS "Moeda", {LABEL} AS "Causa", SUM(f.amount_in - f.amount_out) AS "Valor"
FROM flows_hourly f
WHERE (SELECT available FROM features WHERE key = 'causa_sem_origem') = 1
  AND f.reason LIKE 'UNLEDGERED:%' AND {WK}
GROUP BY f.currency, f.reason ORDER BY ABS(SUM(f.amount_in - f.amount_out)) DESC
""", 0, 8, 12, 7,
    desc="Quanto de cada causa conhecida explica a moeda sem origem. Hoje ela aparece como um número só (Diagnóstico). Na fase 2, cada "
         "caminho sem extrato passa a gravar uma linha própria e este painel se liga sozinho.",
    defaults={"noValue": CAUSA_OFF}, overrides=num("Valor"), options=TABLE_OPTS))

# ============================================================================ Montagem (formato v2, com abas)
HEADER_H = 2  # com 1 linha (30 px) o texto do cabeçalho fica cortado embaixo

def header(text, y=0):
    return panel("text", "", "", 0, y, 24, HEADER_H, extra={"targets": [], "datasource": None, "transparent": True,
                                                    "options": {"mode": "markdown", "content": text}})

def alertlist(title, desc, states, y, h):
    return {"id": nid(), "type": "alertlist", "title": title, "datasource": None, "description": desc,
            "gridPos": {"x": 0, "y": y, "w": 24, "h": h},
            "options": {"viewMode": "list", "groupMode": "default", "groupBy": [], "maxItems": 20, "sortOrder": 1, "dashboardAlerts": False,
                        "alertName": "", "alertInstanceLabelFilter": "{area=\"economia\"}", "folder": None,
                        "stateFilter": {k: k in states for k in ("firing", "pending", "noData", "normal", "error")}}}

ALERT_DESC = ("Regras em observability/grafana/provisioning/alerting/economia.yaml (pasta Economia): carga atrasada (intervalo da carga + 2 h, "
              f"{LATE_H} h no padrão; pausada não conta), motivo sem mapear, "
              "moeda sem origem acima de 5% do criado e ciclo da alma gêmea acima do custo. Sem ponto de contato configurado, ficam só aqui "
              "e em Alerting; para receber aviso, configurar um contact point.")

# Massa das moedas (Resumo), com os botões de moeda e três formas de ver (variável Escala):
# - índice: cada moeda dividida pelo próprio primeiro retrato da janela (início = 100), eixo log: a mesma escala para
#   toda moeda, por isso sobrepostas; a mesma inclinação = o mesmo crescimento %, qualquer que seja o tamanho da moeda
#   (e uma moeda que começa quase do zero não achata as outras);
# - valor: cada moeda na própria grandeza, eixo linear (a menor fica achatada);
# - separado: um gráfico por moeda escolhida (repetido pela variável moedas), eixo próprio e a cor da moeda.
MASSA_B = f"""b AS (
  SELECT currency, ts, total FROM balances WHERE currency IN ({MS}) AND ts >= {W12} AND ts < {TO}
)"""
MASSA_IDX = f"""
WITH {MASSA_B},
f AS (SELECT currency, total AS t0 FROM b x WHERE ts = (SELECT MIN(ts) FROM b y WHERE y.currency = x.currency))
SELECT b.ts / 1000 AS time, {CUR_LABEL.format(c="b.currency")} AS "Moeda",
  ROUND(100.0 * b.total / NULLIF(f.t0, 0), 2) AS "Massa (índice, início = 100)"
FROM b JOIN f ON f.currency = b.currency ORDER BY b.ts
"""
MASSA_VAL = f"""
WITH {MASSA_B}
SELECT b.ts / 1000 AS time, {CUR_LABEL.format(c="b.currency")} AS "Moeda", b.total AS "Massa"
FROM b ORDER BY b.ts
"""
MASSA_DESC = ("Massa total de cada moeda escolhida nos botões do topo. Escala: índice = cada moeda dividida pelo próprio primeiro "
              "retrato da janela (início = 100), todas na mesma escala (eixo logarítmico: a mesma inclinação = o mesmo crescimento %; "
              "110 = cresceu 10%); valor = cada moeda na própria grandeza (a "
              "menor fica achatada); separado = um gráfico por moeda, com eixo próprio. Clique numa moeda na legenda para isolá-la. "
              "Zinthos antes da primeira carga: reconstruída pelo extrato. Petalitas: só desde a primeira carga. Marcas = mudanças." + W12_NOTE)
MASSA_LOOK = {"lineWidth": 2, "fillOpacity": 0, "showPoints": "never", "spanNulls": True}
LEGEND = LEGEND_BOTTOM
massa_idx = panel("timeseries", "Massa em circulação, por moeda — índice, início = 100 (12 semanas)", MASSA_IDX, 0, 0, 24, 6,
    desc=MASSA_DESC, time_cols=["time"], qtype="time series", extra={"timeFrom": "84d"},
    defaults={"unit": "locale", "decimals": 0, "noValue": "carga ainda não rodou", "displayName": "${__field.labels.Moeda}",
              "custom": {**MASSA_LOOK, "thresholdsStyle": {"mode": "dashed"}, "scaleDistribution": {"type": "log", "log": 10}},
              "thresholds": {"mode": "absolute", "steps": [{"color": "transparent", "value": None}, {"color": "#5f6b7a", "value": 100}]}},
    overrides=cur_colors(), options=LEGEND)
massa_val = panel("timeseries", "Massa em circulação, por moeda — valor (12 semanas)", MASSA_VAL, 0, 0, 24, 6,
    desc=MASSA_DESC, time_cols=["time"], qtype="time series", extra={"timeFrom": "84d"},
    defaults={"unit": "locale", "noValue": "carga ainda não rodou", "displayName": "${__field.labels.Moeda}", "custom": MASSA_LOOK},
    overrides=cur_colors(), options=LEGEND)
massa_sep = panel("timeseries", f"Massa — {MT} (12 semanas)", MASSA_VAL, 0, 0, 24, 6,
    desc=MASSA_DESC, time_cols=["time"], qtype="time series",
    extra={"timeFrom": "84d", "repeat": REPEAT_H},
    defaults={"unit": "locale", "noValue": "sem retrato", "displayName": "${__field.labels.Moeda}",
              "custom": {**MASSA_LOOK, "fillOpacity": 8}},
    overrides=cur_colors(), options={"legend": {"showLegend": False, "displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "single"}})

# Emblemas das moedas (originais, os mesmos do mock aprovado): SVG em data: URI, nas imagens do markdown dos cabeçalhos.
# O sanitizador do painel de texto do Grafana deixa <img src="data:image/svg+xml;base64,..."> (não deixa <svg> inline).
import base64
_INK = "#121214"
_EMB_SHAPE = {
    "Zinthos": "M12 21.2C12 21.2 2.6 15.3 2.6 8.9 2.6 5.6 5 3.4 7.8 3.4c1.8 0 3.3 1 4.2 2.4.9-1.4 2.4-2.4 4.2-2.4 2.8 0 5.2 2.2 5.2 5.5 0 6.4-9.4 12.3-9.4 12.3z",
    "Runas": "M12 1.8 22.2 12 12 22.2 1.8 12z",
    "Petalitas": "M12 1.8c5.6 4.4 8.6 9.6 3.6 17.4-1.7 2.6-5.5 2.6-7.2 0C3.4 11.4 6.4 6.2 12 1.8z"}
_EMB_GLYPH = {
    "Zinthos": f'<path d="M8.6 8.6h6.8l-6.8 7.2h6.8" fill="none" stroke="{_INK}" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>',
    "Runas": f'<path d="M10 7.2v9.6M10 7.4h2.8a2.2 2.2 0 0 1 0 4.4H10M12.1 11.8l2.8 5" fill="none" stroke="{_INK}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
    "Petalitas": f'<path d="M12 18.2v-6.4M12 12.4c0-2.8 1.8-4.4 4.2-4.4 0 2.8-1.8 4.4-4.2 4.4zM12 13.6c0-2.3-1.5-3.6-3.5-3.6 0 2.3 1.5 3.6 3.5 3.6z" fill="none" stroke="{_INK}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'}
def emblem(c, s=18):
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" width="{s}" height="{s}">'
           f'<path d="{_EMB_SHAPE[c]}" transform="translate(1.4 1.6)" fill="{_INK}"/>'
           f'<path d="{_EMB_SHAPE[c]}" fill="{CUR_COLOR[c]}" stroke="{_INK}" stroke-width="1.5" stroke-linejoin="round"/>{_EMB_GLYPH[c]}</svg>')
    uri = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
    return f'<img src="{uri}" width="{s}" height="{s}" alt="" style="vertical-align:-4px"/>'
EMBLEMS = " ".join(f"{emblem(c)} {c}" for c in ("Zinthos", "Runas", "Petalitas"))

def stack(text, panels):
    """Cabeçalho (uma linha de texto, mesmo estilo em toda aba) e os painéis logo abaixo dele."""
    base = min(p["gridPos"]["y"] for p in panels)
    for p in panels:
        p["gridPos"]["y"] += HEADER_H - base
    return [header(text)] + panels

# Botões de moeda: painel Business Variable (volkovlabs-variable-panel) em modo botão, ligado à mesma variável
# `moedas` da lista suspensa do topo. Cada botão liga/desliga a moeda; "All" = todas; desligar a última volta para
# All (nunca fica vazio). Cor da moeda no botão ligado (consulta abaixo: valor → número → limite de cor). Sem o plugin
# instalado o painel mostra "plugin não encontrado" e a lista suspensa nativa continua funcionando.
VARPANEL = "volkovlabs-variable-panel"
COINBAR_W = 10
def coinbar():
    return panel(VARPANEL, "", """
SELECT 'All' AS "Moeda", 0 AS "Cor" UNION ALL SELECT 'zinthos', 1 UNION ALL SELECT 'petalitas', 2 UNION ALL SELECT 'runas', 3
""", 24 - COINBAR_W, 0, COINBAR_W, HEADER_H,
        desc="Moedas nos gráficos desta aba: cada botão liga ou desliga uma moeda (All = todas; desligar a última volta para All). "
             "É a mesma variável da lista 'Moedas' no topo, que funciona sem este plugin (Business Variable).",
        defaults={"color": {"mode": "thresholds"},
                  "thresholds": steps((None, "#5f6b7a"), (1, CUR_COLOR["Zinthos"]), (2, CUR_COLOR["Petalitas"]), (3, CUR_COLOR["Runas"]))},
        options={"variable": "moedas", "displayMode": "button", "padding": 0, "showLabel": False, "emptyValue": False,
                 "persistent": False, "showResetButton": False, "name": "Moeda", "status": "Cor",
                 "alertCustomMessage": "Variável 'moedas' não encontrada."},
        extra={"transparent": True})

def coin_stack(text, panels):
    """Cabeçalho das abas com moeda: a pergunta à esquerda e os botões de moeda à direita, no topo."""
    out = stack(text, panels)
    out[0]["gridPos"]["w"] = 24 - COINBAR_W
    return [out[0], coinbar()] + out[1:]

# Resumo (cabe em 1920×1080): situação por moeda → alertas disparados → massa → últimas mudanças
conf, sit, ondevem, ultimas = state
sit["gridPos"].update({"x": 0, "y": 0, "w": 24, "h": 5})
ativos = alertlist("Alertas disparados", ALERT_DESC + " Aqui só os disparados ou pendentes; a lista completa fica no Diagnóstico.",
                   ("firing", "pending", "error"), 5, 4)
ativos["options"]["noValue"] = "nenhum alerta disparado"
ultimas["gridPos"].update({"y": 0, "h": 5})
resumo = [v2.Section(None, coin_stack("**Está tudo bem, e os dados são de agora?** " + EMBLEMS,
                                      [sit, ativos])),
          v2.Section(None, [massa_idx], only=("escala", "indice")),
          v2.Section(None, [massa_val], only=("escala", "valor")),
          v2.Section(None, [massa_sep], only=("escala", "separado")),
          v2.Section(None, [ultimas])]

# Moeda: entradas e saídas por moeda (saldo da semana + barras) → por dia → concentração (sobreposta, em %) →
# saldo típico e quem recebe (um por moeda) → detalhe por motivo e conferência → tabela, câmbio, alma gêmea.
ondevem["gridPos"].update({"x": 0, "y": 0, "w": 24, "h": 11})
fatia20["gridPos"].update({"y": 0}); quintos["gridPos"].update({"y": 0})
tipico = [saldo_tipico] + quem_p
yy = 0
for pnl in tipico:
    pnl["gridPos"].update({"y": yy}); yy += pnl["gridPos"]["h"]
detalhe = [fluxo_motivo, conferencia]
conferencia["gridPos"].update({"y": fluxo_motivo["gridPos"]["h"]})

# Diagnóstico: alertas completos, confiança (de quando são os dados), conferência, mapeamento, cargas,
# disponibilidade e fase 2, glossário
diag_p.insert(0, alertlist("Alertas da economia", ALERT_DESC, ("firing", "pending", "noData", "normal", "error"), 0, 5))
conf["gridPos"].update({"x": 0, "y": 5, "w": 24, "h": 5})
diag_p.insert(1, conf)
for c in diag_p[2:]:
    c["gridPos"]["y"] += 8
glossario = panel("text", "Glossário", "", 0, 0, 24, 7, extra={"targets": [], "datasource": None, "options": {"mode": "markdown", "content": (
    "- **Criado / destruído**: motivos que põem ou tiram moeda da economia (recompensa, prêmio, taxa, compra no sistema). Câmbio e transferência entre jogadores ficam à parte.\n"
    "- **Líquido / saldo da semana**: criado − destruído (ou entrou − saiu, por motivo).\n"
    "- **Massa**: soma dos saldos. **Conferência / sem origem**: Δ massa − Σ(entradas − saídas); fora de zero = moeda que mudou sem linha no extrato.\n"
    "- **Fatia dos 20% maiores**: parte da massa no quinto de contas com mais saldo (entre quem tem saldo > 0). **Quintos**: as contas em 5 grupos pelo saldo.\n"
    "- **Índice (início = 100)**: massa ÷ primeiro retrato da janela × 100; 110 = cresceu 10%.\n"
    "- **Dia econômico**: começa às 04:00 BRT. **Dados até**: última hora cheia carregada de cada fonte.\n"
    "- **Situação (veredito)**: o pior entre crescimento da massa na semana, moeda sem origem e motivo sem mapear. Limites provisórios.")}})

tabs = [
    v2.Tab("Resumo", resumo),
    v2.Tab("Moeda", [v2.Section(None, coin_stack("**Como cada moeda está se comportando?** Um gráfico por moeda; em %, sobrepostas.", [saldo_semana, entradas_saidas])),
                     v2.Section("Criado e destruído por dia", [criado_dia]),
                     v2.Section("Concentração (em %, moedas sobrepostas)", [fatia20, quintos]),
                     v2.Section("Saldo típico e quem recebe", tipico),
                     v2.Section("Detalhe: fluxo por motivo e dia, conferência estoque × fluxos", detalhe, collapse=True),
                     v2.Section("Tabela por motivo (tipo e transações)", [ondevem], collapse=True),
                     v2.Section("Câmbio e transferências", cambio_p, collapse=True),
                     v2.Section("Ciclo da alma gêmea (Zinthos)", alma_p, only=("moedas", "zinthos"))]),
    None,  # Jogadores: preenchido abaixo, junto com a ficha
    v2.Tab("Atividade", [v2.Section(None, [header("**Quanta gente está jogando?** Pessoas distintas e jogadores com movimento em cada moeda.")]
                                          + [dict(p_, gridPos={**p_["gridPos"], "y": p_["gridPos"]["y"]}) for p_ in ativ_p])]),
    None,  # Mudanças: abaixo (cabeçalho com os botões)
    v2.Tab("Diagnóstico", [v2.Section(None, stack("**Dá para confiar nos números?** Alertas, de quando são os dados, conferência estoque × fluxos e cargas.", diag_p)),
                           v2.Section("Em preparação: painéis que dependem da fase 2", prep_p),
                           v2.Section("Glossário", [glossario], collapse=True)]),
]
_mh = coin_stack("**O que mudou depois de cada ajuste?** Uma linha por mudança e moeda.", mud_p)
tabs[4] = v2.Tab("Mudanças", [v2.Section(None, _mh)])

MOEDA_OPTS = [("Zinthos", "zinthos"), ("Petalitas", "petalitas"), ("Runas", "runas")]
ANNO_FROM = f"ts >= {FROM} - 12 * {WEEK} AND ts < {TO}"
ANNO_CUR = "CASE currency WHEN 'zinthos' THEN 'Zinthos' WHEN 'petalitas' THEN 'Petalitas' WHEN 'runas' THEN 'Runas' ELSE 'Todas' END"
anno_sql = (f"SELECT ts / 1000 AS time, {ANNO_CUR} || ': ' || label AS text, "
            f"COALESCE(currency, 'todas') AS tags FROM annotations WHERE "
            + ("COALESCE(origin, 'manual') NOT IN ('possivel', 'descartada') AND " if AUTO else "") + ANNO_FROM)
anno_poss = (f"SELECT ts / 1000 AS time, 'Possível mudança (confirmar): ' || label AS text, COALESCE(currency, 'todas') AS tags "
             f"FROM annotations WHERE origin = 'possivel' AND {ANNO_FROM}")
ECON_VARS = [v2.custom_var("moedas", "Moedas", MOEDA_OPTS, "$__all", multi=True, include_all=True,
                           description="Moedas nos gráficos (Resumo, Moeda, Jogadores, Mudanças e Diagnóstico). Os botões no topo das abas "
                                       "mexem nesta mesma variável."),
             v2.custom_var("escala", "Escala", [("índice (início = 100)", "indice"), ("valor", "valor"),
                                                ("separado (um por moeda)", "separado")], "indice")]
MARK = "#c4cad3"  # marcas de mudança: cinza-claro, para não confundir com o âmbar das linhas de limite
MARK_POSS = "#8a94a3"
ECON_ANNOS = [v2.BUILTIN_ANNOTATION, v2.annotation("Mudanças registradas", DS, anno_sql, MARK),
              ] + ([v2.annotation("Possíveis mudanças", DS, anno_poss, MARK_POSS)] if AUTO else [])
ECON_DESC = ("Painel da economia (Zinthos, Petalitas, Runas). Fonte: analytics.db publicado de hora em hora pela ravena-ai. "
             "Mapeamento motivo → tipo e nomes em src/services/EconomyAnalyticsMapping.js. " + TIME_NOTE)

# ============================================================================ Página Jogadores
# (ids continuam: os painéis do ranking entram no dashboard da economia)
J = "${jogador:sqlstring}"
DAYF = f"d.day >= (({FROM} - 25200000) / 86400000) * 86400000 + 25200000 AND d.day < {TO}"
# Pessoa → telefone, tipos de ID e nome (a carga grava em identities.name o nome dos players da pessoa)
PEOPLE = """pp AS (
  SELECT i.person, MAX(i.phone) AS phone, GROUP_CONCAT(DISTINCT i.id_kind) AS tipos, MAX(i.name) AS nome
  FROM identities i GROUP BY i.person
)"""
SHOWID = ("CASE WHEN pp.phone IS NOT NULL THEN '+' || pp.phone WHEN pp.person LIKE 'tg:%' THEN 'Telegram ' || substr(pp.person, 4) "
          "WHEN pp.person LIKE 'lid:%' THEN 'LID ' || substr(pp.person, 5) ELSE pp.person END")
# Link para a ficha: no dashboard da economia, a moeda do painel repetido (${moedas} = uma moeda dentro da cópia);
# na própria ficha, a variável moeda dela.
def LINK_FOR(moeda_param):
    return [{"title": "Abrir ficha do jogador", "url": "/d/ravena-jogador/ravena-jogador?var-jogador=${__data.fields.Pessoa:percentencode}"
                                                      "&var-nome=${__data.fields.Nome:percentencode}&" + moeda_param + "&${__url_time_range}"}]
LINK = LINK_FOR("var-moeda=${moedas}")
def person_cols(link=None):
    link = link or LINK
    return [by_name(c, ("noValue", "—")) for c in ("Zinthos", "Runas", "Petalitas", "Comandos (7 dias)", "Saldo atual", "Maior fonte",
                                                   "Variação em 7 dias", "% da massa", "Motivo dominante", "% do dia")] + [by_name("Pessoa", ("custom.hidden", True)), by_name("Nome", ("links", link), ("custom.width", 180)),
            by_name("Telefone / ID", ("custom.width", 160)), by_name("Tipo de ID", ("custom.width", 110))]
RANK = f"""WITH {PEOPLE},
agg AS (
  SELECT i.person,
    SUM(CASE WHEN d.kind = 'creation' THEN d.amount_in - d.amount_out ELSE 0 END) AS criado,
    SUM(CASE WHEN d.kind = 'destruction' THEN d.amount_out - d.amount_in ELSE 0 END) AS destruido,
    SUM(CASE WHEN d.kind IN ('exchange_in', 'exchange_out') THEN d.amount_in - d.amount_out ELSE 0 END) AS cambio,
    SUM(CASE WHEN d.kind = 'transfer' THEN d.amount_in - d.amount_out ELSE 0 END) AS transf,
    SUM(CASE WHEN d.kind <> 'non_monetary' THEN d.amount_in - d.amount_out ELSE 0 END) AS liquido
  FROM player_daily d JOIN identities i ON i.player_id = d.player_id
  WHERE d.currency IN ({MS}) AND {DAYF}
  GROUP BY i.person
),
top_reason AS (
  SELECT person, motivo FROM (
    SELECT i.person, COALESCE(l.label, d.reason) AS motivo,
      ROW_NUMBER() OVER (PARTITION BY i.person ORDER BY SUM(d.amount_in) DESC) AS rn
    FROM player_daily d JOIN identities i ON i.player_id = d.player_id
    LEFT JOIN reason_labels l ON l.currency = d.currency AND l.reason = d.reason
    WHERE d.currency IN ({MS}) AND {DAYF} AND d.kind = 'creation'
    GROUP BY i.person, d.reason) WHERE rn = 1
),
bal AS (
  SELECT i.person, SUM(p.balance) AS saldo FROM players p JOIN identities i ON i.player_id = p.player_id
  WHERE p.currency IN ({MS}) GROUP BY i.person
),
massa AS (SELECT SUM(balance) AS m FROM players WHERE currency IN ({MS}) AND balance > 0)
SELECT agg.person AS "Pessoa", COALESCE(pp.nome, '—') AS "Nome", {SHOWID} AS "Telefone / ID",
  agg.criado AS "Criado", agg.destruido AS "Destruído", agg.cambio AS "Câmbio (líquido)", agg.transf AS "Transf. (líquido)",
  agg.liquido AS "Líquido", bal.saldo AS "Saldo atual", ROUND(100.0 * bal.saldo / NULLIF((SELECT m FROM massa), 0), 2) AS "% da massa",
  top_reason.motivo AS "Maior fonte"
FROM agg JOIN pp ON pp.person = agg.person
LEFT JOIN bal ON bal.person = agg.person LEFT JOIN top_reason ON top_reason.person = agg.person"""
RANK_COLS = ["Criado", "Destruído", "Câmbio (líquido)", "Transf. (líquido)", "Líquido", "Saldo atual"]
RANK_DESC = (" Criado = motivos de criação (recompensas, prêmios, divórcio…); câmbio e transferências separados. Uma pessoa junta os IDs "
             "dela nas três fontes (LID resolvido pelo memory.db, telefone de 12 e 13 dígitos). Clique no nome para abrir a ficha. "
             "Petalitas: só saldo (Jardim sem extrato).")
jp = []
jp.append(panel("table", f"Quem mais ganhou — {MT} (período selecionado)", RANK + "\nORDER BY agg.criado DESC LIMIT 25", 0, 1, 24, 10,
    desc="Os 25 que mais receberam de motivos de criação no período." + RANK_DESC,
    defaults={"noValue": "sem dados no período"},
    overrides=person_cols() + num(*RANK_COLS) + [cell("Líquido", steps((None, "red"), (0, "green")), "color-text"),
                                                 by_name("% da massa", ("unit", "percent"))],
    options=TABLE_OPTS))
jp.append(panel("table", f"Quem mais perdeu — {MT} (período selecionado)", RANK + "\nWHERE agg.liquido < 0 ORDER BY agg.liquido ASC LIMIT 25", 0, 11, 24, 8,
    desc="Os 25 com o pior saldo líquido (entrou − saiu, sem as linhas fora do dinheiro) no período." + RANK_DESC,
    defaults={"noValue": "ninguém perdeu no período"},
    overrides=person_cols() + num(*RANK_COLS) + [cell("Líquido", steps((None, "red"), (0, "green")), "color-text"),
                                                 by_name("% da massa", ("unit", "percent"))],
    options=TABLE_OPTS))
ANOM_X = 10
jp.append(panel("table", f"Anomalias (pista, não prova): dias com criação acima de {ANOM_X}× a mediana — {MT} (período selecionado)", f"""
WITH {PEOPLE},
pd AS (
  SELECT d.day, i.person, SUM(d.amount_in - d.amount_out) AS criado
  FROM player_daily d JOIN identities i ON i.player_id = d.player_id
  WHERE d.currency IN ({MS}) AND d.kind = 'creation' AND {DAYF}
  GROUP BY d.day, i.person HAVING SUM(d.amount_in - d.amount_out) > 0
),
ord AS (SELECT day, criado, ROW_NUMBER() OVER (PARTITION BY day ORDER BY criado) AS rn, COUNT(*) OVER (PARTITION BY day) AS n FROM pd),
med AS (SELECT day, AVG(criado) AS mediana, MAX(n) AS n FROM ord WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY day),
dom AS (
  SELECT day, person, motivo, v FROM (
    SELECT d.day, i.person, COALESCE(l.label, d.reason) AS motivo, SUM(d.amount_in - d.amount_out) AS v,
      ROW_NUMBER() OVER (PARTITION BY d.day, i.person ORDER BY SUM(d.amount_in - d.amount_out) DESC) AS rn
    FROM player_daily d JOIN identities i ON i.player_id = d.player_id
    LEFT JOIN reason_labels l ON l.currency = d.currency AND l.reason = d.reason
    WHERE d.currency IN ({MS}) AND d.kind = 'creation' AND {DAYF}
    GROUP BY d.day, i.person, d.reason) WHERE rn = 1
)
SELECT pd.day / 1000 AS "Dia", pd.person AS "Pessoa", COALESCE(pp.nome, '—') AS "Nome", {SHOWID} AS "Telefone / ID",
  pd.criado AS "Criado no dia", ROUND(med.mediana) AS "Mediana do dia", ROUND(pd.criado / med.mediana, 1) AS "Vezes a mediana",
  dom.motivo AS "Motivo dominante", ROUND(100.0 * dom.v / pd.criado, 0) AS "% do dia", med.n AS "Jogadores no dia"
FROM pd JOIN med ON med.day = pd.day JOIN pp ON pp.person = pd.person
LEFT JOIN dom ON dom.day = pd.day AND dom.person = pd.person
WHERE med.n >= 5 AND med.mediana > 0 AND pd.criado >= {ANOM_X} * med.mediana
ORDER BY "Vezes a mediana" DESC LIMIT 30
""", 0, 19, 24, 9,
    desc=f"Pessoa-dia em que alguém recebeu de motivos de criação {ANOM_X}× ou mais a mediana de quem recebeu algo naquele dia (dias com "
         "pelo menos 5 jogadores). Motivo dominante = o motivo que mais pesou no dia da pessoa. Ponto de partida para investigar: prêmio "
         "legítimo de evento também aparece aqui. É pista, não prova.",
    time_cols=["Dia"], defaults={"noValue": "nenhum dia fora da curva"},
    overrides=[by_name("Dia", ("unit", "time:DD/MM"), ("custom.width", 70)), by_name("% do dia", ("unit", "percent"))] + person_cols()
              + num("Criado no dia", "Mediana do dia", "Jogadores no dia")
              + [cell("Vezes a mediana", steps((None, "yellow"), (50, "red")), "color-text")],
    options=TABLE_OPTS))
jp.append(panel("table", f"Maiores saldos — {MT} (agora)", f"""
WITH {PEOPLE},
bal AS (
  SELECT i.person, SUM(p.balance) AS saldo FROM players p JOIN identities i ON i.player_id = p.player_id
  WHERE p.currency IN ({MS}) GROUP BY i.person
),
semana AS (
  SELECT i.person, SUM(b.balance) AS saldo FROM player_balance_daily b JOIN identities i ON i.player_id = b.player_id
  WHERE b.currency IN ({MS}) AND b.day = (SELECT MAX(day) FROM player_balance_daily x WHERE x.currency IN ({MS}) AND x.day <= {TO} - {WEEK})
  GROUP BY i.person
),
massa AS (SELECT SUM(balance) AS m FROM players WHERE currency IN ({MS}) AND balance > 0)
SELECT bal.person AS "Pessoa", COALESCE(pp.nome, '—') AS "Nome", {SHOWID} AS "Telefone / ID",
  bal.saldo AS "Saldo", ROUND(100.0 * bal.saldo / NULLIF((SELECT m FROM massa), 0), 2) AS "% da massa",
  bal.saldo - semana.saldo AS "Variação em 7 dias"
FROM bal JOIN pp ON pp.person = bal.person LEFT JOIN semana ON semana.person = bal.person
ORDER BY bal.saldo DESC LIMIT 25
""", 0, 28, 24, 9,
    desc="Saldo atual por pessoa (somando os IDs dela), fatia da massa e variação desde o saldo de 7 dias atrás (fim do dia econômico).",
    defaults={"noValue": "sem dados"},
    overrides=person_cols() + num("Saldo", "Variação em 7 dias") + [by_name("% da massa", ("unit", "percent")),
               cell("Variação em 7 dias", steps((None, "red"), (0, "green")), "color-text")],
    options=TABLE_OPTS))
jp.append(panel("table", "Encontrar jogador (busca por nome, telefone ou ID)", f"""
WITH {PEOPLE},
bal AS (
  SELECT i.person,
    SUM(CASE WHEN p.currency = 'zinthos' THEN p.balance END) AS z, SUM(CASE WHEN p.currency = 'runas' THEN p.balance END) AS r,
    SUM(CASE WHEN p.currency = 'petalitas' THEN p.balance END) AS pt
  FROM players p JOIN identities i ON i.player_id = p.player_id GROUP BY i.person
),
cmds AS (
  SELECT i.person, SUM(a.uses) AS u FROM player_activity_daily a JOIN identities i ON i.player_id = a.player_id
  WHERE a.day >= {TO} - {WEEK} AND a.day < {TO} GROUP BY i.person
)
SELECT pp.person AS "Pessoa", COALESCE(pp.nome, '—') AS "Nome", {SHOWID} AS "Telefone / ID", pp.tipos AS "Tipo de ID",
  bal.z AS "Zinthos", bal.r AS "Runas", bal.pt AS "Petalitas", cmds.u AS "Comandos (7 dias)"
FROM pp LEFT JOIN bal ON bal.person = pp.person LEFT JOIN cmds ON cmds.person = pp.person
WHERE ${{busca:sqlstring}} = '' OR pp.nome LIKE '%' || ${{busca:sqlstring}} || '%' OR pp.person LIKE '%' || ${{busca:sqlstring}} || '%'
  OR EXISTS (SELECT 1 FROM identities j WHERE j.person = pp.person AND j.player_id LIKE '%' || ${{busca:sqlstring}} || '%')
ORDER BY COALESCE(bal.z, 0) + COALESCE(bal.r, 0) DESC LIMIT 50
""", 0, 37, 24, 9,
    desc="Digite parte do nome, do telefone ou do ID no campo 'Buscar' no topo. Clique no nome para abrir a ficha.",
    defaults={"noValue": "ninguém encontrado"},
    overrides=person_cols(LINK_FOR("${moeda:queryparam}")) + num("Zinthos", "Runas", "Petalitas", "Comandos (7 dias)"), options=TABLE_OPTS))

# Jogador escolhido
PF = f"i.person = {J}"
jog = []
jog.append(panel("table", "Ficha do jogador", f"""
WITH {PEOPLE}, {CUR}
SELECT cur.nome AS "Moeda",
  (SELECT SUM(p.balance) FROM players p JOIN identities i ON i.player_id = p.player_id WHERE {PF} AND p.currency = cur.currency) AS "Saldo atual",
  (SELECT SUM(d.amount_in - d.amount_out) FROM player_daily d JOIN identities i ON i.player_id = d.player_id
     WHERE {PF} AND d.currency = cur.currency AND d.kind = 'creation' AND {DAYF}) AS "Criado no período",
  (SELECT SUM(d.amount_out - d.amount_in) FROM player_daily d JOIN identities i ON i.player_id = d.player_id
     WHERE {PF} AND d.currency = cur.currency AND d.kind = 'destruction' AND {DAYF}) AS "Destruído no período",
  (SELECT SUM(d.amount_in - d.amount_out) FROM player_daily d JOIN identities i ON i.player_id = d.player_id
     WHERE {PF} AND d.currency = cur.currency AND d.kind IN ('exchange_in', 'exchange_out') AND {DAYF}) AS "Câmbio (líquido)",
  (SELECT SUM(d.amount_in - d.amount_out) FROM player_daily d JOIN identities i ON i.player_id = d.player_id
     WHERE {PF} AND d.currency = cur.currency AND d.kind = 'transfer' AND {DAYF}) AS "Transf. (líquido)",
  (SELECT GROUP_CONCAT(i.player_id || ' (' || i.id_kind || ')', ', ') FROM identities i
     WHERE {PF} AND i.player_id IN (SELECT player_id FROM players p WHERE p.currency = cur.currency
                                    UNION SELECT player_id FROM player_daily d WHERE d.currency = cur.currency)) AS "IDs nesta fonte"
FROM cur ORDER BY cur.ordem
""", 0, 1, 24, 6,
    desc="Quem é aparece no título da seção (pessoa) e em 'IDs nesta fonte'. Escolha o jogador clicando num nome das tabelas acima (ou digitando a pessoa no campo 'Jogador': telefone com 13 dígitos, "
         "tg:<id> ou lid:<id>). Período = seletor de tempo.",
    defaults={"noValue": "—", "custom": {"wrapText": True}},
    overrides=num("Saldo atual", "Criado no período", "Destruído no período", "Câmbio (líquido)", "Transf. (líquido)")
              + [by_name("Moeda", ("custom.width", 90)), by_name("IDs nesta fonte", ("custom.width", 260))],
    options=TABLE_OPTS))
jog.append(panel("timeseries", "Saldo por dia — ${moeda} — jogador escolhido", f"""
SELECT b.day / 1000 AS time, SUM(b.balance) AS "Saldo no fim do dia"
FROM player_balance_daily b JOIN identities i ON i.player_id = b.player_id
WHERE {PF} AND b.currency = {M} AND b.day >= (({FROM} - 25200000) / 86400000) * 86400000 + 25200000 AND b.day < {TO}
GROUP BY b.day ORDER BY b.day
""", 0, 7, 12, 8, desc="Saldo no fim de cada dia econômico (o dia corrente = agora). Petalitas: só desde a primeira carga.",
    time_cols=["time"], defaults={"unit": "locale", "noValue": "escolha um jogador"}))
jog.append(panel("timeseries", "Fluxo por motivo e dia — ${moeda} — jogador escolhido", f"""
SELECT d.day / 1000 AS time, COALESCE(l.label, d.reason) AS "Motivo", SUM(d.amount_in - d.amount_out) AS "Líquido"
FROM player_daily d JOIN identities i ON i.player_id = d.player_id
LEFT JOIN reason_labels l ON l.currency = d.currency AND l.reason = d.reason
WHERE {PF} AND d.currency = {M} AND d.kind <> 'non_monetary' AND {DAYF}
GROUP BY d.day, d.reason ORDER BY d.day
""", 12, 7, 12, 8, desc="Líquido (entrou − saiu) por motivo e dia econômico.",
    time_cols=["time"], defaults={"unit": "locale", "displayName": "${__field.labels.Motivo}", "noValue": "escolha um jogador",
                                  "custom": {"drawStyle": "bars", "fillOpacity": 60, "stacking": {"mode": "normal"}}},
    options={"legend": {"displayMode": "table", "placement": "right", "calcs": ["sum"]}}, qtype="time series"))
jog.append(panel("table", "Extrato diário — ${moeda} — jogador escolhido", f"""
SELECT d.day / 1000 AS "Dia", COALESCE(l.label, d.reason) AS "Motivo", {KIND_PT.replace('kind', 'd.kind')} AS "Tipo",
  SUM(d.amount_in) AS "Entrou", SUM(d.amount_out) AS "Saiu", SUM(d.tx_count) AS "Transações"
FROM player_daily d JOIN identities i ON i.player_id = d.player_id
LEFT JOIN reason_labels l ON l.currency = d.currency AND l.reason = d.reason
WHERE {PF} AND d.currency = {M} AND {DAYF}
GROUP BY d.day, d.reason ORDER BY d.day DESC, SUM(d.amount_in) + SUM(d.amount_out) DESC
""", 0, 15, 16, 10, time_cols=["Dia"], defaults={"noValue": "escolha um jogador"},
    overrides=[by_name("Dia", ("unit", "time:DD/MM"), ("custom.width", 70)), by_name("Tipo", NEUTRAL_T, ("mappings", KIND_MAP), ("custom.cellOptions", {"type": "color-text"}))]
              + num("Entrou", "Saiu", "Transações"),
    options=TABLE_OPTS))
jog.append(panel("timeseries", "Comandos por dia — jogador escolhido", f"""
SELECT a.day / 1000 AS time, SUM(a.uses) AS "Comandos"
FROM player_activity_daily a JOIN identities i ON i.player_id = a.player_id
WHERE {PF} AND a.day >= (({FROM} - 25200000) / 86400000) * 86400000 + 25200000 AND a.day < {TO}
GROUP BY a.day ORDER BY a.day
""", 16, 15, 8, 10, time_cols=["time"], defaults={"unit": "locale", "noValue": "escolha um jogador",
                                                    "custom": {"drawStyle": "bars", "fillOpacity": 60}}))

busca = jp.pop()  # "Encontrar jogador" vai para a ficha
# Maiores saldos lado a lado (um por moeda, no topo, como no mock); depois uma seção por moeda (repetida pela variável)
# com anomalias (o que pede ação), quem mais ganhou e quem mais perdeu, em largura total (tabelas largas).
ganhou, perdeu, anomalias, maiores = jp
maiores["gridPos"].update({"x": 0, "y": 0, "w": 24, "h": 9})
maiores["repeat"] = REPEAT_H
maiores["fieldConfig"]["overrides"] += [by_name("Telefone / ID", ("custom.hidden", True)), by_name("Nome", ("custom.width", 130)),
                                       by_name("Saldo", ("custom.width", 90)), by_name("% da massa", ("custom.width", 85)),
                                       by_name("Variação em 7 dias", ("displayName", "Variação 7 d"))]
maiores["description"] += " Um por moeda; o telefone/ID fica na ficha (clique no nome)."
yy = 0
for pnl in (anomalias, ganhou, perdeu):
    pnl["gridPos"]["y"] = yy
    yy += pnl["gridPos"]["h"]
tabs[2] = v2.Tab("Jogadores", [v2.Section(None, coin_stack("**Quem se destaca e o que é anômalo?** Clique num nome para abrir a ficha.",
                                                           [maiores])),
                               v2.Section(f"{MT}: anomalias, quem mais ganhou e quem mais perdeu", [anomalias, ganhou, perdeu], repeat="moedas")])


def write(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


dash = v2.dashboard("ravena-economia", "Ravena — Economia", tabs=tabs, description=ECON_DESC, tags=["ravena", "economia"],
                    variables=ECON_VARS, annotations=ECON_ANNOS,
                    links=[v2.link("Jogador", "/d/ravena-jogador/ravena-jogador", "Ficha de um jogador")])
out = os.path.join(OUT, "observability/grafana/dashboards/economia.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
write(out, dash)
print(out, len(dash["spec"]["elements"]), "painéis em", len(tabs), "abas")

# Ficha do jogador (dashboard à parte: as variáveis de busca e jogador só aparecem aqui)
busca["gridPos"].update({"y": 0, "h": 8})
busca["description"] = "Digite parte do nome, do telefone ou do ID no campo 'Buscar' no topo e clique no nome para abrir a ficha."
jog[0]["description"] = ("Escolha o jogador clicando num nome (aqui ou nas tabelas da aba Jogadores) ou digitando a pessoa no campo 'Jogador': "
                         "telefone com 13 dígitos, tg:<id> ou lid:<id>. Período = seletor de tempo.")
jog[1]["fieldConfig"]["defaults"].setdefault("custom", {})["lineInterpolation"] = "stepAfter"
# Sem jogador escolhido, a ficha (que só teria "escolha um jogador") some e fica a instrução
escolha = panel("text", "", "", 0, 0, 24, 2, extra={"targets": [], "datasource": None, "transparent": True, "options": {
    "mode": "markdown", "content": "**Nenhum jogador escolhido.** Clique num nome na tabela acima (ou nas tabelas da aba Jogadores do painel "
                                   "da economia), ou digite a pessoa no campo Jogador: telefone com 13 dígitos, `tg:<id>` ou `lid:<id>`."}})
jdash = v2.dashboard("ravena-jogador", "Ravena — Jogador", tabs=[v2.Tab("Jogador", [
        v2.Section("Encontrar jogador", [busca]),
        v2.Section(None, [escolha], only=("jogador", "")),
        v2.Section("Jogador escolhido: ${nome} · ${jogador}", jog, only=("jogador", "", "notEquals"))])],
    description="Ficha de um jogador da economia: saldo, extrato diário e comandos. Mesma fonte do painel da economia (analytics.db). "
                "Mostra nome e telefone (decisão de produto: moeda de jogo; Grafana só por túnel ou com senha). " + TIME_NOTE,
    tags=["ravena", "economia"],
    variables=[v2.custom_var("moeda", "Moeda", MOEDA_OPTS, "zinthos"), v2.text_var("busca", "Buscar"), v2.text_var("jogador", "Jogador"),
               v2.text_var("nome", "Nome", hide="hideVariable")],
    annotations=[v2.BUILTIN_ANNOTATION, v2.annotation("Mudanças registradas", DS, anno_sql, MARK)],
    links=[v2.link("Economia", "/d/ravena-economia/ravena-economia", "Painel da economia")])
jout = os.path.join(OUT, "observability/grafana/dashboards/jogador.json")
write(jout, jdash)
old = os.path.join(OUT, "observability/grafana/dashboards/jogadores.json")
if os.path.exists(old):
    os.remove(old)
print(jout, len(jdash["spec"]["elements"]), "painéis")

# ============================================================================ Alertas (provisionados)
NOW_MS = "CAST(strftime('%s', 'now') AS INTEGER) * 1000"
def rule(uid, title, sql, op, thr, summary, nodata="NoData"):
    return {
        "uid": uid, "title": title, "condition": "C", "for": "0m", "noDataState": nodata, "execErrState": "Error",
        "labels": {"area": "economia"}, "annotations": {"summary": summary},
        "data": [
            {"refId": "A", "relativeTimeRange": {"from": 600, "to": 0}, "datasourceUid": "economia-sqlite",
             "model": {"refId": "A", "queryType": "table", "queryText": sql.strip(), "rawQueryText": sql.strip(), "timeColumns": []}},
            {"refId": "B", "datasourceUid": "__expr__", "model": {"refId": "B", "type": "reduce", "expression": "A", "reducer": "last",
                                                                   "settings": {"mode": "dropNN"}}},
            {"refId": "C", "datasourceUid": "__expr__", "model": {"refId": "C", "type": "threshold", "expression": "B",
                                                                   "conditions": [{"evaluator": {"type": op, "params": [thr]}}]}},
        ],
    }
rules = [
    # Só fontes que carregaram nas últimas 48 h (fonte desligada não dispara para sempre); limite = intervalo da carga
    # + 2 h (3 h no padrão); com a carga pausada, 0. Sem nenhuma fonte nas 48 h: sem dados → dispara (noDataState).
    rule("economia-carga-atrasada", "Economia: carga atrasada", f"""
WITH {SCHED_CTE},
s AS (
  SELECT source, MAX(window_to) AS t FROM load_runs
  WHERE ok = 1 AND source IN ('zinthos', 'petalitas', 'runas') GROUP BY source HAVING MAX(window_to) >= {NOW_MS} - 48 * 3600000
)
SELECT CASE WHEN sched.pz = 1 THEN 0 ELSE ROUND(({NOW_MS} - MIN(s.t)) / 3600000.0 - (sched.ev + 2), 2) END AS atraso_alem_do_limite_h
FROM sched LEFT JOIN s ON 1 = 1
""", "gt", 0, f"Alguma fonte do painel da economia (das que carregaram nas últimas 48 h) não carrega há mais que o intervalo da "
              f"carga + 2 h ({LATE_H} h no padrão). Pausada não dispara. Ver Diagnóstico → Confiança / Histórico de cargas.", nodata="Alerting"),
    rule("economia-motivo-sem-mapear", "Economia: motivo sem mapear", f"""
SELECT COUNT(DISTINCT currency || ':' || reason) AS motivos FROM flows_hourly
WHERE kind = 'unknown' AND hour >= {NOW_MS} - {WEEK}
""", "gt", 0, "Motivo novo no extrato sem mapeamento (Diagnóstico → Motivos sem mapeamento). Mapear em EconomyAnalyticsMapping.js."),
    rule("economia-sem-origem", "Economia: moeda sem origem acima de 5% do criado", f"""
WITH {ORPHAN_CTE},
w AS (SELECT currency, SUM(so) AS so7 FROM x WHERE x.d * 86400000 + 25200000 >= {NOW_MS} - {WEEK} GROUP BY currency),
c AS (SELECT currency, SUM(amount_in) AS criado FROM flows_hourly WHERE kind = 'creation' AND hour >= {NOW_MS} - {WEEK} GROUP BY currency)
SELECT w.currency AS moeda, ROUND(ABS(100.0 * w.so7 / c.criado), 2) AS pct FROM w JOIN c ON c.currency = w.currency WHERE c.criado > 0
""", "gt", 5, "Moeda sem origem (sem linha no extrato) passou de 5% do criado na semana. Zinthos e Runas começam acima disso por "
              "buracos conhecidos (fase 2)."),
    rule("economia-ciclo-alma-gemea", "Economia: divórcio de alma gêmea pagou mais que as cotas", f"""
SELECT COALESCE(SUM(above_cost), 0) AS acima FROM soulmate_cycle_hourly WHERE hour >= {NOW_MS} - {WEEK}
""", "gt", 0, "Divórcio de alma gêmea pagou estritamente mais que as cotas compradas (custo > 0): o ciclo cotas → alma gêmea → "
              "divórcio voltou a dar lucro (seção Ciclo da alma gêmea)."),
]
alert_yaml = {"apiVersion": 1, "groups": [{"orgId": 1, "name": "economia", "folder": "Economia", "interval": "10m", "rules": rules}]}
aout = os.path.join(OUT, "observability/grafana/provisioning/alerting/economia.yaml")
os.makedirs(os.path.dirname(aout), exist_ok=True)
with open(aout, "w") as f:
    f.write("# Gerado junto com os dashboards da economia. Regras do painel da economia (pasta Economia), sem ponto de contato:\n"
            "# aparecem em Alerting e no painel 'Alertas da economia'. Para receber aviso, configurar um contact point no Grafana.\n")
    json.dump(alert_yaml, f, ensure_ascii=False, indent=1)  # JSON é YAML válido
    f.write("\n")
print(aout, len(rules), "regras")
