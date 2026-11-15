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
| Jardim (`!faz-plantar`) | Cultivo (9 canteiros) | 15m a 12h por planta;<br>Sacola do Coveiro diaria (reset 03:00 BRT) | Limite da loja: 10 sementes comuns/dia; 3 raras/epicas/dia | Sacola: ~3.000 Ptl + 3 sementes; Lucro agricola: +19.000 Ptl/dia + 16 Waifu Tickets/dia |
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
* Plantas de Waifus (producao de rolls):
  * 10x Coracao Purpuro (3h): custo 300 Ptl, colheita 350 Ptl + 1 Waifu Ticket. Saldo: +500 Ptl e +10 Waifu Tickets/dia.
  * 3x Rosa de Sangue (12h): custo 1.200 Ptl, colheita 1.500 Ptl + 2 Waifu Tickets. Saldo: +900 Ptl e +6 Waifu Tickets/dia.
* Plantas de economia pura:
  * 3x Lotus Negra (+9.000 Ptl) + 10x Cogumelo Tumular (+4.000 Ptl) + 10x Lirio Cadaver (+6.000 Ptl). Saldo: +19.000 Ptl/dia.
* Sacola do Coveiro: +3.000 Ptl/dia.
* Total agricola base: +23.400 Petalitas/dia e 16 Waifu Tickets/dia.

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

## 3. Cenarios de Operacao Diaria

1. **Cenario A: Sinergia Total (Foco em Zinthos)**
   * Todas as 245 iscas obtidas no Slots sao usadas na pesca junto com as 24 iscas naturais (~302 arremessos).
   * Vende todos os peixes comuns e 75% das Petalitas geradas para o RavenaBank (retendo 25% para reinvestir em sementes).
   * Converte 100% das Runas obtidas em Zinthos via `!banco-comprar zinthos`.
2. **Cenario B: Padrao (Foco em Zinthos com rotina moderada)**
   * Faz a pescaria natural (24 iscas), roda os slots regenerados, colhe o jardim e vende peixes e 75% das petalitas. As iscas recebidas no slots ficam guardadas.
   * Converte 100% das Runas obtidas em Zinthos.
3. **Cenario C: Acumulo de Runas (Sem conversao para Zinthos)**
   * As Runas permanecem na conta bancaria para compras de consumiveis e valorizacao cambial. O jogador mantem apenas o Zinthos nativo gerado no Waifuletes e acumula o saldo de Petalitas.

---

## 4. Medias Diarias por Nivel de Aproveitamento

| Metrica Diaria | 100% de Aproveitamento | 80% de Aproveitamento | 60% de Aproveitamento | 50% de Aproveitamento |
| :--- | :--- | :--- | :--- | :--- |
| Moedas de Slots/dia | 720 moedas (1.000 giros) | 576 moedas (800 giros) | 432 moedas (600 giros) | 360 moedas (500 giros) |
| Rolls Totais no Waifuletes | 316,1 rolls/dia | 252,9 rolls/dia | 189,7 rolls/dia | 158,0 rolls/dia |
| Petalitas Totais Geradas | 32.121 Ptl/dia | 25.697 Ptl/dia | 19.273 Ptl/dia | 16.060 Ptl/dia |
| Runas Geradas: Cenario B (Padrao) | 17.632 ᚱ/dia | 14.106 ᚱ/dia | 10.579 ᚱ/dia | 8.816 ᚱ/dia |
| Runas Geradas: Cenario A (Sinergia Total) | 33.226 ᚱ/dia | 26.581 ᚱ/dia | 19.936 ᚱ/dia | 16.613 ᚱ/dia |
| Zinthos Nativo (Sem banco) | 6.821 Z/dia | 5.457 Z/dia | 4.093 Z/dia | 3.411 Z/dia |
| Zinthos Total: Cenario B (Padrao) | 105.930 Z/dia | 84.744 Z/dia | 63.558 Z/dia | 52.965 Z/dia |
| Zinthos Total: Cenario A (Sinergia) | 192.607 Z/dia | 154.086 Z/dia | 115.564 Z/dia | 96.304 Z/dia |

Na cotacao base teorica (0,2857 ᚱ/Z), o Zinthos total seria de ~65.000 Z/dia no Cenario B e ~118.000 Z/dia no Cenario A. Na cotacao real indexada ao M2 do banco (0,1699 ᚱ/Z), o rendimento atinge os valores da tabela sem ultrapassar o limite diario de 525.000 Z/dia.

---

## 5. Projecao Temporal Escalada (1, 7, 15, 30 e 60 dias)

### 100% de Aproveitamento (Sem perda de cooldowns)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 105.930 Z | 192.607 Z | 17.632 ᚱ | 33.226 ᚱ | 32.121 Ptl |
| 7 dias | 741.510 Z | 1.348.250 Z | 123.424 ᚱ | 232.584 ᚱ | 224.847 Ptl |
| 15 dias | 1.588.949 Z | 2.889.107 Z | 264.480 ᚱ | 498.395 ᚱ | 481.814 Ptl |
| 30 dias | 3.177.898 Z | 5.778.214 Z | 528.961 ᚱ | 996.791 ᚱ | 963.628 Ptl |
| 60 dias | 6.355.796 Z | 11.556.428 Z | 1.057.921 ᚱ | 1.993.581 ᚱ | 1.927.256 Ptl |

### 80% de Aproveitamento (Pausa noturna de 6 a 8 horas)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 84.744 Z | 154.086 Z | 14.106 ᚱ | 26.581 ᚱ | 25.697 Ptl |
| 7 dias | 593.208 Z | 1.078.600 Z | 98.739 ᚱ | 186.068 ᚱ | 179.877 Ptl |
| 15 dias | 1.271.159 Z | 2.311.286 Z | 211.584 ᚱ | 398.716 ᚱ | 385.451 Ptl |
| 30 dias | 2.542.319 Z | 4.622.571 Z | 423.168 ᚱ | 797.432 ᚱ | 770.902 Ptl |
| 60 dias | 5.084.637 Z | 9.245.142 Z | 846.337 ᚱ | 1.594.865 ᚱ | 1.541.805 Ptl |

### 60% de Aproveitamento (Uso regular em blocos ao longo do dia)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 63.558 Z | 115.564 Z | 10.579 ᚱ | 19.936 ᚱ | 19.273 Ptl |
| 7 dias | 444.906 Z | 808.950 Z | 74.054 ᚱ | 139.551 ᚱ | 134.908 Ptl |
| 15 dias | 953.369 Z | 1.733.464 Z | 158.688 ᚱ | 299.037 ᚱ | 289.088 Ptl |
| 30 dias | 1.906.739 Z | 3.466.928 Z | 317.376 ᚱ | 598.074 ᚱ | 578.177 Ptl |
| 60 dias | 3.813.478 Z | 6.933.857 Z | 634.753 ᚱ | 1.196.149 ᚱ | 1.156.354 Ptl |

### 50% de Aproveitamento (Uso casual de 2 a 3 sessoes diarias)
| Periodo | Zinthos (Padrao) | Zinthos (Sinergia Total) | Runas Geradas (Padrao) | Runas Geradas (Sinergia) | Petalitas Geradas |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 dia | 52.965 Z | 96.304 Z | 8.816 ᚱ | 16.613 ᚱ | 16.060 Ptl |
| 7 dias | 370.755 Z | 674.125 Z | 61.712 ᚱ | 116.292 ᚱ | 112.423 Ptl |
| 15 dias | 794.475 Z | 1.444.553 Z | 132.240 ᚱ | 249.198 ᚱ | 240.907 Ptl |
| 30 dias | 1.588.949 Z | 2.889.107 Z | 264.480 ᚱ | 498.395 ᚱ | 481.814 Ptl |
| 60 dias | 3.177.898 Z | 5.778.214 Z | 528.961 ᚱ | 996.791 ᚱ | 963.628 Ptl |

---

## 6. Comandos Gerais dos Jogos

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

## 7. Script de Simulacao

Para recalcular as estimativas com as cotacoes do dia salvas no banco de dados `data/sqlites/bank.db`:

```bash
python3 scripts/economy_simulation.py
```

Arquivo de script:
* [economy_simulation.py](scripts/economy_simulation.py)

O script le a tabela `bank_daily_rates`, extrai a cotacao registrada no reset das 04:00 BRT e recalcula as projecoes.
