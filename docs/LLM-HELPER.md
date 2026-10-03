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
Pra começar, envie o *LINK*, apenas o _LINK_ do seu grupo para uma das ravenas (não pode ser aqui no chat de suporte nem para as vips)
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

⚠️ *Atenção*: Se o bot for removido logo após entrar no grupo, você será *bloqueado* _(considerarei que não tinha permissão ou pouco interesse)_.

### Ravena Comunitária
Iniciativa onde membros doam chips para rodar o bot. O dono da instância comunitária tem acesso aos logs técnicos. Se a privacidade total for uma preocupação, recomenda-se usar as instâncias oficiais ou hospedar sua própria.

---

## 💖 Doações
O projeto é mantido por doações voluntárias que ajudam nos custos de servidores e APIs.
- **Link**: https://tipa.ai/moothz

---

## 💡 Como Auxiliar o Usuário (Diretrizes)
Você deve atuar como uma assistente proativa e inteligente. Siga estas regras:

1. **Sugira Comandos Específicos**: Quando o usuário perguntar "como fazer X", identifique o comando correspondente e mostre sua sintaxe com exemplos.
   * *Exemplo:* "Como vejo o tempo?" -> "Use o comando `!clima [cidade]`. Exemplo: `!clima Porto Alegre`"
2. **Criação de Comandos Personalizados**: Auxilie na criação de comandos usando `!g-addCmd`.
   * Sempre sugira o uso de **Variáveis** para tornar o comando dinâmico.
   * *Exemplo:* "Quero um comando que mande um pokemon aleatório" -> "Você pode criar assim: `!g-addCmd poke Você capturou um *{pokemonEN}*!`"
3. **Explique Variáveis**: Se o usuário mencionar algo aleatório (peixes, carros, países), verifique se existe uma variável correspondente (ex: `{peixe}`, `{carro2024}`, `{emojiBandeiraPais}`) e sugira seu uso.
4. **Workarounds**: Se o usuário quiser "editar" um comando fixo, explique que ele deve criar um alias com `{cmd-nome}` e silenciar o original com `!g-mute`.

---

## 🛠️ Dicas de Gerenciamento
- **Painel Web**: Sempre sugira o `!g-painel` para configurações complexas, é mais fácil que comandos de chat.
- **Prefixo**: Grupos podem ter prefixos personalizados (`!g-setPrefixo`).
- **Mute**: Se um comando estiver incomodando, use `!g-mute [comando]`.

---

## ⚙️ Visão Técnica (Para Referência)
- **Banco de Dados**: SQLite (`data/sqlites/`). Tabelas principais: `groups`, `custom_commands`, `donations`.
- **Logs**: O uso de comandos é registrado em `cmd_usage.db`.
- **Media**: Arquivos temporários ficam em `data/media/`.

---

# 📚 Referência de Comandos e Módulos

Abaixo está a lista detalhada de todos os módulos e comandos da Ravena baseados nas definições helper.

## 🛠️ Comandos Comuns e Módulos de Funções
Estes comandos e utilitários são carregados dinamicamente e podem ser usados por qualquer membro (salvo indicação contrária).

### 📁 Módulo: `AICommands.js`
**Sobre:** Integração com modelos de Inteligência Artificial para conversação e execução inteligente de comandos

**Tags:** `ia,ai,chat,conversar,inteligencia artificial,gpt,gemini`

**Detalhes Técnicos:** Utiliza LLMService para envio de prompts, contexto de conversa, classificação de intenções e auto-invocação de outros comandos do bot

#### Comandos:
- **`!ai`**: Envia uma pergunta ou instrução para a IA responder ou interagir
  - *Categoria:* ia
  - *Uso/Exemplos:* `!ai Quem foi Ada Lovelace?`, `!ai Explique como funciona o motor a combustão`

---

### 📁 Módulo: `Ajuda.js`
**Sobre:** Sistema de suporte e ajuda inteligente com LLM e busca automática na base de comandos

**Tags:** `ajuda,suporte,faq,duvidas,como usar,comandos,ia,help`

**Detalhes Técnicos:** Utiliza LLMService com tool calling para buscar contexto no CommandsHelper e documentação consolidada

#### Comandos:
- **`!ajuda`**: Consulta a assistente inteligente para tirar dúvidas sobre comandos e uso do bot
  - *Categoria:* geral
  - *Uso/Exemplos:* `!ajuda como criar comandos personalizados`, `!ajuda como funciona a pescaria`

---

### 📁 Módulo: `AnagramGame.js`
**Sobre:** Jogo de palavras em que os jogadores devem adivinhar o anagrama embaralhado

**Tags:** `jogos,anagrama,palavras,game,ranking,adivinhar`

**Detalhes Técnicos:** Gerencia partidas por grupo em memória com dicas, contagem regressiva, persistência de pontuação e ranking em banco SQLite

#### Comandos:
- **`!anagrama`**: Inicia uma partida de Anagrama no grupo
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!anagrama`
- **`!ana`**: Envia um palpite para a palavra embaralhada
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!ana computador`, `!ana teclado`
- **`!ana-dica`**: Solicita uma dica sobre a palavra atual
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!ana-dica`
- **`!ana-pular`**: Pula a palavra atual da rodada
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!ana-pular`
- **`!anagrama-ranking`**: Exibe o ranking de jogadores com mais pontos no Anagrama
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!anagrama-ranking`
- **`!anagrama-reset`**: Reseta o ranking do jogo no grupo (Apenas Administradores)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!anagrama-reset`

---

### 📁 Módulo: `AnimeCommands.js`
**Sobre:** Consulta informações completas sobre animes e animações japonesas

**Tags:** `anime,otaku,mal,myanimelist,desenho,animacao,japao`

**Detalhes Técnicos:** Utiliza a biblioteca mal-scraper para buscar metadados, notas, episódios, sinopse e imagem de animes no MyAnimeList

#### Comandos:
- **`!anime`**: Pesquisa informações e sinopse de um anime
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!anime Naruto`, `!anime Attack on Titan`, `!anime Frieren`

---

### 📁 Módulo: `AnonymousMessage.js`
**Sobre:** Permite aos membros enviarem mensagens e mídias anônimas para grupos autorizados

**Tags:** `anonimo,segredo,correio,mensagem anonima,confissao`

**Detalhes Técnicos:** Encaminha conteúdo enviado no privado do bot para grupos destino cadastrados, com moderação e controles anti-spam

#### Comandos:
- **`!anonimo`**: Envia uma mensagem ou mídia anonimamente para o grupo indicado
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!anonimo [nome_do_grupo] Mensagem secreta aqui`, `!anonimo (em resposta a uma imagem com legenda)`

---

### 📁 Módulo: `BiscoitoDaSorte.js`
**Sobre:** Gera frases motivacionais ou bem-humoradas de biscoito da sorte

**Tags:** `biscoito,sorte,frase,motivacional,zoeira,fortune cookie`

**Detalhes Técnicos:** Carrega mensagens aleatórias da variável customizada 'biscoito-frases' do banco de dados e as processa com variáveis de template

#### Comandos:
- **`!biscoito`**: Abre um biscoito da sorte e revela uma mensagem do destino
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!biscoito`

---

### 📁 Módulo: `BonsaiCommands.js`
**Sobre:** Geração de imagens de alta qualidade via Inteligência Artificial usando Bonsai / ComfyUI

**Tags:** `ia,imagem,gerar imagem,imagine,bonsai,arte,desenho`

**Detalhes Técnicos:** Comunica com backend Bonsai, traduz prompts para inglês, aplica filtros de segurança NSFW e gera mídias

#### Comandos:
- **`!imagine`**: Gera uma imagem através de descrição textual usando IA
  - *Categoria:* ia
  - *Uso/Exemplos:* `!imagine um astronauta andando a cavalo na lua em aquarela`, `!imagine cyberpunk city at night`

---

### 📁 Módulo: `CantadaCommand.js`
**Sobre:** Envia cantadas engraçadas e espirituosas para descontrair no grupo

**Tags:** `cantada,zoeira,romance,flerte,humor,diversao`

**Detalhes Técnicos:** Sorteia frases da lista ou variável de cantadas e processa menções de membros do grupo

#### Comandos:
- **`!cantada`**: Envia uma cantada aleatória (ou direcionada a um usuário mencionado)
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!cantada`, `!cantada @fulano`

---

### 📁 Módulo: `ComfyUICommands.js`
**Sobre:** Geração de imagens via workflow personalizado ComfyUI (Desativado / Legado)

**Tags:** `comfyui,ia,legado`

**Detalhes Técnicos:** Submete jobs para API ComfyUI, monitora progresso via WebSocket/polling e retorna imagem gerada com controle de métricas

---

### 📁 Módulo: `Copa2026.js`
**Sobre:** Acompanhamento em tempo real da Copa do Mundo 2026

**Tags:** `copa,copa 2026,futebol,jogos,tabela,estadios,selecoes,world cup`

**Detalhes Técnicos:** Consulta API externa de futebol com tabelas, jogos, estádios, grupos, classificação, estatísticas e notificações automáticas de partidas

#### Comandos:
- **`!copa`**: Exibe o menu principal de opções e comandos da Copa 2026
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa`
- **`!copa-hoje`**: Mostra todos os jogos da Copa agendados para a data de hoje
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-hoje`
- **`!copa-jogos`**: Lista próximos jogos ou partidas de uma seleção/data específica
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-jogos`, `!copa-jogos Brasil`
- **`!copa-tabela`**: Exibe a classificação e tabela dos grupos da Copa
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-tabela`, `!copa-tabela A`
- **`!copa-time`**: Mostra informações, elenco e jogos de uma seleção
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-time Brasil`, `!copa-time Argentina`
- **`!copa-jogo`**: Exibe detalhes de uma partida específica pelo ID
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-jogo 1`
- **`!copa-estadios`**: Lista os 16 estádios oficiais da Copa do Mundo
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-estadios`
- **`!copa-seguir`**: Ativa ou desativa notificações automáticas de gols e partidas de um time
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!copa-seguir Brasil`

---

### 📁 Módulo: `CorreiosCommands.js`
**Sobre:** Rastreamento e monitoramento de encomendas dos Correios

**Tags:** `correios,rastreio,encomenda,pacote,sedex,pac`

**Detalhes Técnicos:** Consulta API de rastreamento postal, armazena pacotes em banco SQLite e notifica automaticamente alterações de status

#### Comandos:
- **`!correios`**: Consulta o status de um código de rastreio ou adiciona para monitoramento
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!correios AA123456789BR`, `!correios AA123456789BR Celular novo`
- **`!correios-lista`**: Lista todas as encomendas que estão sendo rastreadas no chat
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!correios-lista`
- **`!correios-del`**: Remove um pacote do monitoramento
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!correios-del AA123456789BR`

---

### 📁 Módulo: `DataShare.js`
**Sobre:** Compartilhamento e importação de variáveis customizadas entre grupos e chats

**Tags:** `variaveis,compartilhar,backup,exportar,importar,dados`

**Detalhes Técnicos:** Serializa e desserializa variáveis do banco de dados permitindo transporte seguro entre instâncias

#### Comandos:
- **`!compartilhar`**: Gera um código de compartilhamento para uma variável customizada
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!compartilhar nome_da_variavel`

---

### 📁 Módulo: `DiceCommands.js`
**Sobre:** Rolagem de dados poliédricos para jogos de RPG de mesa e sorteios

**Tags:** `dados,dado,rpg,roll,d20,d6,d10,sorteio,aleatorio`

**Detalhes Técnicos:** Interpreta expressões clássicas de RPG no formato NdS (ex: 2d20+5, 1d100, 3d6) com suporte a modificadores e somatórios

#### Comandos:
- **`!roll`**: Rola dados poliédricos com base na notação de RPG
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roll 1d20`, `!roll 2d6+3`, `!roll 1d100`

---

### 📁 Módulo: `DonationCommands.js`
**Sobre:** Informações sobre doações, apoio financeiro e vantagens exclusivas para apoiadores

**Tags:** `doar,doacao,pix,ajuda,apoiar,crowdfunding,vantagens,bonus`

**Detalhes Técnicos:** Exibe opções de apoio (Pix, QR Code, Tipa.ai) e calcula vantagens nos jogos (Pesca, Slots, Waifus, Pinto)

#### Comandos:
- **`!doar`**: Exibe as opções de doação e chave Pix para apoiar o projeto
  - *Categoria:* geral
  - *Uso/Exemplos:* `!doar`
- **`!doar-vantagens`**: Exibe todas as vantagens e bônus de doadores e o que você já ganhou
  - *Categoria:* geral
  - *Uso/Exemplos:* `!doar-vantagens`, `!vantagens`

---

### 📁 Módulo: `EmojiKitchenCommands.js`
**Sobre:** Combinação e fusão de emojis (Emoji Kitchen do Google)

**Tags:** `emoji,emojis,figurinha,sticker,kitchen,misturar,combinar`

**Detalhes Técnicos:** Consulta o repositório de assets do Google Emoji Kitchen e gera figurinhas transparentes com a fusão de dois emojis

#### Comandos:
- **`!emojikitchen`**: Funde dois emojis em uma figurinha única e criativa
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!emojikitchen 🐱 🚀`, `!emojikitchen 🐶 🍕`

---

### 📁 Módulo: `FileConversions.js`
**Sobre:** Conversão entre diversos formatos de arquivos de mídia (áudio, vídeo, imagem)

**Tags:** `conversao,converter,audio,video,mp3,mp4,ffmpeg`

**Detalhes Técnicos:** Utiliza ffmpeg e sharp para processar formatos de mensagens citadas, extraindo áudios ou convertendo vídeos

#### Comandos:
- **`!tomp3`**: Converte um vídeo ou áudio citado para o formato MP3
  - *Categoria:* midia
  - *Uso/Exemplos:* `!tomp3 (em resposta a um áudio ou vídeo)`
- **`!tomp4`**: Converte uma figurinha animada ou GIF para o formato de vídeo MP4
  - *Categoria:* midia
  - *Uso/Exemplos:* `!tomp4 (em resposta a uma figurinha ou gif)`

---

### 📁 Módulo: `FileManager.js`
**Sobre:** Gerenciador de armazenamento de arquivos e mídias do bot

**Tags:** `arquivos,pastas,download,salvar,storage,gerenciamento`

**Detalhes Técnicos:** Manipula leitura, upload, download e listagem de arquivos salvos em disco vinculados a pastas e variáveis

#### Comandos:
- **`!pastas`**: Lista as pastas de arquivos públicas ou do grupo
  - *Categoria:* arquivos
  - *Uso/Exemplos:* `!pastas`
- **`!p-criar`**: Cria uma nova pasta para armazenar arquivos
  - *Categoria:* arquivos
  - *Uso/Exemplos:* `!p-criar memes`
- **`!p-enviar`**: Salva uma mídia citada dentro de uma pasta
  - *Categoria:* arquivos
  - *Uso/Exemplos:* `!p-enviar memes (em resposta a uma foto/vídeo)`
- **`!p-baixar`**: Baixa ou envia um arquivo armazenado em uma pasta
  - *Categoria:* arquivos
  - *Uso/Exemplos:* `!p-baixar memes foto.jpg`
- **`!p-excluir`**: Exclui uma pasta ou arquivo salvo
  - *Categoria:* arquivos
  - *Uso/Exemplos:* `!p-excluir memes foto.jpg`

---

### 📁 Módulo: `FishingGame.js`
**Sobre:** Jogo de pescaria completo com iscas, varas, peixes lendários, inventário e rankings

**Tags:** `pesca,pescaria,peixe,iscas,game,ranking,inventario,rpg`

**Detalhes Técnicos:** Sistema de probabilidades por bioma e horário, loja de equipamentos, buffs, persistência SQLite e comércio de peixes

#### Comandos:
- **`!pescar`**: Lança a linha na água para pescar peixes, itens ou tesouros
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pescar`
- **`!pesca-iscas`**: Exibe seu inventário de iscas e opções de compra/coleta
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-iscas`
- **`!pesca-ranking`**: Exibe os melhores pescadores do grupo por pontuação ou peixes lendários
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-ranking`
- **`!pescados`**: Lista os peixes que você já pescou e seu histórico de capturas
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pescados`
- **`!pesca-info`**: Mostra informações, guia de varas, iscas e biomas da pescaria
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-info`
- **`!pesca-lendas`**: Exibe o livro de peixes lendários capturados
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-lendas`
- **`!pesca-reset`**: Reseta os dados de pescaria do grupo (Apenas Administradores)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-reset`
- **`!pesca-abandonar`**: Limpa seu inventário de peixes após confirmação
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!pesca-abandonar`

---

### 📁 Módulo: `FlightCommands.js`
**Sobre:** Rastreamento de vôos ao vivo, painel de aeroportos, consulta ANAC RAB e radar aéreo

**Detalhes Técnicos:** Integração com redes ADS-B (adsb.lol e OpenSky), Registro Aeronáutico Brasileiro da ANAC oficial, NOAA Aviation Weather e envio nativo de localização no WhatsApp quando em voo

---

### 📁 Módulo: `FoodTracker.js`
**Sobre:** Registro e acompanhamento diário de refeições e hábitos alimentares do grupo

**Tags:** `comida,alimentacao,dieta,saude,refeicao,tracker,calorias`

**Detalhes Técnicos:** Armazena logs diários de alimentação por usuário em SQLite, gera resumos e calcula estatísticas de consumo

#### Comandos:
- **`!comida`**: Registra o que você acabou de comer ou beber
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!comida Almoço: arroz, feijão e frango`, `!comida Maçã e suco de laranja`
- **`!comida-lista`**: Lista todas as refeições registradas pelos membros do grupo hoje
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!comida-lista`
- **`!comida-info`**: Exibe seu resumo e estatísticas alimentares
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!comida-info`

---

### 📁 Módulo: `GamingFreebies.js`
**Sobre:** Consulta jogos grátis disponíveis por tempo limitado em plataformas como Steam, Epic Games e GOG

**Tags:** `jogos,games,gratis,freebies,epic games,steam,promocoes`

**Detalhes Técnicos:** Scraping e integração com APIs de feeds de promoções de games para obter títulos disponíveis gratuitamente

#### Comandos:
- **`!jogosgratis`**: Exibe a lista de jogos gratuitos disponíveis no momento para resgate
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!jogosgratis`

---

### 📁 Módulo: `GeneralCommands.js`
**Sobre:** Comandos gerais e utilitários essenciais do bot (status, apelido, avisos, etc.)

**Tags:** `geral,status,sistema,ping,apelido,avisos,utilidades`

**Detalhes Técnicos:** Obtém métricas do sistema operacional, gerencia apelidos no banco e coordena mensagens de aviso

#### Comandos:
- **`!status`**: Exibe o status do bot, tempo online, memória e latência
  - *Categoria:* geral
  - *Uso/Exemplos:* `!status`
- **`!avisos`**: Exibe o canal de avisos e novidades da comunidade do bot
  - *Categoria:* geral
  - *Uso/Exemplos:* `!avisos`
- **`!apelido`**: Define ou altera o seu apelido de exibição no grupo
  - *Categoria:* geral
  - *Uso/Exemplos:* `!apelido Moothz`, `!apelido Rei do Zap`
- **`!codigo`**: Exibe o link do repositório de código-fonte do bot
  - *Categoria:* geral
  - *Uso/Exemplos:* `!codigo`
- **`!atencao`**: Envia um alerta sonoro/visual para chamar a atenção no chat
  - *Categoria:* geral
  - *Uso/Exemplos:* `!atencao`

---

### 📁 Módulo: `GiphyCommands.js`
**Sobre:** Pesquisa e envio de GIFs animados através da API do Giphy

**Tags:** `gif,giphy,animacao,memes,busca`

**Detalhes Técnicos:** Consulta endpoints de busca do Giphy, faz download do GIF/MP4 e envia como vídeo curto ou animação

#### Comandos:
- **`!gif`**: Pesquisa e envia um GIF animado do Giphy
  - *Categoria:* busca
  - *Uso/Exemplos:* `!gif gatinho dancando`, `!gif parabens`, `!gif risada`

---

### 📁 Módulo: `GroupCommands.js`
**Sobre:** Comandos úteis para membros e interações gerais em grupos

**Tags:** `grupo,convite,apagar,membros,interacao`

**Detalhes Técnicos:** Manipula dados do grupo, apagar mensagens próprias do bot, links de convite e lista de grupos

#### Comandos:
- **`!convite`**: Gera o link de convite do grupo atual
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!convite`
- **`!grupao`**: Exibe a lista de grupos públicos parceiros do bot
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!grupao`
- **`!apagar`**: Apaga uma mensagem que foi enviada pelo bot (respondendo a ela)
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!apagar (em resposta a uma mensagem do bot)`

---

### 📁 Módulo: `HoroscopoCommands.js`
**Sobre:** Previsões diárias de horóscopo e astrologia para todos os signos do zodíaco

**Tags:** `horoscopo,signos,astrologia,zodiaco,previsao,aries,touro`

**Detalhes Técnicos:** Web scraping de portais de astrologia com cache diário e detecção inteligente de signos por texto

#### Comandos:
- **`!horoscopo`**: Consulta a previsão astrológica diária para o seu signo
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!horoscopo aries`, `!horoscopo leao`, `!horoscopo escorpiao`

---

### 📁 Módulo: `ImageManipulation.js`
**Sobre:** Efeitos visuais, filtros e manipulação artística em imagens e fotos

**Tags:** `imagem,efeitos,filtros,removebg,neon,pixelate,oil,sketch,distorcer,fotos`

**Detalhes Técnicos:** Aplica transformações gráficas com Sharp e ImageMagick (remoção de fundo, pixelate, distorção, neon, pintura a óleo, sketch)

#### Comandos:
- **`!removebg`**: Remove o fundo de uma imagem usando inteligência artificial
  - *Categoria:* midia
  - *Uso/Exemplos:* `!removebg (em resposta a uma foto)`
- **`!distort`**: Aplica distorção cômica e deformação na imagem
  - *Categoria:* midia
  - *Uso/Exemplos:* `!distort (em resposta a uma foto)`
- **`!neon`**: Aplica efeito de iluminação neon sobre a imagem
  - *Categoria:* midia
  - *Uso/Exemplos:* `!neon (em resposta a uma foto)`
- **`!oil`**: Transforma a imagem em efeito de pintura a óleo
  - *Categoria:* midia
  - *Uso/Exemplos:* `!oil (em resposta a uma foto)`
- **`!pixelate`**: Aplica efeito retrô de pixelização na imagem
  - *Categoria:* midia
  - *Uso/Exemplos:* `!pixelate (em resposta a uma foto)`
- **`!sketch`**: Converte a imagem em um desenho a lápis / esboço
  - *Categoria:* midia
  - *Uso/Exemplos:* `!sketch (em resposta a uma foto)`

---

### 📁 Módulo: `ImdbCommands.js`
**Sobre:** Busca de filmes, séries e programas de TV no IMDb / TMDB

**Tags:** `filmes,series,cinema,imdb,tmdb,filme,assistir,sinopse,nota`

**Detalhes Técnicos:** Consulta APIs de cinema para obter sinopse, elenco, nota IMDb, pôster oficial e ano de lançamento

#### Comandos:
- **`!imdb`**: Busca informações, nota e sinopse de um filme ou série
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!imdb Breaking Bad`, `!imdb Interestelar`, `!imdb O Poderoso Chefao`

---

### 📁 Módulo: `LastFMCommands.js`
**Sobre:** Integração com Last.fm para exibir músicas ouvidas recentemente e scrobbles

**Tags:** `musica,lastfm,scrobble,ouuvindo,faixa,artista,album`

**Detalhes Técnicos:** Chama a API oficial do Last.fm para ler faixas recentes, artistas mais ouvidos e capas de álbum

#### Comandos:
- **`!lastfm`**: Mostra a música que um usuário do Last.fm está ouvindo agora
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!lastfm seu_usuario`, `!lastfm`

---

### 📁 Módulo: `LembretesCommands.js`
**Sobre:** Sistema de agendamento de lembretes e alertas temporizados

**Tags:** `lembrete,lembrar,alarme,agenda,tempo,notificacao`

**Detalhes Técnicos:** Parser de linguagem natural com chrono-node para datas/horas, agendamento de timers e persistência em SQLite

#### Comandos:
- **`!lembrar`**: Cria um novo lembrete com data, hora ou tempo relativo
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!lembrar em 10 minutos tirar o lixo`, `!lembrar amanha as 14h reuniao importante`
- **`!lembretes`**: Lista todos os seus lembretes ativos
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!lembretes`
- **`!l-cancelar`**: Cancela um lembrete ativo pelo ID
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!l-cancelar 42`

---

### 📁 Módulo: `ListCommands.js`
**Sobre:** Criação e gerenciamento de listas interativas e votações no grupo

**Tags:** `listas,lista,compras,tarefas,afazeres,votacao,organizacao`

**Detalhes Técnicos:** Gerencia listas compartilhadas com itens marcáveis, adição dinâmica e suporte a reações por emoji

#### Comandos:
- **`!listas`**: Mostra todas as listas ativas no grupo
  - *Categoria:* listas
  - *Uso/Exemplos:* `!listas`
- **`!lc`**: Cria uma nova lista simples
  - *Categoria:* listas
  - *Uso/Exemplos:* `!lc Mercado (arroz, feijao, carne)`
- **`!lct`**: Cria uma lista de tarefas interativa
  - *Categoria:* listas
  - *Uso/Exemplos:* `!lct Preparativos da festa`
- **`!ld`**: Deleta uma lista existente
  - *Categoria:* listas
  - *Uso/Exemplos:* `!ld 1`
- **`!le`**: Exibe os itens detalhados de uma lista
  - *Categoria:* listas
  - *Uso/Exemplos:* `!le 1`
- **`!ls`**: Adiciona um novo item a uma lista existente
  - *Categoria:* listas
  - *Uso/Exemplos:* `!ls 1 Comprar refrigerante`
- **`!lt`**: Alterna a marcação de conclusão de um item da lista
  - *Categoria:* listas
  - *Uso/Exemplos:* `!lt 1 2`
- **`!lr`**: Remove um item específico de uma lista
  - *Categoria:* listas
  - *Uso/Exemplos:* `!lr 1 2`

---

### 📁 Módulo: `LogicSequenceGame.js`
**Sobre:** Jogo de quebra-cabeça e dedução de sequências lógicas e matemáticas

**Tags:** `sequencia,logica,raciocinio,game,jogos,ranking,desafio`

**Detalhes Técnicos:** Gera padrões de sequências numéricas e lógicas, computa tentativas e calcula pontuação para ranking SQLite

#### Comandos:
- **`!sequencia`**: Inicia um desafio de sequência lógica
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!sequencia`
- **`!seq`**: Envia a resposta para a sequência atual
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!seq 16`, `!seq 42`
- **`!sequencia-ranking`**: Exibe o ranking de maiores pontuadores de lógica
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!sequencia-ranking`

---

### 📁 Módulo: `LolBuild.js`
**Sobre:** Consulta rápida de builds, runas, talentos e itens para League of Legends

**Tags:** `lol,league of legends,build,runas,campeao,moba,riot`

**Detalhes Técnicos:** Gera links diretos e busca dados otimizados para o campeão selecionado em portais de estatísticas de LoL

#### Comandos:
- **`!lol-build`**: Obtém link com a build atualizada e runas de um campeão do LoL
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!lol-build Yasuo`, `!lol-build Jinx`, `!lol-build Ahri`

---

### 📁 Módulo: `Menu.js`
**Sobre:** Menu de comandos dinâmico e categorizado com navegação completa

**Tags:** `menu,ajuda,comandos,help,lista de comandos,navegacao`

**Detalhes Técnicos:** Lê todos os comandos carregados no bot, agrupa por categoria segundo a ordem do MenuOrder.js e formata a resposta

#### Comandos:
- **`!cmd`**: Exibe o menu principal com todas as categorias e comandos do bot
  - *Categoria:* geral
  - *Uso/Exemplos:* `!cmd`, `!cmd jogos`, `!cmd ia`, `!cmd midia`
- **`!cmd-grupo`**: Exibe os comandos voltados para o uso no grupo
  - *Categoria:* geral
  - *Uso/Exemplos:* `!cmd-grupo`
- **`!cmd-gerenciamento`**: Exibe os comandos de administração e gerenciamento do grupo
  - *Categoria:* geral
  - *Uso/Exemplos:* `!cmd-gerenciamento`

---

### 📁 Módulo: `MenuOrder.js`
**Sobre:** Configuração de ordenação de categorias e prioridade de comandos no menu principal

**Tags:** `menu,configuracao,ordem,emojis,categorias`

**Detalhes Técnicos:** Exporta as constantes COMMAND_ORDER e CATEGORY_EMOJIS utilizadas para formatar a interface de ajuda

---

### 📁 Módulo: `MetarStatistics.js`
**Sobre:** Consulta meteorológica de aviação METAR e TAF para aeródromos e aeroportos

**Tags:** `metar,aviacao,aeroporto,icao,tempo,meteorologia,voo,piloto`

**Detalhes Técnicos:** Consulta a base de dados da REDEMET e APIs aeronáuticas para decodificar boletins meteorológicos por código ICAO

#### Comandos:
- **`!metar`**: Consulta o informe meteorológico de aviação METAR para um aeroporto (Código ICAO)
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!metar SBGR`, `!metar SBRJ`, `!metar SBGL`

---

### 📁 Módulo: `MuNewsCommands.js`
**Sobre:** Feed de notícias, atualizações e changelogs de servidores Mu Online

**Tags:** `mu,munews,noticias,mu online,mmorpg,jogos`

**Detalhes Técnicos:** Realiza web scraping periódico e sob demanda em fóruns/sites oficiais de Mu Online com notificações

#### Comandos:
- **`!munews`**: Exibe as últimas notícias e atualizações dos servidores de Mu Online
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!munews`

---

### 📁 Módulo: `MyInstantsAudioSearch.js`
**Sobre:** Pesquisa e envio instantâneo de áudios e memes do MyInstants

**Tags:** `myinstants,audios,memes,sons,efeitos sonoros,audio,som`

**Detalhes Técnicos:** Faz web scraping e buscas no site MyInstants, baixa o arquivo de áudio MP3 e envia como mensagem de voz / áudio

#### Comandos:
- **`!audio`**: Pesquisa e envia um áudio do site MyInstants
  - *Categoria:* busca
  - *Uso/Exemplos:* `!audio vinheta globo`, `!audio vinheta globo 1`, `!audio acertou mizeravi 1`
- **`!som`**: Pesquisa e envia um áudio do site MyInstants (alias para !audio)
  - *Categoria:* busca
  - *Uso/Exemplos:* `!som vinheta globo`, `!som acertou mizeravi 1`

---

### 📁 Módulo: `NASA.js`
**Sobre:** Imagens astronômicas diárias (APOD) e dados espaciais fornecidos pela NASA

**Tags:** `nasa,espaco,astronomia,apod,planetas,estrelas,terra`

**Detalhes Técnicos:** Consome a API oficial da NASA (Astronomy Picture of the Day e EPIC Earth Images) com traduções e informações detalhadas

#### Comandos:
- **`!apod`**: Exibe a Foto Astronômica do Dia da NASA com explicação traduzida
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!apod`
- **`!epic`**: Exibe as fotos mais recentes da Terra capturadas pelo satélite EPIC da NASA
  - *Categoria:* cultura
  - *Uso/Exemplos:* `!epic`

---

### 📁 Módulo: `OcrCommands.js`
**Sobre:** Reconhecimento óptico de caracteres (OCR) para extrair texto de fotos e documentos

**Tags:** `ocr,texto,extrair texto,imagem para texto,leitura,scan`

**Detalhes Técnicos:** Processa imagens enviadas ou citadas através de engines de OCR retornando o texto extraído

#### Comandos:
- **`!ocr`**: Lê e extrai todo o texto contido em uma imagem
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!ocr (em resposta a uma foto ou imagem com texto)`

---

### 📁 Módulo: `PintoGame.js`
**Sobre:** Brincadeira de medição diária de tamanho com ranking cômico do grupo

**Tags:** `pinto,tamanho,ranking,zoeira,brincadeira,diversao`

**Detalhes Técnicos:** Gera tamanho randômico por algoritmo diário determinístico por usuário, com mensagens de humor e ranking SQLite

#### Comandos:
- **`!pinto`**: Mede seu tamanho do dia e exibe seu resultado
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!pinto`
- **`!pinto-ranking`**: Exibe o ranking dos maiores e menores tamanhos do grupo
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!pinto-ranking`
- **`!pinto-reset`**: Reseta os registros do jogo no grupo (Apenas Administradores)
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!pinto-reset`

---

### 📁 Módulo: `PlacasCommands.js`
**Sobre:** Consulta de veículos por placa no padrão brasileiro e Mercosul com tabela FIPE

**Tags:** `placa,carro,moto,veiculo,fipe,consulta,automovel`

**Detalhes Técnicos:** Consulta APIs veiculares públicas para obter modelo, ano, cor, cidade/UF e histórico de preços da tabela FIPE

#### Comandos:
- **`!placa`**: Consulta dados e histórico de preço FIPE de um veículo pela placa
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!placa ABC1234`, `!placa ABC1D23`

---

### 📁 Módulo: `PsnCommands.js`
**Sobre:** Consulta de perfil, troféus e jogos recentes na PlayStation Network (PSN)

**Tags:** `psn,playstation,sony,trofeus,ps4,ps5,games,jogos`

**Detalhes Técnicos:** Utiliza PSN API para extrair nível da conta, troféus (Platina, Ouro, Prata, Bronze) e avatar do jogador

#### Comandos:
- **`!psn`**: Consulta o perfil e troféus de uma conta PSN
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!psn SeuPSNID`

---

### 📁 Módulo: `QrCommands.js`
**Sobre:** Geração e leitura de QR Codes e QR Code de pagamento Pix

**Tags:** `qr,qrcode,pix,gerador qr,codigo`

**Detalhes Técnicos:** Gera imagens QR Code usando a biblioteca qr-image com suporte a payload Pix e texto livre

#### Comandos:
- **`!qr`**: Gera uma imagem de QR Code a partir de um texto ou link
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!qr https://google.com`, `!qr Minha senha wifi`
- **`!qr-pix`**: Gera um QR Code de cobrança Pix
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!qr-pix chave@pix.com 50.00 Descricao`

---

### 📁 Módulo: `Raffles.js`
**Sobre:** Monitoramento e consulta de rifas e ações entre amigos

**Tags:** `rifa,sorteio,bilhetes,cotas,premios,acao`

**Detalhes Técnicos:** Faz scraping de plataformas de rifas, armazena em banco de dados SQLite e notifica o grupo automaticamente ao atingir metas percentuais de vendas

#### Comandos:
- **`!raffle <link>`**: Consulta o status atual de uma rifa ou ação
  - *Categoria:* busca
  - *Uso/Exemplos:* `!raffle https://...`
- **`!raffle-seguir <link>`**: Inicia o monitoramento de uma rifa com alertas automáticos em 10%, 15%, 25%, 50%, 75%, 90%, 99% e 100%
  - *Categoria:* busca
  - *Uso/Exemplos:* `!raffle-seguir https://...`
- **`!raffle-parar <link>`**: Encerra o monitoramento de uma rifa no grupo
  - *Categoria:* busca
  - *Uso/Exemplos:* `!raffle-parar https://...`
- **`!raffle-listar`**: Lista todas as rifas atualmente monitoradas pelo grupo
  - *Categoria:* busca
  - *Uso/Exemplos:* `!raffle-listar`

---

### 📁 Módulo: `RagnarokCommands.js`
**Sobre:** Mini-RPG temático inspirado no clássico Ragnarök Online (RagNavena)

**Tags:** `ragnarok,ragnavena,rpg,jogos,monstros,batalha,classes`

**Detalhes Técnicos:** Sistema de classes, monstros, drops, equipamentos, batalhas por turnos e persistência em banco de dados SQLite

#### Comandos:
- **`!ragnavena`**: Acessa o menu principal e jogo do RagNavena
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!ragnavena`
- **`!ragnarok-reset`**: Reseta os dados do jogo no grupo (Apenas Administradores)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!ragnarok-reset`

---

### 📁 Módulo: `RankingMessages.js`
**Sobre:** Monitoramento de atividade de mensagens e ranking de membros mais faladores do grupo

**Tags:** `faladores,ranking,mensagens,atividade,membros,estatisticas`

**Detalhes Técnicos:** Registra contagem de mensagens enviadas por usuário em SQLite e gera relatórios periódicos de atividade

#### Comandos:
- **`!faladores`**: Exibe o ranking com os membros mais ativos do grupo
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!faladores`
- **`!faladores-limpeza`**: Lista membros inativos que não enviaram mensagens recentes
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!faladores-limpeza`
- **`!faladores-reset`**: Reseta a contagem de mensagens do grupo (Apenas Administradores)
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!faladores-reset`

---

### 📁 Módulo: `RelacionamentoCommands.js`
**Sobre:** Sistema de relacionamentos, casamentos e amizades virtuais no grupo

**Tags:** `casamento,casar,divorcio,relacionamento,amor,zoeira,casais,celibar,celibato`

**Detalhes Técnicos:** Gerencia propostas de casamento, divórcios, lista de casais do grupo e afinidades com dados em SQLite

#### Comandos:
- **`!casar`**: Pede um membro do grupo em casamento
  - *Categoria:* interacao
  - *Uso/Exemplos:* `!casar @fulano`
- **`!separar`**: Termina o relacionamento por menção, número da lista ou telefone
  - *Categoria:* interacao
  - *Uso/Exemplos:* `!separar @fulano`, `!separar 1`, `!separar 551199999999`
- **`!celibar`**: Termina todos os seus relacionamentos no grupo e adere ao celibato
  - *Categoria:* interacao
  - *Uso/Exemplos:* `!celibar`
- **`!divorcio`**: Pede o divórcio do seu parceiro atual no grupo
  - *Categoria:* interacao
  - *Uso/Exemplos:* `!divorcio`
- **`!relacionamentos`**: Lista todos os casamentos e uniões ativas no grupo
  - *Categoria:* interacao
  - *Uso/Exemplos:* `!relacionamentos`

---

### 📁 Módulo: `RiotGamesCommands.js`
**Sobre:** Consultas de dados e perfis para jogos da Riot Games (League of Legends, Valorant, Wild Rift)

**Tags:** `riot,lol,valorant,wildrift,elo,estatisticas,games`

**Detalhes Técnicos:** Integra com APIs de terceiros para buscar elo, taxa de vitória, estatísticas e histórico de partidas

#### Comandos:
- **`!valorant`**: Consulta estatísticas e elo de um jogador de Valorant
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!valorant Nick#TAG`

---

### 📁 Módulo: `RobloxCommands.js`
**Sobre:** Consulta de usuários, avatares e jogos na plataforma Roblox

**Tags:** `roblox,avatar,perfil,games,jogos`

**Detalhes Técnicos:** Consome a API pública do Roblox para buscar dados de perfil, data de criação, amigos e render de avatar

#### Comandos:
- **`!roblox`**: Consulta informações e foto do avatar de um jogador do Roblox
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roblox NomeDoJogador`

---

### 📁 Módulo: `RoletaRussaCommands.js`
**Sobre:** Jogo de Roleta Russa com silenciamento e timeout temporário dos participantes eliminados

**Tags:** `roleta,roletarussa,tiro,revólver,jogo,timeout,ranking`

**Detalhes Técnicos:** Gerencia câmara do revólver de 6 posições, remoção ou silenciamento temporário via WhatsApp Web API e ranking de sobreviventes em SQLite

#### Comandos:
- **`!roletarussa`**: Puxa o gatilho na Roleta Russa do grupo
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roletarussa`
- **`!roleta-ranking`**: Exibe o ranking de sobreviventes e mortes na roleta
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roleta-ranking`
- **`!roleta-tempo`**: Define o tempo em minutos de punição para quem morrer (Admins)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roleta-tempo 5`
- **`!roleta-silenciar [true|false|toggle]`**: Ativa ou desativa o silenciamento temporário dos jogadores mortos (Admins)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roleta-silenciar`, `!roleta-silenciar false`
- **`!roleta-reset`**: Reseta os dados da roleta russa no grupo (Admins)
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!roleta-reset`

---

### 📁 Módulo: `SearchCommands.js`
**Sobre:** Mecanismo de busca na web, imagens e Registro Aeronáutico Brasileiro (RAB)

**Tags:** `busca,pesquisa,google,web,imagens,rab,aviao,aeronave`

**Detalhes Técnicos:** Integra com engines de busca na web, DuckDuckGo/Google e banco de dados de aeronaves da ANAC

#### Comandos:
- **`!buscar`**: Realiza uma pesquisa rápida na internet
  - *Categoria:* busca
  - *Uso/Exemplos:* `!buscar historia do brasil`, `!buscar receita de bolo`
- **`!buscar-img`**: Pesquisa e envia imagens encontradas na web
  - *Categoria:* busca
  - *Uso/Exemplos:* `!buscar-img paisagem da serra`, `!buscar-img wallpaper 4k`
- **`!rab`**: Consulta dados de aeronaves pelo prefixo no Registro Aeronáutico Brasileiro da ANAC
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!rab PT-ABC`, `!rab PR-XYZ`

---

### 📁 Módulo: `SlotsGame.js`
**Sobre:** Jogo de caça-níqueis (Slots / Caça-Coisas) com moedas e prêmios colecionáveis

**Tags:** `slots,caca niquel,cassino,jogos,premios,moedas,sorte`

**Detalhes Técnicos:** Simula rolos de caça-níqueis com combinações premiadas, controle de moedas por usuário e inventário de prêmios

#### Comandos:
- **`!slots`**: Gira a máquina de caça-níqueis
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!slots`
- **`!slots-premios`**: Exibe a sua coleção de prêmios conquistados no caça-níqueis
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!slots-premios`
- **`!slots-ranking`**: Exibe o ranking dos maiores vencedores do caça-níqueis
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!slots-ranking`

---

### 📁 Módulo: `SocialMediaDownloader.js`
**Sobre:** Download unificado de vídeos, fotos e áudios de mais de 30 plataformas de redes sociais

**Tags:** `download,baixar,video,audio,instagram,tiktok,youtube,twitter,x,reddit,soundcloud,facebook`

**Detalhes Técnicos:** Utiliza Cobalt API, youtube-dl-exec e instâncias de proxy com cache inteligente em SQLite para entregar mídias em alta qualidade

#### Comandos:
- **`!baixar`**: Baixa vídeos, áudios ou fotos de links do YouTube, Instagram, TikTok, Twitter/X, Reddit, etc.
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!baixar https://vm.tiktok.com/...`, `!baixar https://instagram.com/reel/...`, `!baixar https://youtu.be/...`
- **`!ig`**: Atalho para baixar publicações, reels e stories do Instagram
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!ig https://instagram.com/p/...`
- **`!tt`**: Atalho para baixar vídeos do TikTok
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!tt https://tiktok.com/@user/video/...`
- **`!tw`**: Atalho para baixar vídeos e mídias do Twitter / X
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!tw https://x.com/user/status/...`

---

### 📁 Módulo: `SorteioCommands.js`
**Sobre:** Sistema completo de sorteios no grupo com inscrição por reações ou sorteio instantâneo

**Tags:** `sorteio,sortear,rifa,concurso,premios,ganhador`

**Detalhes Técnicos:** Gerencia sorteios com tempo limite, lista de participantes por reação/comando e escolha aleatória com histórico

#### Comandos:
- **`!sorteio`**: Inicia um novo sorteio com descrição e tempo ou exibe o sorteio em andamento
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!sorteio 10m Caixa de chocolate`, `!sorteio`
- **`!sorteio-entrar`**: Entra no sorteio ativo do grupo
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!sorteio-entrar`
- **`!sorteio-sair`**: Sai da lista de participantes do sorteio ativo
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!sorteio-sair`
- **`!sortear`**: Finaliza o sorteio ativo ou sorteia um membro aleatório do grupo imediatamente
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!sortear`
- **`!sorteios`**: Exibe o histórico de sorteios já realizados no grupo
  - *Categoria:* grupo
  - *Uso/Exemplos:* `!sorteios`

---

### 📁 Módulo: `SoundCloud.js`
**Sobre:** Busca e download direto de músicas da plataforma SoundCloud

**Tags:** `soundcloud,musica,audio,musicas,streaming,baixar`

**Detalhes Técnicos:** Utiliza soundcloud.ts para buscar faixas, baixar o stream de áudio e converter para MP3 com metadados

#### Comandos:
- **`!sc`**: Pesquisa e faz download de uma música do SoundCloud
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!sc nome da musica ou artista`, `!sc https://soundcloud.com/...`

---

### 📁 Módulo: `SpeechCommands.js`
**Sobre:** Síntese de voz (TTS) com diferentes personagens e transcrição de áudio (STT)

**Tags:** `tts,stt,voz,falar,transcrever,audio,narrador,rubao,ravena`

**Detalhes Técnicos:** Executa TTS com vozes locais/remotas e modelos Whisper para Speech-To-Text com estatísticas em SQLite

#### Comandos:
- **`!stt`**: Transcreve uma mensagem de voz ou áudio para texto
  - *Categoria:* voz
  - *Uso/Exemplos:* `!stt (em resposta a um áudio de voz)`
- **`!tts`**: Converte texto em áudio falado com voz padrão (Ravena)
  - *Categoria:* voz
  - *Uso/Exemplos:* `!tts Olá pessoal do grupo!`
- **`!tts-mulher`**: Converte texto em áudio com voz feminina
  - *Categoria:* voz
  - *Uso/Exemplos:* `!tts-mulher Bom dia a todos!`
- **`!tts-homem`**: Converte texto em áudio com voz masculina
  - *Categoria:* voz
  - *Uso/Exemplos:* `!tts-homem Atenção para o recado!`
- **`!tts-rubao`**: Converte texto em áudio com a voz cômica do Rubão do Pontaço
  - *Categoria:* voz
  - *Uso/Exemplos:* `!tts-rubao Fala minha galera do zapzap!`
- **`!tts-narrador`**: Converte texto em áudio com voz de narrador de documentário
  - *Categoria:* voz
  - *Uso/Exemplos:* `!tts-narrador E assim a história começou...`

---

### 📁 Módulo: `StableDiffusionCommands.js`
**Sobre:** Geração de imagens via inteligência artificial com Stable Diffusion (Desativado / Legado)

**Tags:** `sd,stablediffusion,ia,legado`

**Detalhes Técnicos:** Integra com APIs de Stable Diffusion WebUI / Automatic1111 enviando prompts e parâmetros de amostragem

---

### 📁 Módulo: `SteamCommands.js`
**Sobre:** Consulta de perfis, jogos e conquistas platinadas na Steam

**Tags:** `steam,platinas,conquistas,jogos,pc,games,perfil`

**Detalhes Técnicos:** Consulta a API pública da Steam e serviços de conquistas para calcular jogos com 100% de progresso

#### Comandos:
- **`!steam-platinas`**: Exibe a quantidade e lista de platinas (100% conquistas) de um jogador na Steam
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!steam-platinas VanityURLOuSteamID`

---

### 📁 Módulo: `StickerScraper.js`
**Sobre:** Busca e envia figurinhas sob demanda do portal Lovecell

**Tags:** `figa,figrandom,lovecell,sticker,figurinha,aleatoria,random,denunciar,tags,categorias`

**Detalhes Técnicos:** Faz scraping da figurinha principal no Lovecell, recorta os 85px de banner inferior e envia no formato 512x512 padrão de stickers (estático ou animado). Suporta envio de até 4 figurinhas por comando (configurável por bot via extras.stickers.maxFiga). Possui filtro NSFW com blacklist persistente e download em segundo plano para estoque offline.

#### Comandos:
- **`!figa`**: Faz scraping da figurinha principal no Lovecell (estático ou animado)
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!figa`, `!figa 4`, `!figrandom 2`, `!figa 37019`, `!figa gatos 2`
- **`!figa-tags`**: Lista todas as categorias/tags de figurinhas disponíveis e a quantidade
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!figa-tags`, `!figa-categoria`
- **`!figa-denunciar`**: Denuncia uma figurinha para o administrador (ou reaja com 🔞)
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!figa-denunciar (em resposta a uma figurinha)`, `Reação: 🔞`

---

### 📁 Módulo: `Stickers.js`
**Sobre:** Criação, recorte, corte inteligente por IA e conversão de figurinhas (stickers)

**Tags:** `sticker,figurinha,s,fig,sq,sqi,shq,stickerhq,midia,recorte,whatsapp`

**Detalhes Técnicos:** Processa imagens e vídeos com Sharp e FFmpeg, suporta enquadramento quadrado central, topo, fundo, stretch, HQ (22-25 FPS) e crop por IA

#### Comandos:
- **`!sticker`**: Converte uma imagem, vídeo ou GIF em figurinha do WhatsApp
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sticker (com imagem ou em resposta)`, `!s`
- **`!shq`**: Cria figurinha em alta taxa de quadros (22-25 FPS) mantendo as proporções originais
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!shq (com imagem/vídeo ou em resposta)`, `!stickerhq`
- **`!sqi`**: Cria figurinha quadrada com enquadramento inteligente do objeto principal via IA
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sqi (com imagem ou em resposta)`
- **`!sq`**: Cria figurinha quadrada cortada no centro
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sq (com imagem ou em resposta)`
- **`!sqc`**: Cria figurinha quadrada cortando no topo
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sqc (com imagem ou em resposta)`
- **`!sqb`**: Cria figurinha quadrada cortando na base
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sqb (com imagem ou em resposta)`
- **`!sqe`**: Cria figurinha quadrada esticada sem cortar as bordas
  - *Categoria:* stickers
  - *Uso/Exemplos:* `!sqe (com imagem ou em resposta)`

---

### 📁 Módulo: `StopGame.js`
**Sobre:** Jogo clássico de Stop / Adedonha interativo em tempo real para grupos

**Tags:** `stop,adedonha,jogos,palavras,diversao,letras`

**Detalhes Técnicos:** Sorteia letras e categorias, processa respostas dos jogadores, faz validação de palavras e pontuação

#### Comandos:
- **`!adedonha`**: Inicia uma nova rodada do jogo Stop / Adedonha
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!adedonha`, `!stop`

---

### 📁 Módulo: `StreamCommands.js`
**Sobre:** Monitoramento de lives e canais da Twitch, Kick e YouTube

**Tags:** `stream,twitch,kick,youtube,live,streamers,transmissao`

**Detalhes Técnicos:** Consulta status de canais em tempo real, monitora streamers favoritos e lista canais online no momento

#### Comandos:
- **`!streams`**: Lista todos os canais configurados para monitoramento no grupo
  - *Categoria:* streams
  - *Uso/Exemplos:* `!streams`
- **`!streamers`**: Lista os canais monitorados que estão ao vivo agora
  - *Categoria:* streams
  - *Uso/Exemplos:* `!streamers`
- **`!live`**: Consulta o status e informações de um canal da Twitch
  - *Categoria:* streams
  - *Uso/Exemplos:* `!live gaules`, `!live alanzoka`
- **`!live-kick`**: Consulta o status e informações de um canal do Kick
  - *Categoria:* streams
  - *Uso/Exemplos:* `!live-kick nome_do_canal`
- **`!topstreams`**: Exibe as transmissões com maior audiência no momento
  - *Categoria:* streams
  - *Uso/Exemplos:* `!topstreams`

---

### 📁 Módulo: `SummaryCommands.js`
**Sobre:** Resumos de conversas de grupos e interações inteligentes contextualizadas

**Tags:** `resumo,interagir,conversa,ia,mensagens,grupo`

**Detalhes Técnicos:** Armazena histórico recente de mensagens do chat e utiliza LLMs para gerar resumos concisos e intervenções bem-humoradas

#### Comandos:
- **`!resumo`**: Gera um resumo das conversas recentes e assuntos debatidos no grupo
  - *Categoria:* ia
  - *Uso/Exemplos:* `!resumo`
- **`!interagir`**: Faz o bot interagir e comentar sobre os tópicos atuais da conversa
  - *Categoria:* ia
  - *Uso/Exemplos:* `!interagir`

---

### 📁 Módulo: `TarotGame.js`
**Sobre:** Tiragem de cartas de Tarô com previsões místicas e conselhos

**Tags:** `tarot,taro,cartomante,misticismo,futuro,destino,jogos`

**Detalhes Técnicos:** Sorteia cartas do baralho de tarô com significados completos, imagens e interpretações em SQLite

#### Comandos:
- **`!tarot`**: Realiza uma tiragem de carta de Tarô com seu significado
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!tarot`

---

### 📁 Módulo: `TranslationCommands.js`
**Sobre:** Tradução de textos para diversos idiomas com detecção automática

**Tags:** `traduzir,traducao,idiomas,ingles,espanhol,portugues,translate`

**Detalhes Técnicos:** Integra com provedores de tradução para traduzir mensagens citadas ou textos informados por argumentos

#### Comandos:
- **`!traduzir`**: Traduz um texto citado ou informado para o idioma desejado
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!traduzir en Olá mundo`, `!traduzir pt (em resposta a uma mensagem)`

---

### 📁 Módulo: `WaifuCommands.js`
**Sobre:** Jogo de sorteio de waifus/husbandos (estilo Mudae) integrado com a API Waifuletes

**Tags:** `waifu,mudae,munae,jogo,anime,harem,zinthos,kakera,roleta,casamento`

**Detalhes Técnicos:** Consome a API REST local do Waifuletes para sorteio ponderado, casamentos em janela de 120s, harém global, chaves, soulmates e economia de Zinthos (💜).

#### Comandos:
- **`!waifus / !munae`**: Explica as mecânicas do jogo e lista todos os comandos e filtros disponíveis
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!waifus`, `!munae`, `!mu-ajuda`
- **`!mu-roll`**: Sorteia um personagem aleatório para o grupo (waifus e husbandos)
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-roll`, `!mu-r`, `!mu-rollm (só homens)`, `!mu-rollf (só mulheres)`
- **`!mu-casar`**: Casa com o personagem recém-sorteado dentro da janela de 120 segundos
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-casar`, `!mu-c`, `!mu-casar rem-re-zero`
- **`!mu-diario`**: Resgata a recompensa diária de Zinthos (💜)
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-diario`, `!mu-dz`, `!mu-dk`
- **`!mu-harem`**: Lista os personagens que você possui em seu harém
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-harem`, `!mu-h 2`
- **`!mu-saldo`**: Consulta seu saldo atual de Zinthos (💜)
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-saldo`, `!mu-zinthos`, `!mu-z`, `!mu-k`
- **`!mu-wishlist`**: Lista seus personagens desejados (até 100) e calcula a chance de drop no roll
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-wishlist`, `!mu-desejar <id>`, `!mu-removerdesejo <id>`
- **`!mu-chances`**: Mostra as probabilidades de drop por categoria de personagem e o bônus da Wishlist
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-chances`, `!mu-taxas`, `!mu-prob`
- **`!mu-personagens`**: Busca personagens cadastrados no catálogo por nome ou série
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-personagens Frieren`, `!mu-chars Naruto`
- **`!mu-ranking`**: Ranking dos jogadores mais ricos em Zinthos (💜)
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-ranking`, `!mu-top 10`
- **`!mu-cooldowns`**: Verifica os tempos restantes para poder rolar, casar ou resgatar o diário
  - *Categoria:* mudae
  - *Uso/Exemplos:* `!mu-cooldowns`, `!mu-cd`

---

### 📁 Módulo: `Weather.js`
**Sobre:** Consulta de clima e previsão meteorológica atualizada

**Tags:** `clima,tempo,temperatura,previsao,meteorologia,cidade`

**Detalhes Técnicos:** Consulta APIs de meteorologia para fornecer temperatura, umidade, vento e condições do tempo por cidade

#### Comandos:
- **`!clima`**: Consulta a previsão do tempo para uma cidade ou localização
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!clima São Paulo`, `!clima Rio de Janeiro`, `!clima Curitiba`

---

### 📁 Módulo: `WeatherMeteo.js`
**Sobre:** Previsão do tempo detalhada utilizando a API Open-Meteo

**Tags:** `clima,tempo,previsao,open-meteo,meteorologia,chuva`

**Detalhes Técnicos:** Geocodifica a localização e extrai previsões horárias e diárias de alta precisão via Open-Meteo

#### Comandos:
- **`!clima`**: Consulta a previsão do tempo detalhada para uma cidade
  - *Categoria:* utilidades
  - *Uso/Exemplos:* `!clima Belo Horizonte`, `!clima Salvador`, `!clima Lisboa`

---

### 📁 Módulo: `WikipediaCommands.js`
**Sobre:** Busca de resumos e artigos enciclopédicos na Wikipedia

**Tags:** `wiki,wikipedia,enciclopedia,busca,artigo,informacao`

**Detalhes Técnicos:** Consome a API da Wikipedia em português para extrair o primeiro parágrafo, imagem principal e link do artigo

#### Comandos:
- **`!wiki`**: Pesquisa um termo ou artigo na Wikipedia
  - *Categoria:* busca
  - *Uso/Exemplos:* `!wiki Albert Einstein`, `!wiki Sistema Solar`, `!wiki Inteligência Artificial`

---

### 📁 Módulo: `WildRiftBuild.js`
**Sobre:** Consulta de builds, runas e itens para League of Legends: Wild Rift

**Tags:** `wildrift,wr,build,lol,riot,mobile,games`

**Detalhes Técnicos:** Retorna links e dados otimizados de builds para campeões da versão mobile Wild Rift

#### Comandos:
- **`!wr-build`**: Obtém link com a build atualizada de um campeão do Wild Rift
  - *Categoria:* jogos
  - *Uso/Exemplos:* `!wr-build Jinx`, `!wr-build Zed`, `!wr-build Lux`

---

### 📁 Módulo: `YoutubeDownloader.js`
**Sobre:** Download de vídeos e extração de áudio do YouTube e busca de letras de músicas

**Tags:** `youtube,yt,musica,video,download,letras,audio`

**Detalhes Técnicos:** Utiliza youtube-dl-exec, APIs de busca de letras e stream pipeline para processar mídias do YouTube

#### Comandos:
- **`!yt`**: Baixa um vídeo do YouTube em formato MP4
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!yt https://youtu.be/...`, `!yt nome do video`
- **`!sr`**: Baixa o áudio de um vídeo do YouTube em formato MP3
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!sr https://youtu.be/...`, `!sr nome da musica`
- **`!letra`**: Busca e exibe a letra de uma música
  - *Categoria:* downloaders
  - *Uso/Exemplos:* `!letra Bohemian Rhapsody`, `!letra Legião Urbana Tempo Perdido`

---

### 📁 Módulo: `ZueiraCommands.js`
**Sobre:** Comandos de humor, zoeira e brincadeiras sociais para animar o grupo

**Tags:** `zoeira,humor,brincadeiras,memes,pix,aniversario,boleto,violencia,hora,data`

**Detalhes Técnicos:** Sorteia membros do grupo e processa variáveis customizadas para piadas, PIX fictício, clonagem de cartão e aniversário

#### Comandos:
- **`!violencia`**: Pratica um ato cômico de violência contra outro membro
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!violencia @fulano`
- **`!morreu`**: Envia meme de anúncio fúnebre zoeiro
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!morreu @fulano`
- **`!boleto`**: Escolhe um membro do grupo aleatoriamente para pagar um boleto
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!boleto`
- **`!clonarcartao`**: Simula uma clonagem de cartão para pagar o agiota
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!clonarcartao @fulano`
- **`!presente`**: Envia um presente zoeiro da internet para alguém
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!presente @fulano`
- **`!pix`**: Simula uma transferência fictícia pelo Ravenabank
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!pix 1000 @fulano`
- **`!aniversario`**: Parabeniza um aniversariante do grupo em grande estilo
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!aniversario @fulano`
- **`!hora`**: Informa a hora e a data atual com precisão aproximada
  - *Categoria:* zoeira
  - *Uso/Exemplos:* `!hora`, `!data`

---

## ⚙️ Comandos de Gerenciamento (!g-)
Comandos restritos aos administradores de grupos para moderação, customização e fluxos do bot.

**Sobre:** Sistema completo de gerenciamento administrativo e configuração de grupos do bot

#### `!g-setNome`
**Descrição:** ID/Nome do grupo (nome stickers, gerenciamento)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setNome`

---

#### `!g-setPrefixo`
**Descrição:** Altera o prefixo de comandos do *grupo* (padrão !)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setPrefixo`

---

#### `!g-setCustomSemPrefixo`
**Descrição:** Faz com que comandos personalizados não precisem de prefixo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setCustomSemPrefixo`

---

#### `!g-setBoasvindas`
**Descrição:** Mensagem quando alguém entra no grupo. Você pode usar as variáveis {pessoa

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setBoasvindas`

---

#### `!g-delBoasvindas`
**Descrição:** Remove um tipo de mídia específico da mensagem de boas-vindas (text, image, audio, video, sticker)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-delBoasvindas`

---

#### `!g-setDespedida`
**Descrição:** Mensagem quando alguém sai do grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setDespedida`

---

#### `!g-delDespedida`
**Descrição:** Remove um tipo de mídia específico da mensagem de despedida (text, image, audio, video, sticker)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-delDespedida`

---

#### `!g-autoStt`
**Descrição:** Ativa/desativa conversão automática de voz para texto

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-autoStt`

---

#### `!g-info`
**Descrição:** Mostra informações detalhadas do grupo (debug)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-info`

---

#### `!g-manage`
**Descrição:** Ativa o gerenciamento do grupo pelo PV do bot

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-manage`

---

#### `!g-setAutoTranslate`
**Descrição:** Define o idioma para tradução automática de todas as respostas do bot (Ex: Spanish (ES))

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setAutoTranslate`

---

#### `!g-addCmd`
**Descrição:** Cria um comando personalizado

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-addCmd`

---

#### `!g-addCmdReply`
**Descrição:** Adiciona outra resposta a um comando existente

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-addCmdReply`

---

#### `!g-delCmd`
**Descrição:** Exclui um comando personalizado

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-delCmd`

---

#### `!g-cmd-enable`
**Descrição:** Habilita comando (comandos personalizados)

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-enable`

---

#### `!g-cmd-disable`
**Descrição:** Desabilita comando (comandos personalizados)

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-disable`

---

#### `!g-cmd-setPV`
**Descrição:** A resposta do comando será enviada no PV (comandos personalizados)

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-setPV`

---

#### `!g-cmd-enviarTudo`
**Descrição:** Envia todas as respostas do comando (se houver mais de uma)

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-enviarTudo`

---

#### `!g-cmd-responder`
**Descrição:** Ativa/Desativa se o comando deve responder citando a mensagem

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-responder`

---

#### `!g-cmd-react`
**Descrição:** Reaçao quando usar o comando

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-react`

---

#### `!g-cmd-startReact`
**Descrição:** Reaçao pré-comando (útil para APIs, como loading)

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-startReact`

---

#### `!g-cmd-setAdm`
**Descrição:** Define que apenas admins podem usar um comando

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-setAdm`

---

#### `!g-cmd-setInteragir`
**Descrição:** Define que comando seja usado nas interações aleatórias

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-setInteragir`

---

#### `!g-cmd-cd`
**Descrição:** Define o cooldown (em segundos) de um comando personalizado. Uso: !g-cmd-cd <comando> <segundos>

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-cd`

---

#### `!g-cmd-setHoras`
**Descrição:** Define horários permitidos para um comando

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-setHoras`

---

#### `!g-cmd-setDias`
**Descrição:** Define dias permitidos para um comando

**Categoria:** custom-cmds

**Exemplo de uso:** `!g-cmd-setDias`

---

#### `!g-filtro-palavra`
**Descrição:** Detecta e Apaga mensagens com a palavra/frase especificada

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-palavra`

---

#### `!g-filtro-regex`
**Descrição:** Detecta e Apaga mensagens que correspondam à expressão regular (regex) especificada

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-regex \b(palavra1|palavra2)\b`

---

#### `!g-filtro-links`
**Descrição:** Detecta e Apaga mensagens com links

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-links`

---

#### `!g-filtro-permitirLink`
**Descrição:** Adiciona/remove ou lista domínios e padrões de links permitidos

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-permitirLink`

---

#### `!g-filtro-linksConfiaveis`
**Descrição:** Adiciona ou remove principais sites confiáveis da lista de links permitidos

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-linksConfiaveis`

---

#### `!g-filtro-permitirAdm`
**Descrição:** Habilita/desabilita a filtragem de mensagens de administradores do grupo

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-permitirAdm`

---

#### `!g-filtro-pessoa`
**Descrição:** Detecta e Apaga mensagens desta pessoa (Marcar com @)

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-pessoa`

---

#### `!g-filtro-nsfw`
**Descrição:** Ativa/desativa ou define a intensidade (0-100) do filtro NSFW

**Categoria:** filtros

**Exemplo de uso:** `!g-filtro-nsfw`

---

#### `!g-banirSpammers`
**Descrição:** Ativa/desativa o monitoramento e banimento de spammers (DDI 62/63/380) no grupo

**Categoria:** filtros

**Exemplo de uso:** `!g-banirSpammers`

---

#### `!g-apelido`
**Descrição:** Define apelido de *outro membro* no grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-apelido`

---

#### `!g-ignorar`
**Descrição:** O bot irá ignorar as mensagens desta pessoa

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-ignorar`

---

#### `!g-mute`
**Descrição:** Desativa/ativa comando com a palavra especificada

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-mute`

---

#### `!g-muteCategoria [categoria]`
**Descrição:** Desativa/ativa todos os comandos da categoria especificada (ex: canais, outros, jogos, downloaders, ia, etc)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-muteCategoria canais`

---

#### `!g-customAdmin`
**Descrição:** Adiciona pessoas como administradoras fixas do bot no grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-customAdmin`

---

#### `!g-pausar`
**Descrição:** Pausa/retoma a atividade do bot no grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-pausar`

---

#### `!g-interagir`
**Descrição:** Ativa/desativa interações automáticas do bot

**Categoria:** interacao

**Exemplo de uso:** `!g-interagir`

---

#### `!g-interagir-cmd`
**Descrição:** Ativa/desativa interações automáticas do bot usando comandos do grupo

**Categoria:** interacao

**Exemplo de uso:** `!g-interagir-cmd`

---

#### `!g-interagir-cd`
**Descrição:** Define o tempo de espera entre interações automáticas

**Categoria:** interacao

**Exemplo de uso:** `!g-interagir-cd`

---

#### `!g-interagir-chance`
**Descrição:** Define a chance de ocorrer interações automáticas

**Categoria:** interacao

**Exemplo de uso:** `!g-interagir-chance`

---

#### `!g-interagir-proporcao`
**Descrição:** Define a proporção entre comandos e IA para interações automáticas

**Categoria:** interacao

**Exemplo de uso:** `!g-interagir-proporcao`

---

#### `!g-fechar`
**Descrição:** Fecha o grupo ou agenda fechamento automático

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-fechar`

---

#### `!g-fechar-lista`
**Descrição:** Lista agendamentos de fechamento do grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-fechar-lista`

---

#### `!g-fechar-del`
**Descrição:** Remove agendamento de fechamento pelo ID

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-fechar-del A`

---

#### `!g-abrir`
**Descrição:** Abre o grupo ou agenda abertura automática

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-abrir`

---

#### `!g-abrir-lista`
**Descrição:** Lista agendamentos de abertura do grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-abrir-lista`

---

#### `!g-abrir-del`
**Descrição:** Remove agendamento de abertura pelo ID

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-abrir-del A`

---

#### `!g-notificar-grupoFechado`
**Descrição:** Ativa/desativa a notificação quando o grupo é fechado

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-notificar-grupoFechado`

---

#### `!g-notificar-grupoAberto`
**Descrição:** Ativa/desativa a notificação quando o grupo é aberto

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-notificar-grupoAberto`

---

#### `!g-setPersonalidade`
**Descrição:** Define uma personalidade para os comandos de IA (max. 1500 caracteres)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setPersonalidade`

---

#### `!g-setApelido`
**Descrição:** Define apelido de *outro membro* no grupo (@marcar_pessoa)

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setApelido`

---

#### `!g-twitch-canal`
**Descrição:** Adiciona/remove canal da Twitch para monitoramento

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-canal`

---

#### `!g-twitch-mudarTitulo`
**Descrição:** Ativa/desativa mudança de título do grupo para eventos da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-mudarTitulo`

---

#### `!g-twitch-titulo`
**Descrição:** Define título do grupo para eventos de canal da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-titulo`

---

#### `!g-twitch-fotoGrupo`
**Descrição:** Define foto do grupo para eventos de canal da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-fotoGrupo`

---

#### `!g-twitch-midia`
**Descrição:** Define mídia para notificação de canal da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-midia`

---

#### `!g-twitch-midia-del`
**Descrição:** Remove mídia específica da notificação de canal da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-midia-del`

---

#### `!g-twitch-usarIA`
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-usarIA`

---

#### `!g-twitch-usarThumbnail`
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-usarThumbnail`

---

#### `!g-twitch-marcar`
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal da Twitch

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-marcar`

---

#### `!g-twitch-encaminharCanal`
**Descrição:** Ativa/desativa encaminhamento de notificações da Twitch para canal do WhatsApp seguido

**Categoria:** streams

**Exemplo de uso:** `!g-twitch-encaminharCanal <canalStream> <nomeCanalSeguido>`

---

#### `!g-kick-canal`
**Descrição:** Adiciona/remove canal do Kick para monitoramento

**Categoria:** streams

**Exemplo de uso:** `!g-kick-canal`

---

#### `!g-kick-mudarTitulo`
**Descrição:** Ativa/desativa mudança de título do grupo para eventos do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-mudarTitulo`

---

#### `!g-kick-titulo`
**Descrição:** Define título do grupo para eventos de canal do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-titulo`

---

#### `!g-kick-fotoGrupo`
**Descrição:** Define foto do grupo para eventos de canal do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-fotoGrupo`

---

#### `!g-kick-midia`
**Descrição:** Define mídia para notificação de canal do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-midia`

---

#### `!g-kick-midia-del`
**Descrição:** Remove mídia específica da notificação de canal do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-midia-del`

---

#### `!g-kick-usarIA`
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

**Categoria:** streams

**Exemplo de uso:** `!g-kick-usarIA`

---

#### `!g-kick-usarThumbnail`
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

**Categoria:** streams

**Exemplo de uso:** `!g-kick-usarThumbnail`

---

#### `!g-kick-marcar`
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal do Kick

**Categoria:** streams

**Exemplo de uso:** `!g-kick-marcar`

---

#### `!g-kick-encaminharCanal`
**Descrição:** Ativa/desativa encaminhamento de notificações do Kick para canal do WhatsApp seguido

**Categoria:** streams

**Exemplo de uso:** `!g-kick-encaminharCanal <canalStream> <nomeCanalSeguido>`

---

#### `!g-youtube-canal`
**Descrição:** Adiciona/remove canal do YouTube para monitoramento

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-canal`

---

#### `!g-youtube-mudarTitulo`
**Descrição:** Ativa/desativa mudança de título do grupo para eventos do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-mudarTitulo`

---

#### `!g-youtube-titulo`
**Descrição:** Define título do grupo para eventos de canal do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-titulo`

---

#### `!g-youtube-fotoGrupo`
**Descrição:** Define foto do grupo para eventos de canal do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-fotoGrupo`

---

#### `!g-youtube-midia`
**Descrição:** Define mídia para notificações de novos vídeos ou lives do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-midia [video|on|off] <canal>`

---

#### `!g-youtube-midia-del`
**Descrição:** Remove mídia específica de vídeo ou live do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-midia-del [video|on|off] <tipo> <canal>`

---

#### `!g-youtube-usarIA`
**Descrição:** Ativa/desativa uso de IA para gerar mensagens de notificação

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-usarIA`

---

#### `!g-youtube-usarThumbnail`
**Descrição:** Ativa/desativa o envio da thumbnail da stream junto com o texto

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-usarThumbnail`

---

#### `!g-youtube-marcar`
**Descrição:** Ativa/desativa menção a todos os membros nas notificações de canal do YouTube

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-marcar`

---

#### `!g-youtube-encaminharCanal`
**Descrição:** Ativa/desativa encaminhamento de notificações do YouTube para canal do WhatsApp seguido

**Categoria:** streams

**Exemplo de uso:** `!g-youtube-encaminharCanal <canalStream> <nomeCanalSeguido>`

---

#### `!g-variaveis`
**Descrição:** Lista todas as variáveis disponíveis para comandos personalizados

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-variaveis`

---

#### `!g-painel`
**Descrição:** Gera um link para gerenciar o bot via web

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-painel`

---

#### `!g-setWebhook`
**Descrição:** Cria ou atualiza um webhook para este grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-setWebhook`

---

#### `!g-delWebhook`
**Descrição:** Apaga um webhook deste grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-delWebhook`

---

#### `!g-advertir`
**Descrição:** Adiciona uma advertência aos membros mencionados

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-advertir`

---

#### `!g-advertencias`
**Descrição:** Lista as advertências atuais do grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-advertencias`

---

#### `!g-limpar-advertencias`
**Descrição:** Remove as advertências dos membros mencionados

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-limpar-advertencias`

---

#### `!g-streamRefresh`
**Descrição:** Reseta a lista de bots ativos/ignorados para as notificações de stream

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-streamRefresh`

---

#### `!g-dossie`
**Descrição:** Exibe o histórico de dossiês deste grupo

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-dossie`

---

#### `!g-copiarCmds`
**Descrição:** Copia os comandos do grupoOrigem pro grupoDestino

**Categoria:** gerenciamento

**Exemplo de uso:** `!g-copiarCmds`

---

## 👑 Comandos de Super Admin (!sa-)
Começam com `!sa-` e são exclusivos do dono do bot.

#### `!sa-evento`
**Descrição:** Cria ou cancela evento temporário

---

#### `!sa-eventos`
**Descrição:** Lista eventos temporários ativos

---

#### `!sa-retrospectiva`
**Descrição:** Retrospectiva

---

#### `!sa-testeMsg`
**Descrição:** Testar Retorno msg

---

#### `!sa-sendMsg`
**Descrição:** Envia mensagem para chatId

---

#### `!sa-joinGrupo`
**Descrição:** Entra em um grupo via link de convite

---

#### `!sa-joinGrupoSilencioso`
**Descrição:** Entra em um grupo via link de convite SEM enviar mensagem de boas-vindas

---

#### `!sa-modoSilencioso`
**Descrição:** Toggle do modo silencioso global (sem boas-vindas por 30 min)

---

#### `!sa-addDonate`
**Descrição:** Adiciona novo donate

---

#### `!sa-addDonateNumero`
**Descrição:** Adiciona número de um doador

---

#### `!sa-addDonateValor`
**Descrição:** Atualiza valor de doação

---

#### `!sa-mergeDonates`
**Descrição:** Une dois doadores em um

---

#### `!sa-block`
**Descrição:** Bloqueia um usuário

---

#### `!sa-unblock`
**Descrição:** Desbloqueia um usuário

---

#### `!sa-leaveGrupo`
**Descrição:** Sai de um grupo com opção de bloquear membros

---

#### `!sa-privacidade`
**Descrição:** Seta padrões de privacidade

---

#### `!sa-foto`
**Descrição:** Altera foto de perfil do bot

---

#### `!sa-simular`
**Descrição:** Simula evento de stream

---

#### `!sa-restart`
**Descrição:** Reinicia o bot

---

#### `!sa-stats`
**Descrição:** Status, grupos

---

#### `!sa-iaStats`
**Descrição:** Estatísticas de IA (LLM, Comfy, Speech)

---

#### `!sa-getGroupInfo`
**Descrição:** Dump de dados de grupo por nome cadastro

---

#### `!sa-getMembros`
**Descrição:** Lista todos os membros do grupo separados por admin e membros normais

---

#### `!sa-blockInvites`
**Descrição:** Bloqueia os invites dessa pessoa

---

#### `!sa-unblockInvites`
**Descrição:** Bloqueia os invites dessa pessoa

---

#### `!sa-blockList`
**Descrição:** Bloqueia todos os contatos recebidos separados por vírgula

---

#### `!sa-blockTudoList`
**Descrição:** Sai de todos os grupos em comum com uma lista de pessoas e bloqueia todos os membros

---

#### `!sa-unblockList`
**Descrição:** Desbloqueia todos os contatos recebidos separados por vírgula

---

#### `!sa-listaGruposPessoa`
**Descrição:** Lista todos os grupos em comum com uma pessoa

---

#### `!sa-blockTudoPessoa`
**Descrição:** Sai de todos os grupos em comum com uma pessoa e bloqueia todos os membros

---

#### `!sa-reagir`
**Descrição:** Reage com o emoji informado [debug apenas]

---

#### `!sa-status`
**Descrição:** Define o status do bot

---

#### `!sa-wol`
**Descrição:** Envia pacote wake-on-lan na rede

---

#### `!sa-globalStreamRefresh`
**Descrição:** Reseta a lista de bots ativos/ignorados para transmissões em TODOS os grupos

---

#### `!sa-dossie`
**Descrição:** Trigga análise de dossiê para um grupo

---

#### `!sa-addElogio`
**Descrição:** Adiciona um sticker de elogio (use em resposta)

---

#### `!sa-addXingamento`
**Descrição:** Adiciona um sticker de xingamento (use em resposta)

---

#### `!sa-fixGroupNames`
**Descrição:** Escaneia e sugere correção para nomes de grupos (dry run)

---

#### `!sa-dumpdbs`
**Descrição:** Força o dump em disco (checkpoint WAL) e roda testes de integridade em todos os bancos de dados

---

#### `!sa-removeUserGp`
**Descrição:** Remove um usuário do grupo: !sa-removeUserGp <grupoJid> <contato>

---

#### `!sa-addUserGp`
**Descrição:** Adiciona um usuário ao grupo: !sa-addUserGp <grupoJid> <contato>

---

#### `!sa-streams-cleanup`
**Descrição:** Limpa canais inexistentes de Twitch/Kick e remove canais de grupos sem bots presentes

---

#### `!sa-streamsCleanup`
**Descrição:** Limpa canais inexistentes de Twitch/Kick e remove canais de grupos sem bots presentes

---

#### `!sa-streams-rate`
**Descrição:** Exibe métricas de velocidade de busca e rate limit do StreamMonitor

---

#### `!sa-streamsRate`
**Descrição:** Exibe métricas de velocidade de busca e rate limit do StreamMonitor

---

#### `!sa-removerFig`
**Descrição:** Remove figurinha(s) do Lovecell do cache, adiciona à blacklist e limpa estatísticas (suporta múltiplos IDs)

---

#### `!sa-remover-fig`
**Descrição:** Remove figurinha(s) do Lovecell do cache, adiciona à blacklist e limpa estatísticas (suporta múltiplos IDs)

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
- `{statusZap}`
- `{statusZap2}`

