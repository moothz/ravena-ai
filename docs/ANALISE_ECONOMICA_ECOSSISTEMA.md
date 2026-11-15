# Analise Economica Integrada: Ravena-AI, Waifuletes e Jardim das Sombras

Auditoria e modelagem de rendimentos da economia integrada pelo RavenaBank, cobrindo pesca (`FishingGame`), caca-niqueis (`SlotsGame`), fazenda (`FazendaCommands` / Jardim das Sombras) e colecao de waifus (`Waifuletes`).

O calculo prioriza a obtencao de Zinthos, detalhando tambem a geracao de Runas (ᚱ) e Petalitas (Ptl) em quatro faixas de aproveitamento de cooldowns (100%, 80%, 60% e 50%) com projecoes de 1 a 60 dias.

---

## 1. Parametros do Ecossistema (Cooldowns, Limites e Cotacoes)

Moedas e recursos dos minigames sao centralizados em Runas (ᚱ), custodiadas na base SQLite `data/sqlites/bank.db`.

| Jogo / Sistema | Acao Principal | Cooldown / Regeneracao | Limite Diario (Reset 04:00 BRT) | Taxa / Retorno Base |
| :--- | :--- | :--- | :--- | :--- |
| Pesca (`!pescar`) | Arremesso de isca | Cooldown: 5s;<br>Regen: 1 isca / 1h (teto base: 5 iscas; cap absoluto: 300) | 24 iscas naturais/dia (compra no banco permite ate +200 iscas/dia) | 84% peixe (~37,8 kg medios), 15% lixo, 4% Carteira Furada (+50 a 500 ᚱ), 4% Fichas (+1 a 5 moedas) |
| Slots (`!slots`) | Giro da alavanca | Cooldown: 5s;<br>Regen: 1 moeda / 2 min (teto base: 5 moedas; cap absoluto: 1.000) | 720 moedas naturais/dia (compra no banco permite ate +300 moedas/dia) | 1% Vitoria Total (fator diamante 1,4x), 27% Vitoria Parcial (7,5% cashback), 72% Derrota |
| Jardim (`!faz-plantar`) | Cultivo (9 canteiros) | 15m a 12h por planta;<br>Sacola do Coveiro diaria (reset 03:00 BRT) | Limite da loja: 10 sementes comuns/dia; 3 raras/epicas/dia | Sacola: ~3.000 a 5.000 Ptl + sementes; Rendimento real auditado: ~74.900 Ptl/dia a 100% de aproveitamento + 16 Waifu Tickets/dia |
| Waifuletes (`!roll`) | Gacha de personagens | Cooldown roll: 1 roll / 5 min (base: 9); Cooldown claim por raridade (30m a 2h) | 288 rolls base/dia; Casamento: 25 Comuns, 20 Incomuns, 15 Raras, 10 Epicas | Daily: ~675 Z; Cristais nos rolls: ~12,5 Z/roll; Divorcio: 1o 100%, 2o 80% do valor ajustado por rank |
| RavenaBank (`!banco`) | Cambio e Liquidacao | Sem cooldown | Cota Venda: 300.000 ᚱ/dia;<br>Cota Compra Zinthos: 525.000 Z/dia;<br>Cota Compra Petalitas: 307.500 Ptl/dia | Spread progressivo: $0,03 + 0,07 \times (\text{Uso}/\text{Cota})^{1,5}$ (~3% a 5,5% medios). Cotacao atual: 1 ᚱ = 5,886 Zinthos (0,1699 ᚱ/Z); 1 kg peixe = 1,2562 ᚱ; 1 Ptl = 0,1235 ᚱ |

---

## 2. Matematica de Valor Esperado (EV) por Jogada

### Caca-Coisas (`SlotsGame.js`)
* Retorno por giro simples (1 moeda gasta):
  * Runas: 13,23 ᚱ
  * Petalitas: 8,71 Ptl
  * Iscas: 0,245 iscas
  * Re-spin (moedas recuperadas no drop): 0,28 moedas
  * Waifu Tickets: 0,0121 tickets
* Custo liquido por giro: $1 - 0,28 = 0,72\text{ moedas}$. Cada moeda regenerada rende 1,39 giros reais.
* EV por moeda natural regenerada:
  $$18,38\text{ Runas} \quad|\quad 12,11\text{ Petalitas} \quad|\quad 0,34\text{ Iscas} \quad|\quad 0,0168\text{ Waifu Tickets}$$

### Pescaria (`FishingGame.js`)
* Balanco de iscas: O ganho de Pacote de Iscas (+0,20 iscas/arremesso) supera as perdas com Tartaruga e Balde Furado (-0,09 iscas). O consumo liquido real e de 0,89 isca por arremesso.
* EV por arremesso:
  * Peso de peixe comum retido: 37,80 kg (valor de 47,48 ᚱ a 1,2562 ᚱ/kg).
  * Carteira Furada: 11,00 ᚱ creditados direto no banco.
  * Fichas de Slots: +0,12 moedas.
  * Rendimento por arremesso: 58,48 Runas (equivalente a 65,71 ᚱ por isca liquida gasta).

### Jardim das Sombras (`FazendaCommands.js`)
* Producao real auditada (74.900 Ptl/dia a 100% de aproveitamento):
  * Lucro liquido do catalogo lucrativo da loja: ~49.400 Ptl/dia (considerando double-dipping de coinReward e sellPrice).
  * Sacola do Coveiro diaria + sementes gratuitas: ~5.300 Ptl/dia.
  * Sacolas do Coveiro obtidas via Slots (~7,6 sacolas/dia = ~23 sementes comuns + bonus colhidas): ~11.500 Ptl/dia.
  * Petalitas diretas ganhas no Slots: ~8.700 Ptl/dia.
  * Waifu Tickets gerados por colheitas (Coracao Purpuro e Rosa de Sangue): 16 tickets/dia.

### Waifuletes (`RollService.ts` e `DivorceService.ts`)
* Rolls diarios: 288 base + 16 (Jardim) + 12,1 (Slots a 100%) = 316,1 rolls/dia.
* Zinthos em rolls (cristais de Kakera): $316,1 \times 25\% \times 50\text{ Z} = 3.951\text{ Z/dia}$.
* Daily (com streak e wishlist): 675 Z/dia.
* Divorcio diario de 2 personagens (exemplo: 1 Epico e 1 Raro com rank medio 2.2x):
  * 1o Epico: $700 \times 2,2 \times 0,95 \times 1,0 = 1.463\text{ Z}$.
  * 1o Raro: $350 \times 2,2 \times 0,95 \times 1,0 = 732\text{ Z}$.
  * Total de divorcios: 2.195 Z/dia.
* Zinthos nativo direto (sem cambio bancario): 6.821 Zinthos/dia.

---

## 3. Auditoria do Desvio de Petalitas (Real vs Calibragem Teorica)

No documento de calibragem original do banco ([RAVENABANK.md](file:///home/moothz/ravena-ai/docs/RAVENABANK.md#L18-L26)), 1 dia de dedicacao media foi calibrado para gerar 8.000 Petalitas. Nos snapshots reais de producao dos jogadores (`fazenda_player_snapshots` em `data/sqlites/fazenda.db`), os jogadores mais ativos acumulam entre 400.000 e 633.000 Petalitas semanais (57.000 a 90.000 Petalitas/dia), confirmando relatos da comunidade de ganhos superiores a 50.000 Ptl/dia.

Causas tecnicas identificadas no codigo:

1. **Recompensa Dupla (Double Dipping):** Em `FarmService.ts`, o metodo `harvest()` credita `coinReward` imediatamente na carteira e adiciona o item `crop_<planta>` ao inventario, permitindo vende-lo em seguida por `sellPrice`.
2. **Multiplicador de Moedas em Cascata:** O parametro `effectiveCoinMultiplier` (ate 2.0x por buffs e doacoes) incide tanto sobre o `coinReward` na colheita quanto sobre o `sellPrice` na venda. Uma Lotus Negra com 2.0x rende 8.000 Ptl na venda, gerando 21.000 Ptl de lucro liquido em 3 sementes.
3. **Margens de Cultivos Curtos:** O Cogumelo Tumular custa 200 Ptl e vende por 600 Ptl (200% de lucro liquido) com tempo de crescimento de apenas 20 minutos (ou 5 minutos com buffs de velocidade).
4. **Sementes Gratuitas via Slots:** A integracao com `SlotsGame.js` injeta sacolas e dezenas de sementes sem custo de loja aos jogadores frequentes.
5. **Limites da Loja por Especie:** O limite diario da loja e individual por planta (10 unidades por especie), permitindo comprar 86 sementes lucrativas por dia.

*Nota para rebalanceamento futuro:* Para reancorar a producao na faixa de 15.000 a 25.000 Ptl/dia sem afetar a diversao, os pontos de ajuste recomendados sao a eliminacao do `coinReward` em plantas que ja concedem itens utilitarios (deixando apenas o `sellPrice`), reducao das margens do Cogumelo Tumular e Lirio Cadaver, e adocao de cota global de sementes por dia (25 a 30 sementes no total).

---

## 4. Cenarios de Operacao Diaria

1. **Cenario A: Sinergia Total (Foco em Zinthos com pesca intensiva)**
   * Todas as 245 iscas obtidas no Slots sao usadas na pesca junto com as 24 iscas naturais (~302 arremessos).
   * Vende todos os peixes comuns e 75% das Petalitas geradas para o RavenaBank (retendo 25% para reinvestir em sementes).
   * Converte 100% das Runas obtidas em Zinthos via `!banco-comprar zinthos`.
2. **Cenario B: Padrao (Foco em Zinthos com rotina moderada)**
   * Faz a pescaria natural (24 iscas), roda os slots regenerados, colhe o jardim e vende peixes e 75% das petalitas geradas. As iscas recebidas no slots ficam estocadas.
   * Converte 100% das Runas obtidas em Zinthos.
3. **Cenario C: Acumulo de Runas (Sem conversao para Zinthos)**
   * As Runas permanecem na conta bancaria para compras de consumiveis e valorizacao cambial. O jogador mantem apenas o Zinthos nativo gerado no Waifuletes e acumula o saldo de Petalitas.

---

## 5. Medias Diarias por Nivel de Aproveitamento

| Metrica Diaria | 100% de Aproveitamento | 80% de Aproveitamento | 60% de Aproveitamento | 50% de Aproveitamento |
| :--- | :--- | :--- | :--- | :--- |
| Moedas de Slots/dia | 720 moedas (1.000 giros) | 576 moedas (800 giros) | 432 moedas (600 giros) | 360 moedas (500 giros) |
| Rolls Totais no Waifuletes | 316,1 rolls/dia | 252,9 rolls/dia | 189,7 rolls/dia | 158,0 rolls/dia |
| Petalitas Totais Geradas | 74.900 Ptl/dia | 59.920 Ptl/dia | 44.940 Ptl/dia | 37.450 Ptl/dia |
| Runas Geradas: Cenario B (Padrao) | 21.436 ᚱ/dia | 17.149 ᚱ/dia | 12.862 ᚱ/dia | 10.718 ᚱ/dia |
| Runas Geradas: Cenario A (Sinergia Total) | 37.030 ᚱ/dia | 29.624 ᚱ/dia | 22.218 ᚱ/dia | 18.515 ᚱ/dia |
| Zinthos Nativo (Sem banco) | 6.821 Z/dia | 5.457 Z/dia | 4.093 Z/dia | 3.411 Z/dia |
| Zinthos Total: Cenario B (Padrao) | 127.312 Z/dia | 101.849 Z/dia | 76.387 Z/dia | 63.656 Z/dia |
| Zinthos Total: Cenario A (Sinergia) | 213.877 Z/dia | 171.101 Z/dia | 128.326 Z/dia | 106.938 Z/dia |

Na cotacao real indexada ao M2 do banco (0,1699 ᚱ/Z), a conversao das Runas geradas permite atingir os valores da tabela sem ultrapassar o teto diario de compra do banco (525.000 Z/dia).

---

## 6. Projecao Temporal Escalada (1, 7, 15, 30 e 60 dias)

### 100% de Aproveitamento (Sem perda de cooldowns)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 127.312 Z | 213.877 Z | 21.436 ᚱ | 37.030 ᚱ | 74.900 Ptl |
| 7 dias | 891.181 Z | 1.497.138 Z | 150.052 ᚱ | 259.212 ᚱ | 524.300 Ptl |
| 15 dias | 1.909.673 Z | 3.208.152 Z | 321.539 ᚱ | 555.454 ᚱ | 1.123.500 Ptl |
| 30 dias | 3.819.347 Z | 6.416.304 Z | 643.078 ᚱ | 1.110.908 ᚱ | 2.247.000 Ptl |
| 60 dias | 7.638.694 Z | 12.832.609 Z | 1.286.156 ᚱ | 2.221.816 ᚱ | 4.494.000 Ptl |

### 80% de Aproveitamento (Pausa noturna de 6 a 8 horas)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 101.849 Z | 171.101 Z | 17.149 ᚱ | 29.624 ᚱ | 59.920 Ptl |
| 7 dias | 712.945 Z | 1.197.710 Z | 120.041 ᚱ | 207.369 ᚱ | 419.440 Ptl |
| 15 dias | 1.527.739 Z | 2.566.522 Z | 257.231 ᚱ | 444.363 ᚱ | 898.800 Ptl |
| 30 dias | 3.055.478 Z | 5.133.044 Z | 514.462 ᚱ | 888.726 ᚱ | 1.797.600 Ptl |
| 60 dias | 6.110.955 Z | 10.266.087 Z | 1.028.925 ᚱ | 1.777.453 ᚱ | 3.595.200 Ptl |

### 60% de Aproveitamento (Uso regular em blocos ao longo do dia)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 76.387 Z | 128.326 Z | 12.862 ᚱ | 22.218 ᚱ | 44.940 Ptl |
| 7 dias | 534.709 Z | 898.283 Z | 90.031 ᚱ | 155.527 ᚱ | 314.580 Ptl |
| 15 dias | 1.145.804 Z | 1.924.891 Z | 192.923 ᚱ | 333.272 ᚱ | 674.100 Ptl |
| 30 dias | 2.291.608 Z | 3.849.783 Z | 385.847 ᚱ | 666.545 ᚱ | 1.348.200 Ptl |
| 60 dias | 4.583.216 Z | 7.699.565 Z | 771.694 ᚱ | 1.333.090 ᚱ | 2.696.400 Ptl |

### 50% de Aproveitamento (Uso casual de 2 a 3 sessoes diarias)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 63.656 Z | 106.938 Z | 10.718 ᚱ | 18.515 ᚱ | 37.450 Ptl |
| 7 dias | 445.590 Z | 748.569 Z | 75.026 ᚱ | 129.606 ᚱ | 262.150 Ptl |
| 15 dias | 954.837 Z | 1.604.076 Z | 160.769 ᚱ | 277.727 ᚱ | 561.750 Ptl |
| 30 dias | 1.909.673 Z | 3.208.152 Z | 321.539 ᚱ | 555.454 ᚱ | 1.123.500 Ptl |
| 60 dias | 3.819.347 Z | 6.416.304 Z | 643.078 ᚱ | 1.110.908 ᚱ | 2.247.000 Ptl |

---

## 7. Comandos Gerais dos Jogos

### RavenaBank (Cambio e Financas)
* `!banco` (ou `!saldo-banco`): Exibe saldo de Runas, patrimonio e cotas diarias consumidas e restantes.
* `!economia` (ou `!cotacao`): Mostra cotacoes dinamicas do dia e indices de inflacao.
* `!banco-vender peixe <kg|tudo>`: Vende peixes comuns para receber Runas.
* `!banco-vender zinthos <quantidade>`: Vende Zinthos de waifus para receber Runas.
* `!banco-vender petalitas <quantidade>`: Vende Petalitas da fazenda para receber Runas.
* `!banco-comprar zinthos <runas|tudo>`: Compra Zinthos no Waifuletes usando Runas em conta.
* `!banco-comprar petalitas <runas|tudo>`: Compra Petalitas na fazenda usando Runas em conta.
* `!banco-comprar moeda <quantidade>`: Compra moedas para o caca-coisas (55 ᚱ cada, limite de 300/dia).
* `!banco-comprar isca <quantidade>`: Compra iscas de pesca (45 ᚱ cada, limite de 200/dia).
* `!banco-adm` (ou `!banco-web`): Envia link web autenticado para gerenciar trocas e loja pelo navegador.
* `!banco-extrato`: Exibe historico das ultimas transacoes no banco.

### Caca-Coisas (SlotsGame)
* `!slots [quantidade|tudo]`: Gira a alavanca (1 a 30 giros por comando).
* `!slots-premios`: Lista tabela de probabilidades e premiacoes.
* `!slots-historico`: Historico de premios obtidos na maquina.
* `!slots-ranking`: Ranking de maiores vencedores e perdedores no grupo.

### Pescaria (FishingGame)
* `!pescar` (ou `!pesca`): Arremessa a vara de pescar usando 1 isca.
* `!pesca-rede` (ou `!rede`): Usa 5 iscas em arremesso unico com bonus de rede.
* `!peixes` (ou `!pesca-inv`): Exibe inventario de peixes capturados, buffs e iscas disponiveis.
* `!pesca-ranking` (ou `!top-peixes`): Ranking de peso acumulado e especies lendarias capturadas.
* `!pesca-info`: Estatisticas completas do pescador.

### Jardim das Sombras (Fazenda)
* `!faz-colheita` (ou `!faz-colher`): Colhe canteiros maduros e limpa plantas mortas.
* `!faz-plantar <item> [slot]` / `!faz-plantar_tudo <item>`: Planta sementes nos canteiros vazios.
* `!faz-loja` (ou `!faz-shop`): Abre o catalogo de sementes, consumiveis e decoracoes.
* `!faz-comprar <item> <quantidade>`: Compra itens da fazenda com Petalitas.
* `!faz-inv`: Mostra inventario de sementes, colheitas e consumiveis.
* `!faz-ranking`: Rankings de saldo e volume de colheitas da fazenda.
* `!faz-adm`: Gera link temporario do painel visual interativo no navegador.

### Waifuletes (Gacha e Harem)
* `!roll` (ou `!w`): Sorteia um personagem aleatorio do catalogo.
* `!marry` (ou `!casar`): Reivindica o personagem sorteado recentemente para seu harem.
* `!divorce <nome|id>`: Divorcia de um personagem e recupera Zinthos proporcional.
* `!daily` (ou `!diario`): Resgata o bonus diario de Zinthos com multiplicadores de streak e wishlist.
* `!harem` (ou `!mm`): Lista suas waifus e personagens casados.
* `!wish <nome>`: Adiciona personagem a wishlist para aumentar chance de sorteio e bonus de daily.
* `!kakera` (ou `!saldo`): Consulta saldo atual de Zinthos/Kakera.

---

## 8. Script de Simulacao

Para recalcular as estimativas com as cotacoes do dia salvas no banco de dados `data/sqlites/bank.db`:

```bash
python3 scripts/economy_simulation.py
```

Arquivo de script:
* [economy_simulation.py](file:///home/moothz/ravena-ai/scripts/economy_simulation.py)

O script le a tabela `bank_daily_rates`, extrai a cotacao registrada no reset das 04:00 BRT e recalcula as projecoes.
