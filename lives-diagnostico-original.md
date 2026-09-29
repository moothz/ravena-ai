# Diagnóstico — Notificações de Streams (Twitch)

## Problema Reportado

Os administradores dos grupos **livedofalcon** e **homurinhos** relataram problemas com as notificações da Twitch:

1. Nem sempre notifica on/off do stream (e não muda o título da sala)
2. Mesmo com a opção "Marcar todos" desmarcada, o bot ainda menciona todos do grupo (`@everyone`)
3. O comando `!live` também marca todos do grupo (o que não deveria)

Por contraste, o grupo **Pisnelinha** funciona perfeitamente: notifica on/off, envia mídias, troca o título e não marca ninguém.

---

## Análise

### Diagnóstico dos Grupos (via banco de dados SQLite)

| Grupo | mentionAllMembers | changeTitleOnEvent | offConfig.media | onConfig.media |
|---|---|---|---|---|
| **livedofalcon** | `false` | `true` | `[]` (vazio) | `[imagem]` |
| **homurinhos** | `true` | `false` | `[]` (vazio) | `[imagem]` |
| **Pisnelinha** | `undefined` (falsy) | `true` | `[imagem]` | `[imagem]` |

### Resultados

| Problema | Causa Raiz |
|---|---|
| `homurinhos` marca todos | Configura com `mentionAllMembers: true` explicitamente no DB — o comportamento está **correto conforme configurado** |
| `livedofalcon` não notifica on/off | `offConfig.media` está vazio (`[]`). Quando não há mídia e `changeTitleOnEvent` é `false` ou o título já está igual, a notificação era retornada silenciosamente, sem log |
| `homurinhos` não muda título | `changeTitleOnEvent: false` — comportamento conforme configurado |
| `!live` marca todos | Na verdade, o comando `!live` **não marca ninguém** — as menções que os usuários veem vêm das notificações automáticas de stream on/off disparadas pelo `StreamMonitor`, não do comando em si |
| Canais novos sem default | Novos canais criados via CLI não tinham `mentionAllMembers` definido, e o toggle de configuração default `undefined` para `true`, causando menções acidentais |

---

## Correções Aplicadas

### 1. Default explícito `mentionAllMembers: false` (Management.js)
Adicionado em todas as funções de criação de canais (`addTwitchChannel`, `addKickChannel`, `addYouTubeChannel`):
```js
mentionAllMembers: false
```
Isso garante que novos canais nunca acidentalmente marquem todos os membros do grupo.

### 2. Correção do toggle (Management.js)
Mudado de `true` para `false`:
```js
if (channelConfig.mentionAllMembers === undefined) {
    channelConfig.mentionAllMembers = false;  // antes: true
}
```

### 3. Logs detalhados no processStreamEvent (StreamSystem.js)
Adicionados logs de observabilidade para diagnosticar futuros eventos:
- **WARN** quando não há bots disponíveis no grupo
- **WARN** quando não há mídia, title change nem IA (explica skips)
- **INFO** ao processar evento com sucesso
- **WARN fallback** ao tentar enviar mensagem mas `!sentSuccess`

### 4. Arquivo analisado — sem alterações (StreamCommands.js)
O arquivo foi inspecionado para confirmar que o comando `!live` não aciona notificações nem menções — apenas consulta o status da stream e atualiza os títulos dos grupos.

---

## Arquivos Modificados

| Arquivo | Alteração |
|---|---|
| `src/StreamSystem.js` | Adição de logs WARN/INFO no `processStreamEvent` |
| `src/commands/Management.js` | Default `mentionAllMembers: false` + correção do toggle |

---

## Commit

```
d67c24a feat(stream): corrigir notificações Twitch — defaults seguros e logs detalhados
```

---

## Próximos Passos

1. **Reiniciar o container** (`docker restart ravena-ai`) para aplicar as mudanças
2. **Monitorar os logs** dos próximos eventos de stream no `livedofalcon` para verificar se os logs detalhados capturam o motivo dos skips
3. **Comunicar ao admin do homurinhos** que o grupo está configurado com `mentionAllMembers: true` — se desejar desativar, usar o toggle correspondente
4. **Preencher `offConfig.media` do livedofalcon** se quiser que notificações off também enviem mídia (atualmente está vazio)
