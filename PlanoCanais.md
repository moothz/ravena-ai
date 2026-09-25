# Canais genéricos — viabilidade e desenho

A proposta é viável. Horóscopo e MuNews já provam que postagem de canal chega no `EventHandler` (`message.isNewsletter`) e pode ser gravada. O que falta é tornar isso cadastrável por grupo, com mídia e sem duplicar arquivo.

Horóscopo e MuNews continuam como estão. O sistema novo é paralelo e só grava canais que algum grupo cadastrou.

## O que já existe

- `EventHandler` (por volta da linha 320) vê `message.isNewsletter`, chama `MuNewsCommands.detectNews` e `HoroscopoCommands.detectHoroscopo` só com o texto, e retorna. Não baixa mídia.
- O formatador em `WhatsAppBotGo` já classifica texto, imagem, vídeo, áudio, sticker e documento, e baixa sob demanda com `downloadMedia()` → `POST /message/downloadmedia` → `client.Download`. Isso vale para mídia de canal (não é E2E).
- whatsmeow já tem:
  - `GetNewsletterInfoWithInvite`: aceita o link inteiro `https://whatsapp.com/channel/0029VbANSmKEgGfFVs1NtU0I` ou só o código. Devolve `NewsletterMetadata.ID` (`…@newsletter`), nome, descrição e invite.
  - `FollowNewsletter` / `UnfollowNewsletter`: seguir de verdade, persiste na conta.
  - `GetNewsletterMessages`: histórico recente (count + before).
- A rota Go `POST /newsletter/link` já chama o resolve do invite. O campo é `key`. O middleware olha `newsletterId` só se ele vier no JSON, então o `key` passa.
- `POST /newsletter/subscribe` **não serve**. Ele chama `NewsletterSubscribeLiveUpdates`, que é inscrição temporária (devolve uma duração) e não é o “seguir” do WhatsApp.
- Comandos em `src/functions/*.js` entram sozinhos pelo `FixedCommands`. Categoria nova entra em `CATEGORY_EMOJIS` (`src/functions/MenuOrder.js`).
- Alias de grupo já funciona: `{cmd-canal-rnd canalCarros}` vira o comando `canal-rnd` com argumento `canalCarros`.

O código do link **não é** o JID. Não dá para extrair `…@newsletter` offline. `canal-seguir` precisa chamar a API na conta do bot que está no grupo.

## Desenho recomendado

### Banco `canais.db` (SQLite, mesmo padrão de `munews` / `horoscopo`)

Três tabelas. Postagem e arquivo são do canal, não do grupo.

- `canais`: `jid` PK, `invite`, `link`, `nome_oficial`, `descricao`
- `canal_grupos`: `group_id`, `canal_jid`, `apelido`, `tipos_midia` (JSON; `null` = todos), `criado_por`, `criado_em`
  - único por `(group_id, canal_jid)` e por `(group_id, apelido normalizado)`
- `canal_posts`: `canal_jid`, `msg_id`, `ts`, `dia` (`YYYY-MM-DD` em `America/Sao_Paulo`), `tipo`, `texto` (corpo ou legenda), `arquivo`, `mimetype`
  - PK `(canal_jid, msg_id)` → `INSERT OR IGNORE`

Arquivos em `data/media/canais/<jid>/<msgId>.<ext>`. Texto fica só no SQLite. O download temporário de `public/attachments` (apagado em 10 min) é copiado para essa pasta na hora em que a postagem chega. URL de mídia do WhatsApp expira; não dá para baixar depois no `canal-ver`.

### Quem segue na conta WhatsApp

O bot que recebeu o comando no grupo chama `FollowNewsletter`. Se outro grupo, em outra instância, seguir o mesmo canal, aquela instância também segue. A linha da postagem e o arquivo continuam um só.

`canal-del` tira só a inscrição daquele grupo. A conta dá `UnfollowNewsletter` apenas quando nenhum grupo daquela instância ainda segue o canal. Arquivos permanecem, como pedido.

No boot, cada instância confere a lista de canais que seus grupos seguem e segue de novo o que faltar.

### API Go (precisa de rebuild do container, pedido ao usuário na hora de implementar)

- `POST /newsletter/follow` `{ "jid": "…@newsletter" }` → `FollowNewsletter`
- `POST /newsletter/unfollow` → `UnfollowNewsletter`
- Cliente em `WhatsgoApiClient` / `WhatsAppBotGo`

`/newsletter/link` com `{ "key": "<link ou código>" }` resolve o JID. Sem endpoint novo para isso.

### Captura

No bloco de newsletter do `EventHandler`, depois de MuNews e Horóscopo:

- se `message.from` não for um canal cadastrado, ignora (não gravar horóscopo/MuNews/outros canais que a conta já segue)
- senão grava a postagem, baixa mídia na hora, deduplica pelo `msg_id`
- edição com o mesmo id: fica a primeira versão
- tipo desconhecido (álbum, enquete, visualização única): guarda o texto se houver e registra o tipo no log, sem quebrar

Dia da postagem: meia-noite de Brasília. A virada das 06:00 é específica da MuNews e não entra aqui.

### Comandos (categoria `canais`)

Arquivo novo `src/functions/CanaisCommands.js`.

| Comando | Quem | Comportamento |
|---|---|---|
| `canal-seguir <nome> <link>` | admin do grupo | Nome = texto entre o comando e o link (pode ter espaços). Link `whatsapp.com/channel/…` (com ou sem `https://` e `www`). Rejeita `chat.whatsapp.com` (convite de grupo). Nome vazio usa o nome oficial. Mesmo canal no grupo: avisa o apelido que já existe. Apelido repetido: erro. |
| `canal-lista` | qualquer um | Apelido, nome oficial, link e tipos de mídia daquele grupo |
| `canal-del <nome>` | admin | Remove a inscrição do grupo. Não apaga arquivo |
| `canal-ver <nome> [data]` | qualquer um | Data no padrão MuNews: `hoje`, `ontem`, `19/04/2025`, `YYYY-MM-DD`, “segunda passada” (chrono). Sem data = hoje |
| `canal-midias <nome> [tipos]` | admin | Sem tipos: captura todos e manda o texto de ajuda. Com tipos: substitui a lista. Aceita `,`, `, ` e ` , ` |
| `canal-rnd <nome> [tipos]` | qualquer um | Uma postagem aleatória. Tipos do comando, se vierem, cruzam com o filtro do grupo |

Só funciona em grupo.

Apelido comparado sem diferenciar maiúsculas. No sucesso de `canal-seguir`, a resposta lista `canal-lista`, `canal-del`, `canal-ver`, `canal-midias`, `canal-rnd` e o exemplo:

`!g-addCmd carros {cmd-canal-rnd canalCarros}`

### Agrupamento proposto para `canal-ver`

Ordem cronológica (mais antiga primeiro).

- 1 a 3 postagens: cada uma na própria mensagem. Não junta.
- 4 a 10: blocos de 3.
- 11 ou mais: blocos de 10.
- O último bloco pode ser menor. O separador `------------` vai **entre** blocos.
- Texto seguido de texto no mesmo bloco vira um balão só, com `------------` entre os textos.
- Imagem, áudio, sticker e vídeo não cabem no mesmo balão. Cada um segue como mensagem própria, com a legenda original. O separador de bloco, nesse caso, é uma mensagem de texto.

Filtro de tipos aplicado antes de contar e agrupar.

### Limites propostos

- Até 8 canais por grupo
- Apelido de 2 a 40 caracteres
- `canal-ver` com `timeout` maior (120s) porque pode sair muita mídia
- Vídeo acima de ~15 MB: grava a postagem com um aviso no lugar do arquivo, para um canal movimentado não encher o disco

## Fora da primeira versão

- Encaminhar sozinho cada postagem nova no grupo (os comandos pedidos são de consulta)
- Apagar arquivo quando o último grupo deixar de seguir
- Substituir Horóscopo ou MuNews por esse sistema
- Reagir a edição, contagem de views ou enquete

## Testes

Funções puras (parse do nome+link, tipos separados por vírgula, data, agrupamento) com o harness em `src/testing/`, rodando dentro do container `ravena-ai`, sempre com `process.exit`. Seguir um canal de verdade depende da API Go nova e de uma conta conectada; o rebuild do container fica a cargo do usuário.
