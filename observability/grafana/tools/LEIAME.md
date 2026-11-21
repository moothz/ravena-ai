# Gerador dos dashboards da economia

`economia.json`, `jogador.json` (em `../dashboards/`) e `../provisioning/alerting/economia.yaml` são gerados por
`mkdash.py` (painéis e SQL) com `v2.py` (conversão para o formato `dashboard.grafana.app/v2` do Grafana 13: abas,
seções, renderização condicional). Não edite os JSON à mão: mude o gerador e regenere.

    python3 observability/grafana/tools/mkdash.py .            # regrava os três arquivos no repo
    python3 observability/grafana/tools/mkdash.py . /tmp/saida # gera em outro diretório (mesma árvore)

Só Python 3, sem dependências. `node src/testing/test_economy_analytics.js` regenera num diretório temporário e
compara byte a byte com os arquivos commitados (pula com aviso se não houver `python3`), além de rodar o SQL dos
painéis num banco de teste e checar o layout (sem sobreposição, Resumo numa tela).

Moedas (v4): a variável `moedas` (várias, com All) dirige as abas Resumo, Moeda, Jogadores e Mudanças; os botões no
topo dessas abas são o painel Business Variable (`volkovlabs-variable-panel`, modo botão, mesma variável). Painel de
valor absoluto se repete por moeda (`repeat` no painel, `Section(..., repeat="moedas")` na seção): dentro da cópia
`${moedas}` vale uma moeda só, por isso o SQL usa sempre `IN (${moedas:sqlstring})` e os títulos `${moedas:text}`.
Colunas `"${moedas:text}: <série>"` recebem a cor da moeda por `coin_named()`.

`llm.json` (Uso de LLM, Prometheus) não é gerado por aqui: é JSON clássico escrito à mão, como o `ravena-red.json`.

O conteúdo das mudanças automáticas (rota `/internal/economy/params`, possíveis mudanças, `--listar`,
`--confirmar`/`--descartar`, coluna Origem, anotação "Possíveis mudanças") só entra quando o repo tem
`src/services/EconomyAnalyticsChanges.js`.
