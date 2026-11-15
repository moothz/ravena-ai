#!/usr/bin/env python3
"""
economy_simulation.py

Simulador da Economia Integrada: Ravena-AI (Pesca, Slots, Banco), Waifuletes e Jardim das Sombras.
Calcula o Valor Esperado (EV), rendimento diário e projeções temporais (1, 7, 15, 30, 60 dias)
para diferentes níveis de aproveitamento de cooldowns (100%, 80%, 60%, 50%).

Uso:
  python3 scripts/economy_simulation.py
"""

import os
import sqlite3
import json

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
BANK_DB_PATH = os.path.join(REPO_ROOT, "data", "sqlites", "bank.db")

# Taxas base padrão
BASE_RUNAS_PER_KG_FISH = 1.2500
BASE_RUNAS_PER_ZINTHOS = 1000 / 3500  # ~0.2857
BASE_RUNAS_PER_JARDIM = 0.1250

# Tenta carregar taxas dinâmicas reais do banco SQLite mais recente
curr_rates = {
    "runas_per_kg_fish": BASE_RUNAS_PER_KG_FISH,
    "runas_per_zinthos": 0.1699,
    "runas_per_jardim": 0.1235,
    "quota_compra_zinthos": 525000,
    "quota_compra_jardim": 307500,
    "date": "hoje"
}

if os.path.exists(BANK_DB_PATH):
    try:
        conn = sqlite3.connect(BANK_DB_PATH)
        c = conn.cursor()
        c.execute("""
            SELECT date, runas_per_kg_fish, runas_per_zinthos, runas_per_jardim_coin, 
                   quota_compra_zinthos, quota_compra_jardim 
            FROM bank_daily_rates ORDER BY date DESC LIMIT 1
        """)
        row = c.fetchone()
        if row:
            curr_rates["date"] = row[0]
            curr_rates["runas_per_kg_fish"] = float(row[1])
            curr_rates["runas_per_zinthos"] = float(row[2])
            curr_rates["runas_per_jardim"] = float(row[3])
            curr_rates["quota_compra_zinthos"] = float(row[4])
            curr_rates["quota_compra_jardim"] = float(row[5])
        conn.close()
    except Exception as e:
        pass

# Constantes de Jogos
# Pesca
NET_BAIT_PER_THROW = 0.89
FISH_KG_PER_THROW = 0.84 * 45.0  # 37.8 kg
RUNAS_CARTEIRA_PER_THROW = 0.04 * 275.0  # 11.0 Runas
SLOTS_COINS_PER_THROW = 0.04 * 3.0  # 0.12 moedas

# Slots
WIN_MULT = 1.4
P_WIN = 0.01
P_PARTIAL = 0.27
PARTIAL_RATE = 0.075

ev_win_coins = (20/110) * 45.0 * WIN_MULT
ev_win_baits = ((20/110) * 15.0 + (15/110) * 32.5) * WIN_MULT
ev_win_ptl = (20/110) * 1400.0 * WIN_MULT
ev_win_runas = ((15/110) * 1300.0 + (10/110) * 2300.0) * WIN_MULT
ev_win_tickets = ((15/110) * 3.0 + (10/110) * 5.0) * WIN_MULT

ev_part_coins = (20/110) * 45.0 * PARTIAL_RATE
ev_part_baits = ((20/110) * 15.0 + (15/110) * 32.5) * PARTIAL_RATE
ev_part_ptl = (20/110) * 1400.0 * PARTIAL_RATE
ev_part_runas = ((15/110) * 1300.0 + (10/110) * 2300.0) * PARTIAL_RATE

spin_runas = P_WIN * ev_win_runas + P_PARTIAL * ev_part_runas
spin_ptl = P_WIN * ev_win_ptl + P_PARTIAL * ev_part_ptl
spin_baits = P_WIN * ev_win_baits + P_PARTIAL * ev_part_baits
spin_coins_back = P_WIN * ev_win_coins + P_PARTIAL * ev_part_coins
spin_tickets = P_WIN * ev_win_tickets

net_coin_cost_per_spin = 1.0 - spin_coins_back
spins_per_regen_coin = 1.0 / net_coin_cost_per_spin

ev_coin_runas = spins_per_regen_coin * spin_runas
ev_coin_ptl = spins_per_regen_coin * spin_ptl
ev_coin_baits = spins_per_regen_coin * spin_baits
ev_coin_tickets = spins_per_regen_coin * spin_tickets

# Fazenda
FARM_BASE_PTL = 23400.0
FARM_WAIFU_TICKETS = 16.0

# Waifuletes
DAILY_KAKERA = 675.0
KAKERA_PER_ROLL = 0.25 * 50.0  # 12.5 Zinthos / roll
DAILY_DIVORCE_ZINTHOS = 2195.0

def run_simulation():
    efficiencies = [1.0, 0.8, 0.6, 0.5]
    days_list = [1, 7, 15, 30, 60]

    print("================================================================================")
    print(" 🏛️ SIMULAÇÃO ECONÔMICA: RAVENA-AI, WAIFULETES & JARDIM DAS SOMBRAS")
    print(f" Cotação Ativa: {curr_rates['date']} | 1 kg Peixe = {curr_rates['runas_per_kg_fish']:.4f} ᚱ | 1 Z = {curr_rates['runas_per_zinthos']:.4f} ᚱ | 1 Ptl = {curr_rates['runas_per_jardim']:.4f} ᚱ")
    print("================================================================================\n")

    for eff in efficiencies:
        eff_pct = int(eff * 100)
        slots_coins = 720.0 * eff
        slots_runas = slots_coins * ev_coin_runas
        slots_ptl = slots_coins * ev_coin_ptl
        slots_baits = slots_coins * ev_coin_baits
        slots_tickets = slots_coins * ev_coin_tickets

        nat_baits = 24.0 * eff
        nat_throws = nat_baits / NET_BAIT_PER_THROW
        nat_fish_kg = nat_throws * FISH_KG_PER_THROW
        nat_fish_runas = nat_fish_kg * curr_rates["runas_per_kg_fish"] * 0.97
        nat_carteira_runas = nat_throws * RUNAS_CARTEIRA_PER_THROW
        nat_pesca_total_runas = nat_fish_runas + nat_carteira_runas

        extra_throws = slots_baits / NET_BAIT_PER_THROW
        extra_fish_kg = extra_throws * FISH_KG_PER_THROW
        extra_fish_runas = extra_fish_kg * curr_rates["runas_per_kg_fish"] * 0.96
        extra_carteira_runas = extra_throws * RUNAS_CARTEIRA_PER_THROW
        extra_pesca_runas = extra_fish_runas + extra_carteira_runas

        farm_ptl = (FARM_BASE_PTL * eff) + slots_ptl
        farm_tickets = FARM_WAIFU_TICKETS * eff
        ptl_sold = farm_ptl * 0.75
        ptl_sold_runas = ptl_sold * curr_rates["runas_per_jardim"] * 0.96

        natural_rolls = 288.0 * eff
        total_rolls = natural_rolls + farm_tickets + slots_tickets
        roll_zinthos = total_rolls * KAKERA_PER_ROLL
        native_zinthos = (DAILY_KAKERA * eff) + roll_zinthos + (DAILY_DIVORCE_ZINTHOS * eff)

        runas_cenario_1 = slots_runas + nat_pesca_total_runas + ptl_sold_runas
        zinthos_bought_c1 = (runas_cenario_1 / curr_rates["runas_per_zinthos"]) * 0.955
        total_zinthos_c1 = native_zinthos + zinthos_bought_c1

        runas_cenario_2 = runas_cenario_1 + extra_pesca_runas
        zinthos_bought_c2 = (runas_cenario_2 / curr_rates["runas_per_zinthos"]) * 0.95
        total_zinthos_c2 = native_zinthos + zinthos_bought_c2

        print(f"### Aproveitamento: {eff_pct}%")
        print(f"• Rolls/dia: {total_rolls:.1f} | Zinthos Nativo/dia: {native_zinthos:,.0f} Z | Petalitas/dia: {farm_ptl:,.0f} Ptl")
        print(f"• Runas Geradas/dia: {runas_cenario_1:,.0f} ᚱ (Padrão) | {runas_cenario_2:,.0f} ᚱ (Sinergia Total)")
        print(f"• Zinthos Total/dia: {total_zinthos_c1:,.0f} Z (Padrão) | {total_zinthos_c2:,.0f} Z (Sinergia Total)\n")

        print("| Período | Zinthos (Padrão) | Zinthos (Sinergia) | Runas (Padrão) | Runas (Sinergia) | Petalitas Geradas |")
        print("| :--- | :--- | :--- | :--- | :--- | :--- |")
        for days in days_list:
            print(f"| **{days} dia(s)** | **{total_zinthos_c1*days:,.0f} Z** | **{total_zinthos_c2*days:,.0f} Z** | {runas_cenario_1*days:,.0f} ᚱ | {runas_cenario_2*days:,.0f} ᚱ | {farm_ptl*days:,.0f} Ptl |")
        print("\n" + "-"*75 + "\n")

if __name__ == "__main__":
    run_simulation()
