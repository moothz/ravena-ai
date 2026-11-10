# 🏛️ RavenaBank — Sistema Central de Economia & Câmbio

O **RavenaBank** é o sistema financeiro central da RavenaBot, integrando os mini-games de **Pesca**, **Waifus (Waifuletes)** e **Jardim das Sombras (Fazenda)** sob uma moeda padrão universal: as **Runas** (💠 $ᚱ$).

---

## 💎 1. A Moeda Global: Runas (💠 $ᚱ$)

Em vez de pares de troca cruzados diretos (que gerariam 6 pares distintos e arbitragem circular), todas as moedas e recursos dos jogos são cotados em **Runas**:
* Os jogadores podem vender recursos de qualquer mini-game para o banco para acumular Runas.
* As Runas ficam custodiadas na conta bancária do usuário (`bank.db`) e podem ser utilizadas para comprar recursos dos jogos suportados ou aproveitadas na Loja Global da Ravena.
* Runas mantidas em conta não sofrem depreciação nominal e ganham poder de compra relativo contra ativos inflacionários.

---

## ⚖️ 2. Ancoragem Base & Equivalências

A cotação de referência foi calibrada a partir da dedicação ativa diária ($1\text{ dia}$ de jogo médio):

$$\mathbf{1.000\text{ Runas (ᚱ)}} \;\equiv\; \mathbf{800\text{ kg de Peixe Comum}} \;\equiv\; \mathbf{3.500\text{ Zinthos}} \;\equiv\; \mathbf{8.000\text{ Petalitas (Ptl)}}$$

### Cotações Unitárias Base:
* **🎣 Pesca:** $1\text{ kg de Peixe Comum} = 1,250\text{ Runas}$
* **💜 Waifus:** $1\text{ Zinthos} \approx 0,2857\text{ Runas}$
* **🌱 Fazenda:** $1\text{ Petalita (Ptl)} = 0,1250\text{ Runas}$

---

## 📅 3. Cotação Dinâmica com Rotação Diária (04:00 AM BRT)

Todos os dias às **04:00 AM (Horário de Brasília / 07:00 UTC)**, o scheduler do banco recalcula a cotação oficial do dia e libera as cotas de todos os usuários com base nos dados reais das últimas 24 horas:

$$R_{\text{moeda}}(t) = R_{\text{moeda, base}} \times \Phi_{\text{mercado}}(t)$$

1. **Fator Waifus ($\Phi_{\text{zinthos}}$):** Indexado inversamente ao índice de inflação do Waifuletes ($I_M$):
   $$\Phi_{\text{zinthos}} = \frac{1}{I_M} = \frac{1}{1 + 0,5 \cdot \ln\left(\max\left(1, \frac{M_2}{4.000.000}\right)\right)}$$
   *Se o volume acumulado de Zinthos aumentar (mais inflação), o Zinthos perde poder de compra frente à Runa.*
2. **Fator Pesca ($\Phi_{\text{pesca}}$):** Indexado à variação do peso de peixe comum circulante nos inventários.
3. **Fator Fazenda ($\Phi_{\text{jardim}}$):** Indexado ao volume global de Petalitas registradas no Jardim das Sombras.

### 🛡️ Trava de Segurança (Circuit Breaker)
Para evitar choques especulativos e volatilidade excessiva, a variação da cotação de qualquer ativo é limitada a no máximo **$\pm 10\%$ por dia**:
$$R_{\text{novo}} = \text{clamp}\Big(R_{\text{novo}}, \; 0,90 \times R_{\text{ontem}}, \; 1,10 \times R_{\text{ontem}}\Big)$$

---

## 📈 4. Taxa Progressiva (3% a 10%)

Em cada operação de câmbio (venda ou compra), o banco retém uma taxa progressiva (spread) que varia conforme a utilização da cota diária do usuário:

$$\text{Taxa}(u) = 0,03 + 0,07 \times \left( \frac{\text{Volume Convertido Hoje}}{\text{Cota Diária Total}} \right)^{1,5}$$

* **Operações Iniciais (0% a 20% da cota):** Taxa quase mínima (~**3,0% a 3,6%**), beneficiando jogadores casuais.
* **Operações Moderadas (50% da cota):** Taxa média (~**5,5%**).
* **Operações no Teto (90% a 100% da cota):** Taxa máxima (**9,0% a 10,0%**), desencorajando dumping por acumuladores.
* **Destruição Deflacionária:** Todo o valor arrecadado na taxa pelo banco é **destruído permanentemente**, atuando como um poderoso dreno monetário para combater a inflação dos jogos.

---

## 🎣 5. Venda de Peixes & Regras

1. **Venda de Peixes:**  
   Peixes comuns podem ser vendidos para o banco para obter Runas. **Não é permitido comprar peixes com Runas**, protegendo a integridade dos rankings de pesca e as espécies raras de cada bioma.
2. **Blindagem Absoluta de Peixes Lendários:**  
   Peixes lendários/raros (`is_rare = 1`) são 100% ignorados pelo banco e **jamais são vendidos**.
3. **Venda por Peso (Aproximação para baixo):**  
   Ao solicitar uma venda por peso (ex: `!banco-vender peixe 300`):
   * O banco seleciona os peixes comuns cujo peso somado seja $\le 300\text{ kg}$ e o mais próximo possível dessa meta (ex: 298,40 kg).
   * O peixe que estouraria a meta permanece intacto no inventário do jogador.
   * O usuário também pode usar `!banco-vender peixe tudo` para liquidar todos os peixes comuns de uma vez (respeitando a cota diária).

---

## 🛡️ 6. Cotas Diárias de Câmbio & Progressão Dinâmica (Reset às 04:00 AM)

Para impedir inundações descontroladas (dumping) de recursos nos jogos por acumuladores de Runas, o RavenaBank opera com **cotas diárias dinâmicas** que se ajustam automaticamente à inflação e crescem diariamente através de um mecanismo de **Crawling Peg**:

### 📥 A. Cota de Venda (Ganhar Runas)
* **Limite Unificado:** **300.000 ᚱ**/dia por usuário (soma consolidada de qualquer origem: peixes comuns, Zinthos ou Petalitas).

### 📤 B. Cotas de Compra (Inversão: Runas para Jogos)
As cotas de conversão de Runas para os jogos não são estáticas. Elas possuem **bases mínimas garantidas** e são indexadas à inflação real de cada subsistema com expansão diária gradual:

| Ativo | Cota Base Mínima | Ponto de Partida Inicial | Mecanismo de Inflação | Ritmo de Expansão Diária |
| :--- | :---: | :---: | :---: | :---: |
| 💜 **Waifuletes (Zinthos)** | **500.000 Z**/dia | **~600.000 Z**/dia | Fator logarítmico M2 ($I_M$) | $+1{,}0\%/\text{dia}$ (~$+5\text{k a }+7\text{k Z/dia}$) |
| 🌱 **Jardim (Petalitas)** | **300.000 Ptl**/dia | **~320.000 Ptl**/dia | Razão de Snapshots ($P/P_0$) | $+0{,}5\%/\text{dia}$ (~$+1{,}5\text{k a }+2\text{k Ptl/dia}$) |
| 🎣 **Pesca (Peixes)** | — | — | Mão única (compra desativada) | — |

---

### 🧮 6.1. Equações de Inflação & Cálculo das Cotas Alvo

#### 1. Inflação do Waifuletes ($I_M$):
Calculada em tempo real com base na massa monetária em circulação ($M_2$):
$$I_M = 1 + \alpha \cdot \ln\left(\max\left(1, \frac{M_2}{M_0}\right)\right)$$
* $M_0 = 4.000.000\text{ Zinthos}$ (Massa monetária de ancoragem).
* $\alpha = 0{,}25$ (Elasticidade monetária).
* **Taxa Percentual:** $\text{Inflação}_Z (\%) = (I_M - 1) \times 100\%$.
* **Cota Alvo:** $C_{\text{target, Z}} = 500.000 \times \left(1 + \frac{\text{Inflação}_Z}{100}\right) = 500.000 \times I_M$.

#### 2. Inflação do Jardim das Sombras (Petalitas):
Calculada a partir dos snapshots periódicos de saldos dos jogadores (`fazenda_player_snapshots`):
$$\text{Inflação}_{\text{Ptl}} (\%) = \max\left(0, \frac{P_{\text{circulante}} - P_0}{P_0}\right) \times 100\%$$
* $P_0 = 17.938.824\text{ Petalitas}$ (Patrimônio de referência histórico).
* $P_{\text{circulante}}$ = Saldo total somado de todas as fazendas ativas no snapshot mais recente.
* **Cota Alvo:** $C_{\text{target, Ptl}} = 300.000 \times \left(1 + \frac{\text{Inflação}_{\text{Ptl}}}{100}\right)$.

---

### 📈 6.2. Algoritmo de Progressão Diária ("Crawling Peg")

Às **04:00 AM (Horário de Brasília)** de cada dia, durante a rotação oficial executada por `calculateDailyRates()`, o banco consulta o histórico do dia anterior e aplica o avanço gradual:

1. **Zinthos:**
   * Se a cota do dia anterior for inferior à base ($< 500.000$), inicia em **600.000 Z**.
   * Nos dias subsequentes, a cota avança suavemente $+1{,}0\%$ ao dia em direção à cota alvo:
     $$C_Z(t) = \min\Big(\max(C_{\text{target, Z}}, 600.000), \; C_Z(t-1) + \max(5.000, \text{round}(C_Z(t-1) \times 0{,}01))\Big)$$
2. **Petalitas:**
   * Se a cota do dia anterior for inferior à base ($< 300.000$), inicia em **320.000 Ptl**.
   * Nos dias subsequentes, a cota avança suavemente $+0{,}5\%$ ao dia:
     $$C_{\text{Ptl}}(t) = \min\Big(\max(C_{\text{target, Ptl}}, 320.000), \; C_{\text{Ptl}}(t-1) + \max(1.500, \text{round}(C_{\text{Ptl}}(t-1) \times 0{,}005))\Big)$$
3. **Persistência no Banco de Dados:**
   Todas as cotas oficiais calculadas para cada data são salvas na tabela `bank_daily_rates` (`quota_compra_zinthos`, `quota_compra_jardim`, `waifu_inflation_percent`, `jardim_inflation_percent`), assegurando integridade histórica e transparência para a interface web e para o comando `!economia`.

---

## 🛍️ 7. Loja RavenaBank (Consumíveis de Jogos)

Permite aos jogadores investir suas Runas acumuladas diretamente em consumíveis essenciais dos mini-games:

1. **🎰 Moedinhas (SlotsGame / Caça-coisas)**:
   * **Preço:** `55 ᚱ` por moeda.
   * **Limite Diário:** Máximo **300 moedas compradas por dia** (reset às 04:00 AM BRT).
   * **Comando:** `!banco-comprar moeda <quantidade>`

2. **🐛 Iscas (FishingGame / Pescaria)**:
   * **Preço:** `45 ᚱ` por isca.
   * **Limite Diário:** Máximo **200 iscas compradas por dia** (reset às 04:00 AM BRT).
   * **Comando:** `!banco-comprar isca <quantidade>`

3. **Catálogo Geral:**
   * O comando `!banco-loja` (ou `!banco-comprar loja`) exibe o catálogo completo com preços, limites e quantidade disponível para compra no momento.

---

## 🔐 8. Painel Web (`/ravenabank`) & Sessões Deslizantes (Sliding Session)

Para acessar o painel de gerenciamento, loja e câmbio pelo navegador:
* O comando `!banco-adm` gera um link pessoal seguro com token: `https://site/ravenabank?token=...`
* **Sessão Deslizante:** A sessão permanece ativa por **3 dias sem acessar**. Cada novo acesso ou troca pelo navegador renova a validade por mais 3 dias automaticamente.
* **Interface Moderna com Abas (Loja & Câmbio):**
  * **Saldo Consolidado:** Card de topo exclusivo exibindo o saldo em Runas com largura total.
  * **Aba Compra:** Lojinha virtual com cards de produtos (Moedinhas do Slots, Iscas de Pesca, Zinthos de Waifuletes e Petalitas da Fazenda), botões de ajuste de quantidade (`-`, `+`, `Max`), indicadores de estoque e limite disponível, e carrinho de compras na barra inferior com subtotal, total e confirmação atômica de pedido.
  * **Aba Venda:** Painel de liquidação de ativos (Peixes comuns por peso, Zinthos e Petalitas) com exibição de estoques atuais, cotação unitária, controles de quantidade (`-`, `+`, `Tudo`) e carrinho inferior estimando o total a receber já descontando a taxa progressiva.
  * **Extrato Paginado:** Histórico de transações detalhado com paginação nativa de 10 movimentações por página, exibindo as mais recentes primeiro.
* **Botão de Logout:** Na interface web, o botão de logout encerra a sessão imediatamente no banco de dados.

---

## 💬 9. Comandos Disponíveis (Categoria: `ravenabank`)

| Comando | Aliases | Descrição |
| :--- | :--- | :--- |
| `!banco` | `!ravenabank`, `!saldo-banco` | Consulta saldo de Runas, patrimônio consolidado e cotas diárias |
| `!banco-adm` | `!bancoadm`, `!banco-web` | Envia link seguro no PV para gerenciar conta e realizar trocas no navegador |
| `!economia` | `!cotacao`, `!banco-economia` | Painel macroeconômico com cotações do dia, totais acumulados e explicações |
| `!banco-vender` | `!banco-depositar`, `!vender-peixe` | Vende recursos de jogos para receber Runas (`!banco-vender peixe 300`, `!banco-vender zinthos 1500`) |
| `!banco-comprar` | `!banco-sacar`, `!banco-resgatar` | Compra recursos de jogos usando Runas (`!banco-comprar zinthos 100`, `!banco-comprar moeda 5`, `!banco-comprar isca 3`) |
| `!banco-loja` | `!loja-banco` | Exibe a loja de consumíveis (moedas e iscas) compráveis com Runas |
| `!banco-extrato` | `!extrato`, `!extrato-banco` | Lista as últimas movimentações e extrato bancário |

---

## 🎁 10. Normalização de Bônus e Prêmios Globais

Para proteger os subsistemas de inflação descontrolada, premiações e bônus monetários de outros jogos foram centralizados na moeda global **Runas (💠 $ᚱ$)**:

1. **Apoio & Doações (`!doar-vantagens`)**:
   * O antigo bônus em Zinthos foi convertido para **50 Runas por R$ 1,00 doado**.
   * O doador tem total liberdade de manter suas Runas valorizando no banco ou utilizá-las para comprar Zinthos ou Petalitas através de `!banco-comprar`.
2. **Slots (`!slots`)**:
   * Prêmios de alto escalão pagam diretamente em Runas (600 ᚱ a 3.000 ᚱ).
3. **Pesca & Novo Buff Carteira Furada (`!pescar`)**:
   * **👛 Carteira Furada:** Novo item especial na pescaria com chance `0.04` (4%). Concede de **50 a 500 Runas** creditadas diretamente no RavenaBank do pescador!

---

## 🗄️ 11. Estrutura de Dados & Tabelas (`bank.db`)

O banco SQLite dedicado `bank.db` reside em `data/sqlites/bank.db` e possui 5 tabelas fundamentais:

1. **`bank_accounts`**: Saldos de Runas e histórico acumulado de depósitos/saques:
   * `user_id` (PK, string limpa do número)
   * `runas` (saldo líquido atual em float)
   * `total_deposited_runas` (histórico de vendas para o banco)
   * `total_withdrawn_runas` (histórico de compras com Runas)
   * `created_at`, `updated_at` (timestamps Unix em ms)

2. **`bank_daily_rates`**: Registro histórico diário das cotações, inflações e cotas dinâmicas:
   * `date` (PK, formato `YYYY-MM-DD`)
   * `runas_per_kg_fish` (Cotação oficial de 1 kg de peixe comum)
   * `runas_per_zinthos` (Cotação oficial de 1 Zinthos)
   * `runas_per_jardim_coin` (Cotação oficial de 1 Petalita)
   * `fish_multiplier`, `waifu_multiplier`, `jardim_multiplier` (Multiplicadores dinâmicos)
   * `quota_compra_zinthos` (Cota diária de compra de Zinthos calculada para a data)
   * `quota_compra_jardim` (Cota diária de compra de Petalitas calculada para a data)
   * `waifu_inflation_percent` (Taxa percentual de inflação do Waifuletes do dia)
   * `jardim_inflation_percent` (Taxa percentual de inflação de Petalitas do dia)
   * `updated_at` (timestamp da rotação)

3. **`bank_daily_quotas`**: Acompanhamento do consumo de cotas por usuário em cada dia:
   * `user_id`, `date` (PK Composta)
   * `runas_venda_used` (Runas obtidas vendendo peixes/zinthos/petalitas, máx 300.000)
   * `zinthos_compra_used` (Zinthos resgatados no dia, limitado à cota dinâmica do dia)
   * `jardim_compra_used` (Petalitas resgatadas no dia, limitado à cota dinâmica do dia)
   * `moedas_compra_used` (Moedas de slots compradas, máx 300)
   * `iscas_compra_used` (Iscas de pesca compradas, máx 200)

4. **`bank_transactions`**: Livro-razão contábil com auditoria de cada operação:
   * `id` (PK autoincrement)
   * `user_id`, `type` (`DEPOSIT`, `WITHDRAW`, `STORE_BUY`, `BONUS`), `game` (`fishing`, `waifu`, `jardim`, `slots`)
   * `game_amount`, `runas_amount`, `spread_rate`, `spread_fee_runas`, `details_json`, `timestamp`

5. **`bank_sessions`**: Tokens de autenticação segura para o painel web `/ravenabank`:
   * `token` (PK), `user_id`, `created_at`, `last_accessed_at`, `expires_at` (Sliding 3 dias)
