# 🏛️ RavenaBank — Sistema Central de Economia & Câmbio

O **RavenaBank** é o sistema financeiro central da RavenaBot, integrando os mini-games de **Pesca**, **Waifus (Waifuletes)** e **Jardim das Sombras (Fazenda)** sob uma moeda padrão universal: as **Runas** ($ᚱ$).

---

## 💎 1. A Moeda Global: Runas ($ᚱ$)

Em vez de pares de troca cruzados diretos (que gerariam 6 pares distintos e arbitragem circular), todas as moedas e recursos dos jogos são cotados em **Runas**:
* Os jogadores podem depositar recursos de qualquer mini-game no banco para acumular Runas.
* As Runas ficam custodiadas na conta bancária do usuário (`bank.db`) e podem ser resgatadas a qualquer momento para os jogos suportados ou utilizadas na futura Loja Global da Ravena.

---

## ⚖️ 2. Ancoragem Base & Equivalências

A cotação de referência foi calibrada a partir da dedicação ativa diária ($1\text{ dia}$ de jogo médio):

$$\mathbf{1.000\text{ Runas (ᚱ)}} \;\equiv\; \mathbf{800\text{ kg de Peixe Comum}} \;\equiv\; \mathbf{3.500\text{ Zinthos}} \;\equiv\; \mathbf{8.000\text{ Moedas do Jardim}}$$

### Cotações Unitárias Base:
* **🎣 Pesca:** $1\text{ kg de Peixe Comum} = 1,250\text{ Runas}$
* **💜 Waifus:** $1\text{ Zinthos} \approx 0,2857\text{ Runas}$
* **🌱 Jardim:** $1\text{ Moeda do Jardim} = 0,1250\text{ Runas}$

---

## 📅 3. Cotação Dinâmica com Rotação Diária (04:00 AM BRT)

Todos os dias às **04:00 AM (Horário de Brasília / 07:00 UTC)**, o scheduler do banco recalcula a cotação oficial do dia com base nos dados macroeconômicos reais das últimas 24 horas:

$$R_{\text{moeda}}(t) = R_{\text{moeda, base}} \times \Phi_{\text{mercado}}(t)$$

1. **Fator Waifus ($\Phi_{\text{zinthos}}$):** Indexado inversamente ao índice de inflação do Waifuletes ($I_M$):
   $$\Phi_{\text{zinthos}} = \frac{1}{I_M} = \frac{1}{1 + 0,5 \cdot \ln\left(\max\left(1, \frac{M_2}{4.000.000}\right)\right)}$$
   *Se a massa monetária de Zinthos aumentar (mais inflação), o Zinthos perde poder de compra frente à Runa.*
2. **Fator Pesca ($\Phi_{\text{pesca}}$):** Indexado à variação do peso de peixe comum circulante nos inventários.
3. **Fator Jardim ($\Phi_{\text{jardim}}$):** Indexado ao volume global de moedas registradas no Jardim das Sombras.

### 🛡️ Trava de Segurança (Circuit Breaker)
Para evitar choques especulativos e volatilidade excessiva, a variação da cotação de qualquer ativo é limitada a no máximo **$\pm 10\%$ por dia**:
$$R_{\text{novo}} = \text{clamp}\Big(R_{\text{novo}}, \; 0,90 \times R_{\text{ontem}}, \; 1,10 \times R_{\text{ontem}}\Big)$$

---

## 📈 4. Spread Dinâmico Progressivo (3% a 10%)

Em cada operação de câmbio (depósito ou saque), o banco retém uma taxa de spread que varia conforme a utilização da cota diária do usuário:

$$\text{Spread}(u) = 0,03 + 0,07 \times \left( \frac{\text{Volume Convertido Hoje}}{\text{Cota Diária Total}} \right)^{1,5}$$

* **Operações Iniciais (0% a 20% da cota):** Taxa quase mínima (~**3,0% a 3,6%**), beneficiando jogadores casuais.
* **Operações Moderadas (50% da cota):** Taxa média (~**5,5%**).
* **Operações no Teto (90% a 100% da cota):** Taxa máxima (**9,0% a 10,0%**), desencorajando dumping por acumuladores.
* **Destruição Deflacionária:** Todo o spread arrecadado pelo banco é **destruído permanentemente**, atuando como um poderoso sink monetário para combater a inflação dos jogos.

---

## 🎣 5. Venda de Peixes por Aproximação (Knapsack) & Regra de Mão Única

1. **Ponte de Mão Única (`Peixe ➔ Runas`):**  
   Peixes comuns podem ser vendidos para o banco para obter Runas. **Não é permitido converter Runas de volta em peixes**, protegendo a integridade dos rankings de pesca e as espécies raras de cada bioma.
2. **Blindagem Absoluta de Peixes Lendários:**  
   Peixes lendários/raros (`is_rare = 1`) são 100% ignorados pelo algoritmo bancário e **jamais são vendidos**.
3. **Algoritmo Knapsack (Arredondamento para Baixo):**  
   Como os peixes têm pesos individuais discretos (ex: 82,3kg, 71,4kg), ao solicitar uma venda por peso (ex: `!banco-depositar peixe 300`):
   * O banco seleciona o subconjunto de peixes comuns cuja soma seja $\le 300\text{ kg}$ e o mais próximo possível dessa meta (ex: 298,40 kg).
   * O peixe que estouraria a meta permanece intacto no inventário do jogador.
   * O usuário também pode usar `!banco-depositar peixe tudo` para liquidar todos os peixes comuns de uma vez (respeitando a cota diária).

---

## 🛡️ 6. Cotas Diárias de Câmbio (Anti-Exploit)

Cada jogador possui um limite máximo de conversão a cada 24 horas (renovado às 04:00 AM BRT):
* **🎣 Pesca:** até **1.500 kg** de peixe comum/dia.
* **💜 Waifus:** até **9.000 Zinthos**/dia.
* **🌱 Jardim:** até **30.000 Moedas do Jardim**/dia.

---

## 🔐 7. Comando `!banco-adm` & Sessões Deslizantes (Sliding Session)

Para acessar o painel de gerenciamento e câmbio pelo navegador:
* O comando `!banco-adm` gera um link pessoal seguro com token efémero: `https://site/ravenabank?token=...`
* **Sessão Deslizante:** A sessão permanece ativa por **3 dias sem acessar**. Cada novo acesso ou troca pelo navegador estende a validade por mais 3 dias automaticamente.
* **Botão de Logout:** Na interface web, o botão de logout encerra a sessão imediatamente no banco de dados.

---

## 💬 8. Comandos Disponíveis (Categoria: `ravenabank`)

| Comando | Aliases | Descrição |
| :--- | :--- | :--- |
| `!banco` | `!ravenabank`, `!saldo-banco` | Consulta saldo de Runas, patrimônio em todos os jogos e cotas diárias |
| `!banco-adm` | `!bancoadm`, `!banco-web` | Envia link seguro no PV para gerenciar conta e realizar trocas no navegador |
| `!economia` | `!banco-economia`, `!banco-cotacao`, `!cotacao` | Painel macroeconômico com cotações do dia, massa circulante e explicações |
| `!banco-depositar` | `!banco-dep`, `!banco-vender-peixe` | Deposita recursos de jogos no banco (`!banco-depositar peixe 300`, `!banco-depositar zinthos 1500`) |
| `!banco-sacar` | `!banco-saque` | Converte Runas em recursos (`!banco-sacar zinthos 100`, `!banco-sacar jardim 250`) |
| `!banco-extrato` | `!extrato-banco` | Lista as últimas movimentações e extrato bancário |

---

## 🌐 9. API REST & Web App

* **Endpoint Standalone:** `/ravenabank`
* **Ravena Desktop OS & Mobile:** Atalho nativo na área de trabalho e gaveta de aplicativos.
* **Endpoints REST na BotAPI:**
  * `GET /api/games/bank/public` — Métricas globais, cotações oficiais e estoque.
  * `GET /api/games/bank/session` — Validação e renovação da sessão deslizante.
  * `POST /api/games/bank/logout` — Revogação de sessão.
  * `POST /api/games/bank/trade` — Execução de depósitos e saques pelo navegador.

---

## 🎁 10. Normalização de Bônus e Prêmios Globais

Para proteger os subsistemas de inflação descontrolada, premiações e bônus monetários de outros jogos foram centralizados na moeda global **Runas ($ᚱ$)**:

1. **Apoio & Doações (`!doar-vantagens`)**:
   * O bônus financeiro concedido a apoiadores agora é de **50 Runas por R$ 1 doado** (creditadas diretamente na conta do banco).
   * O doador tem total liberdade de manter suas Runas valorizando no banco ou convertê-las em Zinthos ou Moedas do Jardim através de `!banco-sacar`.
2. **Caça-Níqueis (`!slots`)**:
   * Os tiers de vitória monetária que concediam Zinthos agora concedem **600 a 2.000 Runas (Tier 1)** e **1.600 a 3.000 Runas (Tier 2)** diretamente na conta do banco, juntamente com os tickets de waifu.
   * Evita a injeção inflacionária direta de Zinthos no ecossistema do Mudae.
3. **Pescaria (`!pescar`)**:
   * Não possui premiações financeiras de outros jogos (apenas fichas de fliperama para jogar no próprio `!slots`), mantendo sua rota de mão única de exportação de peixes para Runas intacta.
