# Verificação — Lives pós-diagnóstico (29/09/2026 ~17:55)

Verificação do estado atual das lives dos grupos citados em `lives-diagnostico-original.md`
(livedofalcon, homurinhos, Pisnelinha) e do comportamento real das notificações.

Fontes: `logs/2026-09-29-stream-system.log` (+ cópia em `logs/history/2026-09-29/`),
`data/notified_streams_cache.json`, `core.db` (tabela `groups`, readonly) e
`GET https://api.twitch.tv/helix/streams` (app token). Horários dos logs em UTC;
aqui convertidos para -03:00.

---

## 1. Estado agora (consulta Helix, ~17:57)

| Canal | Estado | Live desde | Espectadores |
|---|---|---|---|
| zfaalcon | 🟢 ON | 15:41 | 3 |
| homuradoto | 🟢 ON | 13:02 | 20 |
| gabbyssxd | 🟢 ON | 13:02 | 7 |
| anynhageek | 🟢 ON | 08:16 | 10 |
| sucodepeido | 🔴 OFF | — | — |
| squirleytv | 🔴 OFF | — | — |
| manoellapis (Pisnelinha) | 🔴 OFF | — | — |

Nenhuma live dos três grupos terminou hoje → **não houve evento OFF pendente** para eles.

---

## 2. Notificações de hoje (29/09)

### livedofalcon — `120363429489619699@g.us` ✅ ONLINE ok
| Hora | Canal | Resultado |
|---|---|---|
| 13:02:40 | homuradoto | ✅ notificada via `ravenavip` (live começou 13:02:06 → ~34s) |
| 15:41:47 | zfaalcon | ✅ título → `ON 🟢 Live do Falcon` + notificação via `ravenavip` (~47s) |

### homurinhos — `120363411424206948@g.us` ✅ ONLINE ok
| Hora | Canal | Resultado |
|---|---|---|
| 21:14 (28/09) | Gabbyssxd | ✅ |
| 08:17:03 | AnynhaGeek | ✅ via `ravenavip` |
| 08:23:04 | AnynhaGeek (OFF) | ⚠️ nenhuma mensagem (ver §4) |
| 13:02:40 | homuradoto | ✅ |
| 13:03:09 | Gabbyssxd | ✅ via `ravena2` |
| 15:41:48 | zfaalcon | ✅ via `ravenavip` |

### Pisnelinha — `120363263778215164@g.us` ✅ saudável
- Nenhuma live hoje (manoellapis está OFF desde ontem).
- Última atividade real, em 27/09: **17:01 ONLINE ✅** (título → `💚 PISnelinha tá on! 👩🏽‍🦰`) e
  **19:41 OFFLINE ✅** (título → `PISnelinha 👩🏽‍🦰`), ambos com mídia e sem menções — exatamente o
  comportamento de referência citado no diagnóstico.

**Conclusão: todos os eventos ONLINE dos três grupos foram notificados, com latência de 30–50s.**
O que continua sem ser notificado é o **OFF** (causa: configuração, ver §4).

---

## 3. ⚠️ A correção do commit `d67c24a` NÃO está em produção

O container `ravena-ai` foi reiniciado às 17:54, mas continua rodando o código **anterior** ao commit:

| Evidência | Valor |
|---|---|
| Imagem em uso (`ravena-ai-ravena-ai`) | criada em **28/09 13:05** |
| `md5 /app/src/StreamSystem.js` no container | `84773e18…` = **HEAD~1** (HEAD é `1b519e74…`) |
| Novos WARN no container (`Sem mídia, title change…`, `Sem bots disponíveis…`, `Nenhuma notificação enviada…`) | **0 ocorrências** no arquivo e **0** no log do dia |
| `Management.js` no container | linha 7392 ainda com `channelConfig.mentionAllMembers = true` |

Motivo: `./src` está **comentado** nos volumes do `docker-compose.yml` (linha "Code mounts"),
então o código vem da imagem. `docker restart` / recriar container com a imagem velha não aplica a
correção — é preciso **build**.

Comando sugerido (executar manualmente):

```bash
make ravena-ai        # build da imagem + recria apenas o ravena-ai
```

> Observação: os `mentionAllMembers: false` que aparecem no banco para o livedofalcon vieram do
> toggle feito pelos admins, não do código novo.

---

## 4. Porque o OFF nunca chega nesses dois grupos (config, não bug)

Estado atual no banco:

| Grupo | Canal | changeTitleOnEvent | mentionAllMembers | on.media | off.media |
|---|---|---|---|---|---|
| livedofalcon | zfaalcon | `true` | `false` | 1 text | **`[]`** |
| livedofalcon | sucodepeido | `false` | `false` | 1 text | **`[]`** |
| livedofalcon | homuradoto | `false` | `false` | 1 text | **`[]`** |
| livedofalcon | SquirleyTV | `false` | `false` | 1 text | **`[]`** |
| homurinhos | homuradoto | `true` | **`true`** | 1 text | **`[]`** |
| homurinhos | zFaalcon | `false` | **`true`** | 1 text | **`[]`** |
| homurinhos | Gabbyssxd | `false` | **`true`** | 1 text | **`[]`** |
| homurinhos | SucoDePeido | `false` | **`true`** | 1 text | **`[]`** |
| homurinhos | AnynhaGeek | `false` | **`true`** | 1 text | **`[]`** |
| Pisnelinha | manoellapis | `true` | `undefined` (falsy) | 3 (text/sticker/image) | 1 image |

Consequências diretas:

1. **OFF silencioso**: `offConfig.media` vazio em 100% dos canais dos dois grupos → nenhum
   ReturnMessage é gerado. Só muda o título (e só nos canais com `changeTitleOnEvent: true`).
   É o "não notifica off" relatado. Ajuste: configurar mídia de OFF via gerenciamento.
2. **Título não muda quando é o "outro" canal que está no ar**: no livedofalcon só
   `zfaalcon` tem `changeTitleOnEvent`, por isso às 13:02 (homuradoto ON) o título permaneceu
   `OFF 🔴Live do Falcon` (registrado às 13:05 como "Título já está correto"). No homurinhos só
   `homuradoto` tem. Necessário ativar por canal.
3. **homurinhos ainda marca todos**: `mentionAllMembers: true` nos 5 canais. Está correto
   conforme configurado, mas, enquanto o build novo não entrar, o toggle continua com default
   antigo (`undefined` → `true`), que foi a causa original de ativações acidentais.

---

## 5. Novo bug encontrado (fora do escopo do diagnóstico anterior)

`17:42:11` (20:42:11Z) — evento OFF de `twitch/balonesbr` no grupo Sofadobalonesbr
(`5512974036846-1594417283@g.us`):

```
[ERROR] [stream-system] Erro ao alterar título/foto do grupo ... via bot ravena5:
TypeError: Cannot read properties of undefined (reading 'replace')
    at StreamSystem.changeGroupTitleForStream (src/StreamSystem.js:749)
    at async StreamSystem.processStreamEvent (src/StreamSystem.js:485)
```

`chat.name` veio `undefined` para o bot `ravena5` (único bot realmente no grupo); os outros 3 bots
retornam "não está no grupo". Resultado: **a notificação de OFF não foi enviada** e nenhum WARN foi
registrado.

Correção sugerida em `changeGroupTitleForStream`, antes do replace:

```js
newTitle = chat.name;
if (typeof newTitle !== "string" || !newTitle) {
    this.logger.warn(`[changeGroupTitleForStream] Título atual indisponível para ${group.id} via ${bot.id}`);
    return false;
}
```

(considerar fallback para `group.titulo`).

---

## 6. Outros pontos observados

- **Janela sem monitoramento a cada restart**: o `StreamSystem` só inicializa 3 minutos após o
  boot. Hoje houve reinícios às ~17:52 e 17:54 e o monitor voltou apenas às 17:57. Nessa janela o
  monitor não detecta eventos; ao subir, ele re-emite os canais que estão no ar, com o failsafe de
  duplicidade funcionando (`Suppressing duplicate streamOnline ... twitch:zfaalcon`, 17:57:30 ✅).
- **Timeouts na API da Twitch**: 2 falhas de batch hoje (`17:50` e `18:01`,
  `Error polling Twitch batch 3 (80 channels) ... timeout of 10000ms exceeded`), que aumentam a
  latência de detecção dos canais daquele batch. Erros salvos em
  `data/errors-debug/twitch-batch3-errors.json`.
- Nenhum registro dos novos WARN hoje (0 ocorrências) — coerente com o §3: o código novo não está
  rodando, e não com "nenhum caso aconteceu" (houve pelo menos 1 OFF silencioso às 08:23 no
  homurinhos e 1 às 17:42 no Sofadobalonesbr que ficariam visíveis com os logs novos).

---

## 7. Próximos passos

1. **`make ravena-ai`** (build) — sem isso nada do commit `d67c24a` vale. *(ação do usuário)*
2. Configurar `offConfig.media` nos canais de livedofalcon e homurinhos (ou aceitar que o OFF só
   troca título).
3. Decidir com os admins: ativar `changeTitleOnEvent` nos canais que também devem mudar o título
   (livedofalcon: homuradoto/sucodepeido/SquirleyTV — o título é único, então faria sentido apenas
   para o canal "principal" do grupo).
4. Ajustar o `TypeError` de `changeGroupTitleForStream` (§5).
5. Revisar `mentionAllMembers: true` nos 5 canais do homurinhos com o admin.
