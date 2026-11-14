#!/usr/bin/env python3
"""quem-e — identifica, localmente, a qual usuário/grupo corresponde um `*.id_hash` dos traces.

USO RESTRITO: só operador autorizado, na máquina que roda o bot. O resultado (ID, nome) é dado
pessoal: não cole em issue, chat ou log público. O salt NUNCA é impresso.

Os spans não carregam ID cru. Eles carregam
  usuário: HMAC-SHA256(OTEL_ID_SALT, ID sem sufixo)  → 16 hex   (ravena.user.id_hash, waifu.user.id_hash, jds.user.id_hash…)
  grupo:   HMAC-SHA256(OTEL_ID_SALT, ID completo)    → 16 hex   (ravena.chat.id_hash, waifu.group.id_hash)
"ID sem sufixo" = ID cortado no primeiro "@" e no primeiro ":"  (5511…@c.us, 5511…:3@s.whatsapp.net, 123…@lid → só o número).

Exemplos (a partir da raiz do repo ravena-ai):
  python3 observability/tools/quem-e.py 3fa9c1d2e4b5a6f7            # hash → ID (+ nome, se houver)
  python3 observability/tools/quem-e.py --id 5511999990000@c.us      # ID → hashes + links do Jaeger
  python3 observability/tools/quem-e.py --id 120363000000000@g.us --grupo
  python3 observability/tools/quem-e.py <hash> --sem-docker          # só os SQLite locais da ravena

De onde vem o salt (nessa ordem): variável de ambiente OTEL_ID_SALT; arquivo --env (padrão: .env
na raiz do repo ravena-ai). Onde procura candidatos: todos os SQLite em data/sqlites da ravena
(somente leitura) e, se o Docker estiver disponível, as tabelas de usuários/grupos do waifuletes
(container waifuletes-db) e de jogadores do Jardim (container jardim-db), via `docker exec psql`.
Sem dependências além do Python 3 padrão.
"""
import argparse
import glob
import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.parse

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ID_RE = re.compile(r"^-?\d{5,}(:\d+)?(@(c\.us|g\.us|lid|s\.whatsapp\.net|broadcast|newsletter))?$")
NAME_COLS = re.compile(r"(^|_)(name|nome|nick|nickname|apelido|pushname|titulo|author_name|player_name|group_name)$", re.I)
JAEGER = os.environ.get("JAEGER_URL", "http://localhost:16686")

USER_TAGS = [
    ("ravena-ai", "ravena.user.id_hash"),
    ("ravena-ai", "ravena.from_user.id_hash"),  # /api/market/transfer: quem paga
    ("ravena-ai", "ravena.to_user.id_hash"),    # /api/market/transfer: quem recebe
    ("waifuletes", "waifu.user.id_hash"),
    ("waifuletes", "waifu.buyer.id_hash"),      # mercado: comprador
    ("waifuletes", "waifu.seller.id_hash"),     # mercado: vendedor
    ("jardim-das-sombras", "jds.user.id_hash"),
    ("jardim-das-sombras", "jds.from_user.id_hash"),
    ("jardim-das-sombras", "jds.to_user.id_hash"),
]
GROUP_TAGS = [("ravena-ai", "ravena.chat.id_hash"), ("waifuletes", "waifu.group.id_hash")]
GROUPISH = re.compile(r"group|grupo|chat|canal", re.I)


def load_salt(env_file):
    salt = os.environ.get("OTEL_ID_SALT")
    if not salt and os.path.exists(env_file):
        with open(env_file, encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("OTEL_ID_SALT="):
                    salt = line.split("=", 1)[1].split(" #")[0].strip().strip("\"'")
    if not salt:
        sys.exit("OTEL_ID_SALT não encontrado (defina a variável ou use --env <arquivo .env>). "
                 "Sem o salt dos serviços não há como recomputar os hashes.")
    return salt


def normalize_user(raw):
    return str(raw).split("@")[0].split(":")[0]


def hmac16(salt, value):
    return hmac.new(salt.encode(), str(value).encode(), hashlib.sha256).hexdigest()[:16]


def jaeger_link(service, tag, value):
    import time
    end = int(time.time() * 1_000_000)
    start = end - 7 * 24 * 3600 * 1_000_000  # 7 dias = retenção padrão
    q = {"service": service, "start": str(start), "end": str(end), "lookback": "custom", "limit": "50",
         "tags": json.dumps({tag: value})}
    return f"{JAEGER}/search?{urllib.parse.urlencode(q)}"


# ── fontes de candidatos ──────────────────────────────────────────────────────────────────────
def sqlite_candidates(data_dir):
    """Varre todos os SQLite (somente leitura). Devolve {id: [(origem, nome|None), ...]}."""
    found = {}
    for path in sorted(glob.glob(os.path.join(data_dir, "*.db"))):
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        except sqlite3.Error:
            continue
        try:
            tables = [r[0] for r in conn.execute("select name from sqlite_master where type='table'")]
            for t in tables:
                cols = [r[1] for r in conn.execute(f'pragma table_info("{t}")')]
                name_cols = [c for c in cols if NAME_COLS.search(c)]
                for c in cols:
                    if NAME_COLS.search(c):
                        continue
                    try:
                        sel = ", ".join([f'"{c}"'] + [f'"{n}"' for n in name_cols[:2]])
                        for row in conn.execute(f'select distinct {sel} from "{t}" limit 200000'):
                            v = row[0]
                            if v is None:
                                continue
                            v = str(v).strip()
                            if not ID_RE.match(v):
                                continue
                            nome = next((str(x) for x in row[1:] if x), None)
                            found.setdefault(v, []).append((f"ravena:{os.path.basename(path)}:{t}.{c}", nome))
                    except sqlite3.Error:
                        continue
        except sqlite3.Error:
            pass
        finally:
            conn.close()
    return found


def docker_psql(container, sql):
    try:
        user = subprocess.run(["docker", "exec", container, "printenv", "POSTGRES_USER"], capture_output=True, text=True, timeout=10).stdout.strip()
        db = subprocess.run(["docker", "exec", container, "printenv", "POSTGRES_DB"], capture_output=True, text=True, timeout=10).stdout.strip()
        if not user or not db:
            return []
        out = subprocess.run(["docker", "exec", container, "psql", "-U", user, "-d", db, "-At", "-F", "\t", "-c", sql],
                             capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            return []
        return [line.split("\t") for line in out.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.SubprocessError):
        return []


def service_candidates():
    found = {}
    for row in docker_psql("waifuletes-db", "select id, name from users"):
        found.setdefault(row[0], []).append(("waifuletes:users", row[1] if len(row) > 1 else None))
    for row in docker_psql("waifuletes-db", "select id, name from groups"):
        found.setdefault(row[0], []).append(("waifuletes:groups", row[1] if len(row) > 1 else None))
    for row in docker_psql("jardim-db", "select id, coalesce(player_name, farm_name) from players"):
        found.setdefault(row[0], []).append(("jardim:players", row[1] if len(row) > 1 else None))
    return found


# ── modos ─────────────────────────────────────────────────────────────────────────────────────
def find_hash(salt, target, use_docker, data_dir, extra=()):
    target = target.lower().strip()
    if not re.fullmatch(r"[0-9a-f]{16}", target):
        sys.exit("hash inválido: esperado 16 caracteres hexadecimais (ex.: valor de ravena.user.id_hash)")
    cands = sqlite_candidates(data_dir)
    if use_docker:
        for k, v in service_candidates().items():
            cands.setdefault(k, []).extend(v)
    for raw in extra:
        cands.setdefault(raw, []).append(("--candidatos", None))
    hits = {}
    for raw, origins in cands.items():
        norm = normalize_user(raw)
        forms = [("usuário", norm)] if norm == raw else [("usuário", norm), ("grupo/chat", raw)]
        # hash legado (traces de antes da unificação): ID com sufixo do WhatsApp
        if norm.lstrip("-").isdigit():
            forms += [("usuário (hash legado ou chat PV)", norm + suf) for suf in ("@c.us", "@s.whatsapp.net", "@lid") if norm + suf != raw]
        for kind, form in forms:
            if hmac16(salt, form) == target:
                hits.setdefault((kind, form), []).extend(origins)
    if not hits:
        print(f"Nenhum dos {len(cands)} IDs conhecidos bate com {target}.")
        print("Se você suspeita de um ID específico, teste com:  quem-e.py --id <ID>")
        return 1
    for (kind, form), origins in hits.items():
        # nome de grupo (tabelas/colunas de grupo/chat) não é apelido de usuário, e vice-versa
        if kind == "usuário":
            nomes = sorted({n for o, n in origins if n and not GROUPISH.search(o)})
            grupos = sorted({n for o, n in origins if n and GROUPISH.search(o)})
        else:
            nomes = sorted({n for o, n in origins if n and GROUPISH.search(o)}) or sorted({n for _, n in origins if n})
            grupos = []
        print(f"{target}  →  {kind}: {form}")
        if nomes:
            print(f"  nome(s) conhecido(s): {', '.join(nomes[:5])}")
        if grupos:
            print(f"  aparece em grupo(s)/chat(s) com nome: {', '.join(grupos[:3])}")
        print(f"  encontrado em: {', '.join(sorted({o for o, _ in origins})[:6])}")
    return 0


def show_id(salt, raw, force_group):
    raw = raw.strip()
    is_group = force_group or bool(re.search(r"@g\.us$", raw)) or raw.startswith("-")
    uh = hmac16(salt, normalize_user(raw))
    gh = hmac16(salt, raw)
    if not is_group:
        print(f"usuário {normalize_user(raw)}  →  id_hash {uh}")
        for svc, tag in USER_TAGS:
            print(f"  {svc:<20} {tag:<26} {jaeger_link(svc, tag, uh)}")
        if gh != uh:
            print(f"  (traces antigos, de antes da unificação do hash de usuário em 14/11/2026, podem ter usado {gh})")
    print(f"{'grupo/chat' if is_group else 'como chat (PV)'} {raw}  →  id_hash {gh}")
    for svc, tag in GROUP_TAGS:
        print(f"  {svc:<20} {tag:<26} {jaeger_link(svc, tag, gh)}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Identifica usuários/grupos a partir dos *.id_hash dos traces (uso local e restrito).")
    ap.add_argument("hash", nargs="?", help="valor de *.id_hash (16 hex)")
    ap.add_argument("--id", help="caminho inverso: ID → hashes e links do Jaeger")
    ap.add_argument("--grupo", action="store_true", help="com --id: trata o ID como grupo/chat")
    ap.add_argument("--env", default=os.path.join(REPO, ".env"), help="arquivo .env com OTEL_ID_SALT (padrão: .env da ravena)")
    ap.add_argument("--dados", default=os.path.join(REPO, "data", "sqlites"), help="pasta dos SQLite da ravena")
    ap.add_argument("--sem-docker", action="store_true", help="não consulta waifuletes/Jardim via docker exec")
    ap.add_argument("--candidatos", help="arquivo com IDs extras a testar, um por linha (ex.: exportados de outra base); '-' = stdin")
    a = ap.parse_args()
    if not a.hash and not a.id:
        ap.print_help()
        return 2
    salt = load_salt(a.env)
    if a.id:
        return show_id(salt, a.id, a.grupo)
    extra = []
    if a.candidatos:
        fh = sys.stdin if a.candidatos == "-" else open(a.candidatos, encoding="utf-8", errors="ignore")
        extra = [line.strip() for line in fh if line.strip()]
    return find_hash(salt, a.hash, not a.sem_docker, a.dados, extra)


if __name__ == "__main__":
    sys.exit(main())
