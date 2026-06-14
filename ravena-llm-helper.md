# Ravena - Informações Base

Este documento contém informações fundamentais sobre o bot Ravena, seu funcionamento, recursos e como auxiliar os usuários.

---

## 🤖 Sobre a Ravena
A **Ravena** é um bot de WhatsApp gratuito e de código aberto, desenvolvido por **moothz**. Seu código está disponível no GitHub: https://github.com/moothz/ravena-ai.
O objetivo principal é auxiliar streamers, gerenciar comunidades e aumentar a interação através de jogos e utilidades.

### Recursos Principais
- **Mídia**: Criação de figurinhas, download de vídeos/músicas, conversão de formatos.
- **IA**: Processamento de mensagens com LLMs, geração de imagens, tradução e transcrição de áudio.
- **Jogos**: Pescaria (!pesca), Roleta Russa (!roleta), Slots (!slots), Anagrama, Tarot e mais.
- **Utilidades**: Clima, Notícias, Horóscopo, Pesquisas Google/Wikipedia.
- **Streaming**: Notificações de lives (Twitch, Kick, YouTube).
- **Gerenciamento**: Painel Web (!g-painel), filtros de links/NSFW, mensagens de boas-vindas.

### Adicionar ravena em um grupo
Se o usuário enviar um link de convite como "https://chat.whatsapp.com/abcd1234" ou pedir "adicionar no grupo", "entrar no grupo", "colocar no grupo"
Informe ele que o link deve ser enviada para um dos números da ravena diretamente no whatsapp, e envie os números do bot
Envie as instruções de convite

---

## 📞 Contatos e Números
- **Criador/Dono**: (55) 99642-4307
- **ravena2**: (98) 98771-5450
- **ravena4**: (55) 98102-4412
- **ravena5**: (55) 99153-7296
- **ravena10**: (55) 98102-4412
- **Bot Oficial (Lobby)**: Disponível via https://chat.whatsapp.com/GMtTi1V6XIBChCBgkQC9g0 ou no site https://ravena.moothz.win

### Instruções de Convite
Pra começar, envie o *LINK*, apenas o _LINK_ do seu grupo  para uma das ravenas (não pode ser aqui no chat de suporte nem para as vips)
Se você tentar adicionar a ravena no grupo, não vai dar certo.
Após o link, siga as instruções do bot, enviando uma mensagem explicando o motivo de querer o bot no seu grupo.

Não consigo colocar em todos os grupos devido a capacidade do _WhatsAppWeb+Celular_, então isto serve como uma forma de *seleção*, um filtro pra evitar dores de cabeça e gente que não sabe ler as instruções.
Me reservo no direito de remover o bot do seu grupo caso ache necessário.

🏆 *No geral, dou essas prioridades:*
- *Doadores*: Pessoas que contribuem com os custos da ravena (!doar)
- *Streamers/Produtores de conteúdo*: Vão usar as principais funções da ravena, que são as integrações com Twitch, Kick e Youtube
- *Organização*: Grupos com descrições boas e organizados

🙅‍ *E também evito o seguinte:*
- *Jamais aceito:* Nome/descrição com coisas _racistas, xenofóbicas, homofóbicas e machistas_ em geral (aqui não é chat do lol)
- *Underage*: Grupos claramente de crianças/adolescentes (principalmente os que usam 𝒸𝒶𝓇𝒶𝒸𝓉ℯ𝓇ℯ𝓈 𝒶𝓈𝓈𝒾𝓂)
- *Só casos específicos:* Grupos apenas de figurinhas, grupos de colégio/turmas
- *Penso bem antes*: Grupos que removem o bot, grupos de teste, convites mal escritos ou por IA (oh, a ironia!)

⚠️ *Atenção*: Se o bot for removido logo após entrar  no grupo, você será *bloqueado* _(considerarei que não tinha permissão ou pouco interesse)_.

### Ravena Comunitária
Iniciativa onde membros doam chips para rodar o bot. O dono da instância comunitária tem acesso aos logs técnicos. Se a privacidade total for uma preocupação, recomenda-se usar as instâncias oficiais ou hospedar sua própria.

---

## 💖 Doações
O projeto é mantido por doações voluntárias que ajudam nos custos de servidores e APIs.
- **Link**: https://tipa.ai/moothz

---

## 💡 Como Auxiliar o Usuário (Diretrizes)
Você (AnythingLLM) deve atuar como uma assistente proativa. Siga estas regras:

1.  **Sugira Comandos Específicos**: Quando o usuário perguntar "como fazer X", identifique o comando correspondente na lista abaixo e mostre como usar.
    *   *Exemplo:* "Como vejo o tempo?" -> "Use o comando `!clima [cidade]`. Exemplo: `!clima Porto Alegre`"
2.  **Criação de Comandos Personalizados**: Auxilie na criação de comandos usando `!g-addCmd`.
    *   Sempre sugira o uso de **Variáveis** para tornar o comando dinâmico.
    *   *Exemplo:* "Quero um comando que mande um pokemon aleatório" -> "Você pode criar assim: `!g-addCmd poke Você capturou um *{pokemonEN}*!`"
3.  **Explique Variáveis**: Se o usuário mencionar algo aleatório (peixes, carros, países), verifique se existe uma variável correspondente (ex: `{peixe}`, `{carro2024}`, `{emojiBandeiraPais}`) e sugira seu uso.
4.  **Workarounds**: Se o usuário quiser "editar" um comando fixo, explique que ele deve criar um alias com `{cmd-nome}` e silenciar o original com `!g-mute`.

---

## 🛠️ Dicas de Gerenciamento
- **Painel Web**: Sempre sugira o `!g-painel` para configurações complexas, é mais fácil que comandos de chat.
- **Prefixo**: Grupos podem ter prefixos personalizados.
- **Mute**: Se um comando estiver incomodando, use `!g-mute [comando]`.

---

## ⚙️ Visão Técnica (Para Referência)
- **Banco de Dados**: SQLite (`data/sqlites/`). Tabelas principais: `groups`, `custom_commands`, `donations`.
- **Logs**: O uso de comandos é registrado em `cmd_usage.db`.
- **Media**: Arquivos temporários ficam em `data/media/`.

---

# 📚 Referência de Comandos

Abaixo está a lista de todos os comandos que você pode sugerir aos usuários.

## 🛠️ Comandos Comuns (Fixed Commands)
Estes comandos podem ser usados por qualquer membro.

### Categoria: ia
#### !ai
**Descrição:** Pergunte algo à IA

---

#### !ia
**Descrição:** Alias para AI

---

#### !imagine
**Descrição:** Gera uma imagem

---

#### !resumo
**Descrição:** Resume conversas recentes do grupo

---

#### !interagir
**Descrição:** Gera uma mensagem interativa baseada na conversa

---

### Categoria: jogos
#### !anagrama
**Descrição:** Inicia uma partida do jogo Anagrama.

---

#### !ana
**Descrição:** Envia um palpite para o jogo Anagrama.

**Uso:** `!ana !ana <palpite>`

**Exemplo:** `!ana !ana <palpite>`

---

#### !ana-dica
**Descrição:** Pede uma dica para a palavra atual do Anagrama.

---

#### !ana-pular
**Descrição:** Pula a palavra atual no jogo Anagrama.

---

#### !anagrama-ranking
**Descrição:** Mostra o ranking do jogo Anagrama.

---

#### !anagrama-reset
**Descrição:** Reseta o ranking do Anagrama para o grupo (admins).

---

#### !anonimo
**Descrição:** Envia uma mensagem anônima para um grupo

---

#### !d4
**Descrição:** Rola um dado de X faces

---

#### !d6
**Descrição:** Rola um dado de X faces

---

#### !d8
**Descrição:** Rola um dado de X faces

---

#### !d10
**Descrição:** Rola um dado de X faces

---

#### !d12
**Descrição:** Rola um dado de X faces

---

#### !d20
**Descrição:** Rola um dado de X faces

---

#### !d100
**Descrição:** Rola um dado de X faces

---

#### !roll
**Descrição:** Rola dados com padrão customizado (ex: 2d6+3)

---

#### !pescar
**Descrição:** Pesque um peixe

---

#### !meus-pescados
**Descrição:** Ficha do Pescador

---

#### !pesca-ficha
**Descrição:** Ficha do Pescador

---

#### !pesca-ranking
**Descrição:** Mostra o ranking de pescaria do grupo atual

---

#### !pesca-info
**Descrição:** Informações do jogo

---

#### !pesca-reset
**Descrição:** Reseta os dados de pesca para o grupo atual

---

#### !pesca-lendas
**Descrição:** Mostra os peixes lendários que foram pescados

---

#### !pesca-peixes
**Descrição:** Lista todos os tipos de peixes disponíveis

---

#### !pesca-iscas
**Descrição:** Ficha do Pescador

---

#### !0800
**Descrição:** Mostra jogos grátis e brindes atuais

**Uso:** `!0800 !0800 [plataforma]`

**Exemplo:** `!0800 !0800 [plataforma]`

---

#### !giveaways
**Descrição:** Mostra jogos grátis e brindes atuais

**Uso:** `!giveaways !giveaways [plataforma]`

**Exemplo:** `!giveaways !giveaways [plataforma]`

---

#### !sequencia
**Descrição:** Inicia um jogo de sequência lógica

---

#### !seq
**Descrição:** Tentar adivinhar a sequência

---

#### !sequencia-ranking
**Descrição:** Ver o ranking de lógica

---

#### !lol-build
**Descrição:** Retorna o link da build de um campeão do League of Legends

---

#### !pinto
**Descrição:** Gera uma avaliação de tamanho aleatória

---

#### !pinto-ranking
**Descrição:** Mostra o ranking do jogo

---

#### !pinto-reset
**Descrição:** Reseta os dados do jogo para este grupo

---

#### !psn-platinas
**Descrição:** Consulta as platinas de um usuário da PSN

**Uso:** `!psn-platinas !psn-platinas <usuario>`

**Exemplo:** `!psn-platinas !psn-platinas <usuario>`

---

#### !ragnavena
**Descrição:** Ragnarok da ravena, no navegador!

---

#### !lol
**Descrição:** Busca perfil de jogador de League of Legends

---

#### !valorant
**Descrição:** Busca perfil de jogador de Valorant

---

#### !roletarussa
**Descrição:** Joga roleta russa, risco de ser silenciado

---

#### !roleta-ranking
**Descrição:** Mostra ranking da roleta russa

---

#### !roleta-reset
**Descrição:** Reseta os dados da roleta russa para este grupo

---

#### !roleta-tempo
**Descrição:** Define o tempo de timeout da roleta russa

---

#### !slots
**Descrição:** Joga o caça-coisas

---

#### !slots-premios
**Descrição:** Lista seus prêmios do caça-coisas

---

#### !slots-ranking
**Descrição:** Mostra o ranking de vitórias do caça-coisas no grupo

---

#### !steam-platinas
**Descrição:** Consulta as platinas de um usuário da Steam

**Uso:** `!steam-platinas !platina <usuario/steamid>`

**Exemplo:** `!steam-platinas !platina <usuario/steamid>`

---

#### !adedonha
**Descrição:** Inicia um jogo de Stop/Adedonha

---

#### !stop
**Descrição:** Alias para o jogo de Stop/Adedonha

---

#### !tarot
**Descrição:** Consulta a cartomante para uma tiragem

---

#### !wr-build
**Descrição:** Retorna o link da build de um campeão do Wild Rift

---

### Categoria: cultura
#### !anime
**Descrição:** Busca informações sobre um anime no MyAnimeList

---

#### !copa
**Descrição:** Lista todos os comandos da Copa do Mundo 2026

---

#### !copa-times
**Descrição:** Lista todos os 48 times (ou de um grupo: !copa-times C)

---

#### !copa-time
**Descrição:** Informações de um time específico

---

#### !copa-grupos
**Descrição:** Classificação de todos os 12 grupos

---

#### !copa-grupo
**Descrição:** Classificação detalhada de um grupo (ex: !copa-grupo C)

---

#### !copa-jogos
**Descrição:** Calendário de jogos (ou de um grupo: !copa-jogos A)

---

#### !copa-jogo
**Descrição:** Detalhes de uma partida (ex: !copa-jogo 1)

---

#### !copa-estadios
**Descrição:** Lista todos os 16 estádios da Copa

---

#### !copa-seguir
**Descrição:** Habilita/Desabilita notificações de partidas de um time

---

#### !imdb
**Descrição:** Busca informações sobre filmes ou séries no IMDB

---

### Categoria: geral
#### !ajuda
**Descrição:** Consulta a base de conhecimento no AnythingLLM

**Uso:** `!ajuda !ajuda [sua pergunta]`

**Exemplo:** `!ajuda !ajuda [sua pergunta]`

---

#### !doar
**Descrição:** Mostra informações de doação e link

---

#### !doadores
**Descrição:** Mostra informações de doação e link

---

#### !status
**Descrição:** Verifica o status dos bots

---

#### !grupao
**Descrição:** Comunidades da ravena!

---

#### !avisos
**Descrição:** Grupo de avisos ravenabot

---

#### !codigo
**Descrição:** Código da ravenabot

---

#### !convite
**Descrição:** Saiba mas sobre a ravena em grupos

---

#### !discord
**Descrição:** Info sobre a Ravena no Discord

---

#### !telegram
**Descrição:** Info sobre a Ravena no Telegram

---

#### !cmd
**Descrição:** Mostra todos os comandos disponíveis

---

#### !menu
**Descrição:** Mostra todos os comandos disponíveis

---

#### !cmd-gerenciamento
**Descrição:** Mostra comandos de gerenciamento do grupo

---

#### !cmd-grupo
**Descrição:** Mostra comandos personalizados do grupo

---

#### !cmd-categoria
**Descrição:** Mostra comandos da categoria informada

---

### Categoria: zoeira
#### !biscoito
**Descrição:** Abre um biscoito da sorte

---

#### !cantada
**Descrição:** Faz uma cantada para alguém do grupo

---

#### !violencia
**Descrição:** Pratica um ato de violência

---

#### !morreu
**Descrição:** de gue?

---

#### !boleto
**Descrição:** Escolhe alguém pra pagar

---

#### !clonarcartao
**Descrição:** Pra pagar o agiota

---

#### !presente
**Descrição:** Os melhores da internet

---

#### !pix
**Descrição:** Faz uma transferência pela Ravenabank

---

#### !aniversario
**Descrição:** Parabeniza um membro do grupo!

---

#### !pecar
**Descrição:** Sem descrição.

---

### Categoria: utilidades
#### !correios
**Descrição:** Rastreia uma encomenda dos Correios

---

#### !correios-lista
**Descrição:** Lista encomendas sendo rastreadas no chat

---

#### !correios-del
**Descrição:** Para de rastrear uma encomenda

---

#### !horoscopo
**Descrição:** Exibe o horóscopo para um signo e/ou data específica.

**Uso:** `!horoscopo !horoscopo [signo] [data]`

**Exemplo:** `!horoscopo !horoscopo [signo] [data]`

---

#### !lembretes
**Descrição:** Lista os lembretes ativos

---

#### !lembrar
**Descrição:** Configura um lembrete para uma data específica

---

#### !l-cancelar
**Descrição:** Cancela um lembrete por ID

---

#### !news
**Descrição:** Exibe as MuNews para uma data específica (padrão: hoje)

**Uso:** `!news !news [YYYY-MM-DD]`

**Exemplo:** `!news !news [YYYY-MM-DD]`

---

#### !ocr
**Descrição:** Extrai texto de uma imagem usando IA

---

#### !qr
**Descrição:** Gera um QR Code para um texto ou link

---

#### !qr-wifi
**Descrição:** Gera um QR Code para conexão WiFi

---

#### !qr-pix
**Descrição:** Gera um QR Code para pagamento PIX

---

#### !download
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !download-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !download-musica
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !yt
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !yt-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !yt-musica
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !sr
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !x
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !twitter
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !tiktok
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !tk
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !tiktok-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !insta
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !instagram
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !insta-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !fb
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !facebook
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !pin
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !pinterest
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !sc
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !sc-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !sc-musica
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !soundcloud
**Descrição:** Baixa conteúdo de mídias sociais

---

#### !soundcloud-audio
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !soundcloud-musica
**Descrição:** Baixa conteúdo de mídias sociais (apenas áudio)

---

#### !stt
**Descrição:** Converte voz para texto

---

#### !transcrever
**Descrição:** Converte voz para texto

---

#### !traduzir
**Descrição:** Traduz um texto para o idioma especificado

**Uso:** `!traduzir !traduzir [idiomaOriginal] [idiomaDesjado] [texto] ou !traduzir [idioma] em resposta a uma mensagem`

**Exemplo:** `!traduzir !traduzir [idiomaOriginal] [idiomaDesjado] [texto] ou !traduzir [idioma] em resposta a uma mensagem`

---

#### !clima
**Descrição:** Clima e previsão do tempo (Open-Meteo)

---

#### !yt
**Descrição:** Baixa um vídeo do YouTube

---

#### !sr
**Descrição:** Baixa uma música do YouTube (áudio do vídeo)

---

#### !letra
**Descrição:** Busca a letra de uma música

---

### Categoria: midia
#### !emojik
**Descrição:** Cria um sticker combinando dois emojis

---

#### !memoji
**Descrição:** Alias para o comando emojik

---

#### !removebg
**Descrição:** Remove o fundo de uma imagem

---

#### !distort
**Descrição:** Aplica efeito de distorção a uma imagem

---

#### !stickerbg
**Descrição:** Cria um sticker após remover o fundo

---

#### !sbg
**Descrição:** Envia sticker sem fundo

---

#### !rbg
**Descrição:** Remove fundo de imagem e envia o PNG

---

#### !morejpeg
**Descrição:** Aplica compressão JPEG extrema

---

#### !sketch
**Descrição:** Aplica efeito sketch a uma imagem

---

#### !oil
**Descrição:** Aplica efeito oil a uma imagem

---

#### !neon
**Descrição:** Aplica efeito neon a uma imagem

---

#### !pixelate
**Descrição:** Aplica efeito pixelate a uma imagem

---

#### !sticker
**Descrição:** Converte mídia em sticker

---

#### !figurinha
**Descrição:** Converte mídia em sticker

---

#### !s
**Descrição:** Alias curto para comando sticker

---

#### !fig
**Descrição:** Alias curto para comando sticker

---

#### !sqi
**Descrição:** Sticker quadrado com corte inteligente via IA

---

#### !stickerqi
**Descrição:** Sticker quadrado com corte inteligente via IA

---

#### !sq
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !stickerq
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !sqc
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !stickerqc
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !sqb
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !stickerqb
**Descrição:** Sticker quadrado, cortado no meio (sq), cima (sqc), baixo (sqb) ou esticado (sqe)

---

#### !sqe
**Descrição:** Sticker quadrado esticado, sem cortar a imagem

---

#### !stickerqe
**Descrição:** Sticker quadrado esticado, sem cortar a imagem

---

### Categoria: áudio
#### !extractaudio
**Descrição:** Extrai audio do arquivo especificado, em mp3

---

#### !extractvoice
**Descrição:** Extrai audio do arquivo especificado, como mensagem de voz

---

#### !volume
**Descrição:** Ajusta o volume da mídia (0-1000)

---

### Categoria: arquivos
#### !pastas
**Descrição:** Lista as pastas e arquivos

---

#### !p-criar
**Descrição:** Cria nova pasta

---

#### !p-enviar
**Descrição:** Envia arquivo para a pasta

---

#### !p-excluir
**Descrição:** Apaga arquivo ou pasta

---

#### !p-baixar
**Descrição:** Baixa arquivo ou pasta

---

### Categoria: saude
#### !comida
**Descrição:** Envie foto de comida para registrar os ingredientes e calorias.

---

#### !comida-info
**Descrição:** Mostra estatísticas da sua alimentação.

---

#### !comida-lista
**Descrição:** Lista seu histórico de alimentação.

---

### Categoria: grupo
#### !apelido
**Descrição:** Define seu apelido no grupo

---

#### !atencao
**Descrição:** Menciona todos os membros do grupo

---

#### !galera
**Descrição:** Menciona todos os membros do grupo

---

#### !ignorar
**Descrição:** Alterna ser ignorado pelas menções de grupo

---

#### !apagar
**Descrição:** Apaga a mensagem do bot quando usado em resposta a ela

---

#### !faladores
**Descrição:** Mostra o ranking de quem mais fala no grupo

---

#### !faladores-limpeza
**Descrição:** Remove do ranking membros que saíram do grupo

---

#### !faladores-reset
**Descrição:** Mostra o ranking final e reinicia a contagem

---

### Categoria: busca
#### !gif
**Descrição:** Busca e envia um GIF do Giphy

---

#### !lastfm
**Descrição:** Exibe informações de um perfil do Last.fm

**Uso:** `!lastfm !lastfm username`

**Exemplo:** `!lastfm !lastfm username`

---

#### !lfm
**Descrição:** Alias para o comando lastfm

**Uso:** `!lfm !lfm username`

**Exemplo:** `!lfm !lfm username`

---

#### !metar
**Descrição:** Busca o METAR de um aeroporto (ex: !metar SBPA)

**Uso:** `!metar !metar <código_icao>`

**Exemplo:** `!metar !metar <código_icao>`

---

#### !audio
**Descrição:** Busca um áudio no site MyInstants (não é música)

**Uso:** `!audio !audio <nome_do_áudio> <número>`

**Exemplo:** `!audio !audio <nome_do_áudio> <número>`

---

#### !apod
**Descrição:** Foto astronômica do dia (NASA)

---

#### !epic
**Descrição:** Imagem da Terra pela câmera EPIC (Natural)

---

#### !epic-enhanced
**Descrição:** Imagem da Terra pela câmera EPIC (Color Enhanced)

---

#### !epic-aerosol
**Descrição:** Imagem da Terra pela câmera EPIC (Aerosol Index)

---

#### !epic-cloud
**Descrição:** Imagem da Terra pela câmera EPIC (Cloud Fraction)

---

#### !sipt
**Descrição:** Consulta informações sobre uma placa no InstaSiPt

**Uso:** `!sipt !sipt ABC1234`

**Exemplo:** `!sipt !sipt ABC1234`

---

#### !buscar
**Descrição:** Busca na web

---

#### !buscar-img
**Descrição:** Busca por imagens

---

#### !rab
**Descrição:** Consultas ao Registro Aeronáutico Brasileiro

---

#### !wiki
**Descrição:** Busca informações na Wikipedia

---

### Categoria: listas
#### !listas
**Descrição:** Mostra as listas disponíveis no grupo

---

#### !ll
**Descrição:** Alias para comando listas

---

#### !lc
**Descrição:** Cria uma nova lista

---

#### !lct
**Descrição:** Cria uma nova lista com título

---

#### !ld
**Descrição:** Deleta uma lista

---

#### !le
**Descrição:** Entra em uma lista

---

#### !ls
**Descrição:** Sai de uma lista

---

#### !lt
**Descrição:** Define título de uma lista

---

#### !lr
**Descrição:** Remove um usuário de uma lista (admin only)

---

### Categoria: tts
#### !tts
**Descrição:** Converte texto para voz usando personagem 'ravena'

---

#### !tts-mulher
**Descrição:** Converte texto para voz usando personagem feminina

---

#### !tts-carioca
**Descrição:** Converte texto para voz usando personagem feminina

---

#### !tts-carioco
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-sensual
**Descrição:** Converte texto para voz usando personagem feminina

---

#### !tts-sensuel
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-homem
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-clint
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-morgan
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-narrador
**Descrição:** Converte texto para voz usando personagem masculino

---

#### !tts-rubao
**Descrição:** Converte texto para voz usando do Rubão do Pontaço

---

### Categoria: streams
#### !streams
**Descrição:** Lista todos os canais configurados para monitoramento

---

#### !streamstatus
**Descrição:** Mostra status dos canais monitorados

---

#### !streamers
**Descrição:** Lista todos os streamers atualmente online

---

#### !live
**Descrição:** Mostra informações de uma stream da Twitch

---

#### !live-kick
**Descrição:** Mostra informações de uma stream do Kick

---

#### !topstreams
**Descrição:** Mostra as streams mais populares no momento

---

## ⚙️ Comandos de Gerenciamento
Começam com `!g-` e são restritos a administradores.

#### !g-setNome
**Descrição:** ID/Nome do grupo (nome stickers, gerenciamento)

---

#### !g-setPrefixo
**Descrição:** Altera o prefixo de comandos do *grupo* (padrão !)

---

#### !g-setCustomSemPrefixo
**Descrição:** Faz com que comandos personalizados não precisem de prefixo

---

#### !g-setBoasvindas
**Descrição:** Mensagem quando alguém entra no grupo. Você pode usar as variáveis {pessoa} e {tituloGrupo}, além de todas as variáveis disponíveis em !g-variaveis, assim como no !g-addCmd

---

#### !g-delBoasvindas
**Descrição:** Remove um tipo de mídia específico da mensagem de boas-vindas (text, image, audio, video, sticker)

---

#### !g-setDespedida
**Descrição:** Mensagem quando alguém sai do grupo

---

#### !g-delDespedida
**Descrição:** Remove um tipo de mídia específico da mensagem de despedida (text, image, audio, video, sticker)

---

#### !g-autoStt
**Descrição:** Ativa/desativa conversão automática de voz para texto

---

#### !g-info
**Descrição:** Mostra informações detalhadas do grupo (debug)

---

#### !g-manage
**Descrição:** Ativa o gerenciamento do grupo pelo PV do bot

---

#### !g-setAutoTranslate
**Descrição:** Define o idioma para tradução automática de todas as respostas do bot (Ex: Spanish (ES))

---

#### !g-addCmd
**Descrição:** Cria um comando personalizado

---

#### !g-addCmdReply
**Descrição:** Adiciona outra resposta a um comando existente

---

#### !g-delCmd
**Descrição:** Exclui um comando personalizado

---

#### !g-cmd-enable
**Descrição:** Habilita comando (comandos personalizados)

---

#### !g-cmd-disable
**Descrição:** Desabilita comando (comandos personalizados)

---

#### !g-cmd-setPV
**Descrição:** A resposta do comando será enviada no PV (comandos personalizados)

---

#### !g-cmd-enviarTudo
**Descrição:** Envia todas as respostas do comando (se houver mais de uma)

---

#### !g-cmd-responder
**Descrição:** Ativa/Desativa se o comando deve responder citando a mensagem

---

#### !g-cmd-react
**Descrição:** Reaçao quando usar o comando

---

#### !g-cmd-startReact
**Descrição:** Reaçao pré-comando (útil para APIs, como loading)

---

#### !g-cmd-setAdm
**Descrição:** Define que apenas admins podem usar um comando

---

#### !g-cmd-setInteragir
**Descrição:** Define que comando seja usado nas interações aleatórias

---

#### !g-cmd-cd
**Descrição:** Define o cooldown (em segundos) de um comando personalizado. Uso: !g-cmd-cd <comando> <segundos>

---

#### !g-cmd-setHoras
**Descrição:** Define horários permitidos para um comando

---

#### !g-cmd-setDias
**Descrição:** Define dias permitidos para um comando

---

#### !g-filtro-palavra
**Descrição:** Detecta e Apaga mensagens com a palavra/frase especificada

---

#### !g-filtro-links
**Descrição:** Detecta e Apaga mensagens com links

---

#### !g-filtro-pessoa
**Descrição:** Detecta e Apaga mensagens desta pessoa (Marcar com @)

---

#### !g-filtro-nsfw
**Descrição:** Detecta e Apaga mensagens NSFW

---

#### !g-ignorar
**Descrição:** O bot irá ignorar as mensagens desta pessoa

---

#### !g-mute
**Descrição:** Desativa/ativa comando com a palavra especificada

---

#### !g-muteCategoria
**Descrição:** Desativa/ativa todos os comandos da categoria especificada

---

#### !g-customAdmin
**Descrição:** Adiciona pessoas como administradoras fixas do bot no grupo

---

#### !g-pausar
**Descrição:** Pausa/retoma a atividade do bot no grupo

---

#### !g-interagir
**Descrição:** Ativa/desativa interações automáticas do bot

---

#### !g-interagir-cmd
**Descrição:** Ativa/desativa interações automáticas do bot usando comandos do grupo

---

#### !g-interagir-cd
**Descrição:** Define o tempo de espera entre interações automáticas

---

#### !g-interagir-chance
**Descrição:** Define a chance de ocorrer interações automáticas

---

#### !g-fechar
**Descrição:** Fecha o grupo (apenas admins enviam msgs)

---

#### !g-abrir
**Descrição:** Abre o grupo (todos podem envar msgs)

---

#### !g-setPersonalidade
**Descrição:** Define uma personalidade para os comandos de IA (max. 1500 caracteres)

---

#### !g-setApelido
**Descrição:** Define apelido de *outro membro* no grupo (@marcar_pessoa)

---

#### !g-twitch-canal
**Descrição:** Adiciona/remove canal da Twitch para monitoramento

---

#### !g-twitch-mudarTitulo
**Descrição:** Ativa/desativa mudança de título do grupo para eventos da Twitch

---

#### !g-twitch-titulo
**Descrição:** Define título do grupo para eventos de canal da Twitch

---

#### !g-twitch-fotoGrupo
**Descrição:** Define foto do grupo para eventos de canal da Twitch

---

#### !g-twitch-midia
**Descrição:** Define mídia para notificação de canal da Twitch

---

#### !g-twitch-midia-del
**Descrição:** Remove mídia específica da notificação de canal da Twitch

---

#### !g-twitch-usarIA
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

---

#### !g-twitch-usarThumbnail
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

---

#### !g-twitch-marcar
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal da Twitch

---

#### !g-kick-canal
**Descrição:** Adiciona/remove canal do Kick para monitoramento

---

#### !g-kick-mudarTitulo
**Descrição:** Ativa/desativa mudança de título do grupo para eventos do Kick

---

#### !g-kick-titulo
**Descrição:** Define título do grupo para eventos de canal do Kick

---

#### !g-kick-fotoGrupo
**Descrição:** Define foto do grupo para eventos de canal do Kick

---

#### !g-kick-midia
**Descrição:** Define mídia para notificação de canal do Kick

---

#### !g-kick-midia-del
**Descrição:** Remove mídia específica da notificação de canal do Kick

---

#### !g-kick-usarIA
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

---

#### !g-kick-usarThumbnail
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

---

#### !g-kick-marcar
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal do Kick

---

#### !g-youtube-canal
**Descrição:** Adiciona/remove canal do YouTube para monitoramento

---

#### !g-youtube-mudarTitulo
**Descrição:** Ativa/desativa mudança de título do grupo para eventos do YouTube

---

#### !g-youtube-titulo
**Descrição:** Define título do grupo para eventos de canal do YouTube

---

#### !g-youtube-fotoGrupo
**Descrição:** Define foto do grupo para eventos de canal do YouTube

---

#### !g-youtube-midia
**Descrição:** Define mídia para notificação de canal do YouTube

---

#### !g-youtube-midia-del
**Descrição:** Remove mídia específica da notificação de canal do YouTube

---

#### !g-youtube-usarIA
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

---

#### !g-youtube-usarThumbnail
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

---

#### !g-youtube-marcar
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal do YouTube

---

#### !g-variaveis
**Descrição:** Lista todas as variáveis disponíveis para comandos personalizados

---

#### !g-painel
**Descrição:** Gera um link para gerenciar o bot via web

---

#### !g-setWebhook
**Descrição:** Cria ou atualiza um webhook para este grupo

---

#### !g-delWebhook
**Descrição:** Apaga um webhook deste grupo

---

#### !g-advertir
**Descrição:** Adiciona uma advertência aos membros mencionados

---

#### !g-advertencias
**Descrição:** Lista as advertências atuais do grupo

---

#### !g-limpar-advertencias
**Descrição:** Remove as advertências dos membros mencionados

---

#### !g-streamRefresh
**Descrição:** Reseta a lista de bots ativos/ignorados para as notificações de stream

---

#### !g-dossie
**Descrição:** Exibe o histórico de dossiês deste grupo

---

## 👑 Comandos de Super Admin
Começam com `!sa-` e são exclusivos do dono do bot.

#### !sa-retrospectiva
**Descrição:** Retrospectiva

---

#### !sa-testeMsg
**Descrição:** Testar Retorno msg

---

#### !sa-sendMsg
**Descrição:** Envia mensagem para chatId

---

#### !sa-joinGrupo
**Descrição:** Entra em um grupo via link de convite

---

#### !sa-joinGrupoSilencioso
**Descrição:** Entra em um grupo via link de convite SEM enviar mensagem de boas-vindas

---

#### !sa-modoSilencioso
**Descrição:** Toggle do modo silencioso global (sem boas-vindas por 30 min)

---

#### !sa-addDonate
**Descrição:** Adiciona novo donate

---

#### !sa-addDonateNumero
**Descrição:** Adiciona número de um doador

---

#### !sa-addDonateValor
**Descrição:** Atualiza valor de doação

---

#### !sa-mergeDonates
**Descrição:** Une dois doadores em um

---

#### !sa-block
**Descrição:** Bloqueia um usuário

---

#### !sa-unblock
**Descrição:** Desbloqueia um usuário

---

#### !sa-leaveGrupo
**Descrição:** Sai de um grupo com opção de bloquear membros

---

#### !sa-privacidade
**Descrição:** Seta padrões de privacidade

---

#### !sa-foto
**Descrição:** Altera foto de perfil do bot

---

#### !sa-simular
**Descrição:** Simula evento de stream

---

#### !sa-restart
**Descrição:** Reinicia o bot

---

#### !sa-stats
**Descrição:** Status, grupos

---

#### !sa-iaStats
**Descrição:** Estatísticas de IA (LLM, Comfy, Speech)

---

#### !sa-getGroupInfo
**Descrição:** Dump de dados de grupo por nome cadastro

---

#### !sa-getMembros
**Descrição:** Lista todos os membros do grupo separados por admin e membros normais

---

#### !sa-blockInvites
**Descrição:** Bloqueia os invites dessa pessoa

---

#### !sa-unblockInvites
**Descrição:** Bloqueia os invites dessa pessoa

---

#### !sa-blockList
**Descrição:** Bloqueia todos os contatos recebidos separados por vírgula

---

#### !sa-blockTudoList
**Descrição:** Sai de todos os grupos em comum com uma lista de pessoas e bloqueia todos os membros

---

#### !sa-unblockList
**Descrição:** Desbloqueia todos os contatos recebidos separados por vírgula

---

#### !sa-listaGruposPessoa
**Descrição:** Lista todos os grupos em comum com uma pessoa

---

#### !sa-blockTudoPessoa
**Descrição:** Sai de todos os grupos em comum com uma pessoa e bloqueia todos os membros

---

#### !sa-reagir
**Descrição:** Reage com o emoji informado [debug apenas]

---

#### !sa-status
**Descrição:** Define o status do bot

---

#### !sa-wol
**Descrição:** Envia pacote wake-on-lan na rede

---

#### !sa-globalStreamRefresh
**Descrição:** Reseta a lista de bots ativos/ignorados para transmissões em TODOS os grupos

---

#### !sa-dossie
**Descrição:** Trigga análise de dossiê para um grupo

---

#### !sa-addElogio
**Descrição:** Adiciona um sticker de elogio (use em resposta)

---

#### !sa-addXingamento
**Descrição:** Adiciona um sticker de xingamento (use em resposta)

---

#### !sa-fixGroupNames
**Descrição:** Escaneia e sugere correção para nomes de grupos (dry run)

---

# 🎲 Variáveis para Comandos Personalizados

Use estas variáveis ao sugerir a criação de comandos com `!g-addCmd`.

### 🚪 Boas vindas/despedidas
- `{pessoa}`: Nome da pessoa
- `{tituloGrupo}`: Título do grupo

### 🕐 Variáveis de Sistema
- `{day}`: Nome do dia (ex: Segunda-feira)
- `{date}`: Data atual
- `{time}`: Hora atual
- `{data-hora}`: Hora (HH)
- `{data-dia}`: Dia (DD)
- `{data-mes}`: Mês (MM)
- `{data-ano}`: Ano (YYYY)

### 🎲 Números Aleatórios
- `{randomPequeno}`: 1 a 10
- `{randomMedio}`: 1 a 100
- `{randomGrande}`: 1 a 1000
- `{rndDado-X}`: Dado de X lados
- `{rndDadoRange-X-Y}`: Aleatório entre X e Y

### 👤 Contexto e Menções
- `{pessoa}`: Nome do autor
- `{group}`: Nome do grupo
- `{contador}`: Contagem de execuções
- `{mention}`: Marca alguém (mencionado ou aleatório)
- `{singleMention}`: Marca a mesma pessoa em todas as ocorrências
- `{mentionOuEu}`: Marca alguém ou o autor se não houver menção
- `{membroRandom}`: Nome de um membro aleatório

### 🌐 APIs e Web
- `{weather:cidade}`: Clima atual na cidade
- `{reddit-subreddit}`: Mídia aleatória de um subreddit
- `{API#GET#TEXT#url}`: Resultado de texto de uma API

### 📁 Outros
- `{file-nome}`: Envia arquivo de 'data/media/'
- `{cmd-comando}`: Executa outro comando (alias)

### 🎭 Variáveis de Sorteio (Aleatórias)
Estas variáveis escolhem um item aleatório de uma lista pré-definida. Sugira-as para comandos divertidos.

- `{letra}`
- `{LETRA}`
- `{lEtRaS}`
- `{peixe}`
- `{aeronavePequena}`
- `{aeronaveGrande}`
- `{aeroportoBR}`
- `{aeroporto}`
- `{presente}`
- `{estadoRandom}`
- `{artigoSexoRandom}`
- `{emojiPinto}`
- `{diasSemanaCompleto}`
- `{legume}`
- `{carro2024}`
- `{pokemonEN}`
- `{genshinElementNome}`
- `{genshinElementEmoji}`
- `{genshinChar4Emoji}`
- `{genshinChar4}`
- `{genshinChar5Emoji}`
- `{genshinChar5}`
- `{genshinWeapon3Emoji}`
- `{genshinWeapon3}`
- `{genshinWeapon4Emoji}`
- `{genshinWeapon4}`
- `{genshinWeapon5Emoji}`
- `{genshinWeapon5}`
- `{emojiMedalha}`
- `{emojiBandeiraPais}`
- `{emojiNumero}`
- `{emojiSigno}`
- `{emojiDirecao}`
- `{emojiCorRedondo}`
- `{emojiCorQuadrado}`
- `{emojiCoracao}`
- `{emojiFrutas}`
- `{emojiLegumes}`
- `{emojiComida}`
- `{emojiDoces}`
- `{emojiBebidas}`
- `{emojiPlanta}`
- `{emojiAnimal}`
- `{municipio}`
- `{nomeMasculino}`
- `{nomeFeminino}`
- `{lolChampion}`
- `{peixes}`
- `{peixes2025}`
- `{violencia}`
- `{morreu}`
- `{aniversario}`
- `{boleto}`
- `{genshin}`
- `{cartao}`
- `{pecados}`
- `{biscoito-frases}`
- `{cantadas-ruins}`

