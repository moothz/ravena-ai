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

## 🛡️ 6. Cotas Diárias de Câmbio (Reset às 04:00 AM)

Cada jogador possui limites diários de segurança que renovam todo dia às 04:00 AM BRT:
* **🛒 Compra com Runas:** até **15.000 ᚱ**/dia em moedas.
* **🎣 Venda de Peixes:** até **1.500 kg**/dia de peixe comum.
* **💜 Venda de Zinthos:** até **9.000 Z**/dia.
* **🌱 Venda de Petalitas:** até **30.000 Ptl**/dia.

---

## 🔐 7. Comando `!banco-adm` & Sessões Deslizantes (Sliding Session)

Para acessar o painel de gerenciamento e câmbio pelo navegador:
* O comando `!banco-adm` gera um link pessoal seguro com token: `https://site/ravenabank?token=...`
* **Sessão Deslizante:** A sessão permanece ativa por **3 dias sem acessar**. Cada novo acesso ou troca pelo navegador renova a validade por mais 3 dias automaticamente.
* **Botão de Logout:** Na interface web, o botão de logout encerra a sessão imediatamente no banco de dados.

---

## 💬 8. Comandos Disponíveis (Categoria: `ravenabank`)

| Comando | Aliases | Descrição |
| :--- | :--- | :--- |
| `!banco` | `!ravenabank`, `!saldo-banco` | Consulta saldo de Runas, patrimônio consolidado e cotas diárias |
| `!banco-adm` | `!bancoadm`, `!banco-web` | Envia link seguro no PV para gerenciar conta e realizar trocas no navegador |
| `!economia` | `!cotacao`, `!banco-economia` | Painel macroeconômico com cotações do dia, totais acumulados e explicações |
| `!banco-vender` | `!banco-depositar`, `!vender-peixe` | Vende recursos de jogos para receber Runas (`!banco-vender peixe 300`, `!banco-vender zinthos 1500`) |
| `!banco-comprar` | `!banco-sacar`, `!banco-resgatar` | Compra recursos de jogos usando Runas (`!banco-comprar zinthos 100`, `!banco-comprar jardim 250`) |
| `!banco-extrato` | `!extrato`, `!extrato-banco` | Lista as últimas movimentações e extrato bancário |

---

## 🌐 9. API REST & Web App

* **Endpoint Standalone:** `/ravenabank`
* **Ravena Desktop OS & Mobile:** Atalho nativo na área de trabalho e gaveta de aplicativos.
* **Endpoints REST na BotAPI:**
  * `GET /api/games/bank/public` — Métricas globais, cotações oficiais e estoque.
  * `GET /api/games/bank/session` — Validação e renovação da sessão deslizante.
  * `POST /api/games/bank/logout` — Revogação de sessão.
  * `POST /api/games/bank/trade` — Execução de vendas e compras pelo navegador.

---

## 🎁 10. Normalização de Bônus e Prêmios Globais

Para proteger os subsistemas de inflação descontrolada, premiações e bônus monetários de outros jogos foram centralizados na moeda global **Runas (💠 $ᚱ$)**:

1. **Apoio & Doações (`!doar-vantagens`)**:
   * O antigo bônus em Zinthos foi convertido para **50 Runas por R$ 1,00 doado**.
   * O doador tem total liberdade de manter suas Runas valorizando no banco ou utilizá-las para comprar Zinthos ou Petalitas através de `!banco-comprar`.
2. **Slots (`!slots`)**:
   * Prêmios de alto escalão pagam diretamente em Runas (600 ᚱ a 3.000 ᚱ).
3. **Pesca & Outros Jogos**:
   * Prêmios globais unificados em Runas.
