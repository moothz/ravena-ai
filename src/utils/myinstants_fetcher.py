#!/usr/bin/env python3
"""
myinstants_fetcher.py

Script utilitário para realizar requisições HTTP ao site MyInstants,
contornando o bloqueio de TLS Fingerprinting (JA4) do Cloudflare que
rejeita requisições do Node.js v20.
"""

import sys
import urllib.request
import urllib.error

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"
)

def fetch(url: str, timeout: int = 15) -> int:
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "*/*",
        "Referer": "https://www.myinstants.com/"
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
            sys.stdout.buffer.write(data)
            return 0
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 4
        return e.code if 0 < e.code < 256 else 1
    except Exception:
        return 1

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(2)
    sys.exit(fetch(sys.argv[1]))
