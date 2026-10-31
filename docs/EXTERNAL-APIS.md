# 🔌 Dependências Externas & APIs

A **RavenaBot AI** possui uma arquitetura modular construída para estender suas capacidades através de APIs e serviços externos.

Embora o núcleo da aplicação (moderação, comandos utilitários, downloads locais, figurinhas básicas e jogos de tabuleiro) funcione de forma independente via Docker, recursos avançados — como **Inteligência Artificial (LLMs), transcrição e síntese de voz, geração de imagens por difusão e certos minigames** — dependem de conexões com APIs externas ou microsserviços auto-hospedados.

---

## 📋 Sumário
1. [Formas de Configuração](#-formas-de-configuração)
2. [Categoria 1: APIs Prontas de Provedores Externos](#-categoria-1-apis-prontas-de-provedores-externos)
3. [Categoria 2: APIs Auto-Hospedadas (Self-Hosted)](#-categoria-2-apis-auto-hospedadas-self-hosted)
4. [Outros Módulos e Jogos do Ecossistema](#-outros-módulos-e-jogos-do-ecossistema)
5. [Gerenciamento Dinâmico via Painel Web](#-gerenciamento-dinâmico-via-painel-web)

---

## ⚙️ Formas de Configuração

Existem dois mecanismos principais para gerenciar as dependências externas da Ravena:

### 1. `service-providers.json` (Provedores de IA, Mídia e Visão)
Arquivo JSON na raiz do projeto gerenciado pelo [`ServiceProviderService.js`](../src/services/ServiceProviderService.js). Possui suporte a:
- **Hot-Reload:** Qualquer alteração no arquivo é detectada e recarregada instantaneamente em memória sem precisar reiniciar os containers.
- **Circuit Breaker & Fallback:** Se um provedor apresentar falhas consecutivas ou lentidão, o sistema isola temporariamente a rota e redireciona requisições para os provedores secundários ativos.
- **Template:** Você pode iniciar copiando o modelo de exemplo:
  ```bash
  cp service-providers.json.example service-providers.json
  ```

### 2. Arquivo `.env` (Credenciais Globais, Jogos e Serviços Legados)
Utilizado para chaves de API diretas de serviços de terceiros (Twitch, OpenWeather, Correios), tokens dos minigames (Waifuletes, Jardim das Sombras) e comunicação entre containers Docker.

---

## ☁️ Categoria 1: APIs Prontas de Provedores Externos

Serviços em nuvem fornecidos por terceiros. Para utilizá-los, basta cadastrar sua chave de API (`apiKey`) no `service-providers.json` ou no `.env`.

### 1. Modelos de Linguagem (LLMs)
Configurados na chave `"llm"` do `service-providers.json`.

| Provedor | Tipo (`type`) | Descrição e Recursos | Onde é usado no código |
| :--- | :--- | :--- | :--- |
| **OpenAI** | `openai` | Modelos GPT-4o, GPT-4o-mini, embeddings e suporte completo a Tool Calling (funções do bot executadas pelo modelo). | [`src/services/LLMService.js`](../src/services/LLMService.js), resumos de grupo, interações do bot. |
| **OpenRouter** | `openrouter` | Gateway agregador que permite acessar centenas de modelos (Claude, Gemini, Llama, Mistral) sob uma única chave. | [`src/services/LLMService.js`](../src/services/LLMService.js). |
| **DeepSeek** | `openai` | Modelos DeepSeek Chat e DeepSeek Reasoner (R1) via API compatível com OpenAI. | [`src/services/LLMService.js`](../src/services/LLMService.js). |
| **Google Gemini** | `openai` ou `.env` | Modelos Gemini 1.5 Flash/Pro e 2.0 via chave `GEMINI_API_KEY` ou endpoint compatível. | Análise multimodal de imagens e moderação inteligente. |
| **Ollama / LMStudio** | `ollama` / `openai` | Execução de modelos locais (Gemma, Qwen, DeepSeek Coder) rodando em rede local. | Processamento de comandos sem envio de dados para nuvem externa. |

### 2. Dados, Redes Sociais e Utilitários (Configurados no `.env`)
| Serviço | Variável no `.env` | Finalidade | Onde é usado no código |
| :--- | :--- | :--- | :--- |
| **Twitch API** | `TWITCH_CLIENT_ID`<br>`TWITCH_CLIENT_SECRET` | Notificações em tempo real quando canais monitorados entram ao vivo. | [`src/services/StreamMonitor.js`](../src/services/StreamMonitor.js) |
| **Kick API** | `KICK_CLIENT_ID`<br>`KICK_CLIENT_SECRET` | Monitoramento e alertas de transmissões ao vivo na plataforma Kick. | [`src/services/StreamMonitor.js`](../src/services/StreamMonitor.js) |
| **OpenWeather** | `OPENWEATHER_API_KEY` | Previsão climática, sensação térmica e condições do tempo via `!tempo`. | [`src/functions/GeneralCommands.js`](../src/functions/GeneralCommands.js) |
| **DeepL** | `DEEPL_API_KEY` | Tradução neural precisa de textos e mensagens citadas via `!traduzir`. | [`src/functions/GeneralCommands.js`](../src/functions/GeneralCommands.js) |
| **Giphy** | `GIPHY_API_KEY` | Pesquisa e envio de animações GIF em resposta a comandos. | [`src/functions/MediaCommands.js`](../src/functions/MediaCommands.js) |
| **OMDb** | `OMDB_API_KEY` | Consulta a sinopses, notas de crítica (IMDb/Rotten Tomatoes) e fichas técnicas de filmes e séries. | [`src/functions/GeneralCommands.js`](../src/functions/GeneralCommands.js) |
| **Unsplash** | `UNSPLASH_API_KEY` | Busca e download de fotos artísticas em alta definição. | [`src/functions/MediaCommands.js`](../src/functions/MediaCommands.js) |
| **NASA** | `NASA_API` | Imagem astronômica do dia (APOD) e dados de missões espaciais. | [`src/functions/GeneralCommands.js`](../src/functions/GeneralCommands.js) |
| **Jina AI** | `JINA_API_KEY` | Extração limpa de conteúdo web e busca contextual profunda para a IA. | [`src/services/LLMService.js`](../src/services/LLMService.js) |

---

## 🖥️ Categoria 2: APIs Auto-Hospedadas (Self-Hosted)

Microsserviços de alta performance desenvolvidos ou adaptados para que você possa hospedar em sua própria máquina, VPS ou servidor com GPU dedicada.

### 1. Whisper / Faster-Whisper (Transcrição de Voz)
- **Repositório oficial:** [**moothz/faster-whisper-api**](https://github.com/moothz/faster-whisper-api)
- **O que faz:** Transcrição ultra-rápida de áudio para texto (Speech-to-Text), com aceleração via CTranslate2 e GPU (CUDA).
- **Como configurar:** Adicione o endpoint no array `"whisper"` de `service-providers.json`:
  ```json
  "whisper": [
    {
      "name": "whisper-local",
      "url": "http://192.168.1.10:3378",
      "enabled": true
    }
  ]
  ```
- **Onde é usado no código:**
  - [`src/functions/SpeechCommands.js`](../src/functions/SpeechCommands.js): Comando manual `!transcrever` em áudios citados.
  - Auto-STT: Transcrição automática de áudios em grupos que habilitam o recurso.

### 2. laya-api (Decisões Ultrarrápidas & Embeddings)
- **Repositório oficial:** *(Em breve)*
- **O que faz:** Microsserviço de "System One" projetado para decisões em baixíssima latência (<10ms). Realiza classificação prévia de intenções do usuário, roteamento inteligente e geração de embeddings locais (ex: `ravena-bgem3`).
- **Como configurar:** Adicione o endpoint no array `"laya"` de `service-providers.json`:
  ```json
  "laya": [
    {
      "name": "primary-laya",
      "url": "http://192.168.1.10:3005",
      "model": "ravena-bgem3",
      "enabled": true,
      "timeoutMs": 3000
    }
  ]
  ```
- **Onde é usado no código:**
  - [`src/services/LayaService.js`](../src/services/LayaService.js): Decisão e triagem instantânea antes da chamada de modelos mais pesados.

### 3. bonsai-api (Geração de Imagens & Arte Generativa)
- **Repositório oficial:** *(Em breve)*
- **O que faz:** Backend otimizado de difusão de imagens (modelo `bonsai-ternary` e pipelines SD) para geração dinâmica de ilustrações, avatares e composições artísticas.
- **Como configurar:** Adicione o endpoint no array `"bonsai"` de `service-providers.json`:
  ```json
  "bonsai": [
    {
      "name": "primary-bonsai",
      "url": "http://192.168.1.30:1234",
      "enabled": true
    }
  ]
  ```
- **Onde é usado no código:**
  - [`src/functions/BonsaiCommands.js`](../src/functions/BonsaiCommands.js): Comando `!imagine` / `!desenhar`.
  - [`src/utils/WaifuMarriagePhotoHelper.js`](../src/utils/WaifuMarriagePhotoHelper.js): Geração de fotos de casamento waifu personalizadas (`!mu-foto`).
  - [`src/functions/FishingGame.js`](../src/functions/FishingGame.js): Geração procedural de avatares para peixes lendários capturados.
  - [`src/functions/TarotGame.js`](../src/functions/TarotGame.js): Cartas geradas e estilizadas via IA.

### 4. f5-tts (Síntese e Clonagem Vocal Neural)
- **Repositório oficial:** *(Em breve)*
- **O que faz:** Motor neural de Text-to-Speech (TTS) baseado no modelo F5-TTS, permitindo gerar vozes naturais e clonar timbres de personagens e vozes de referência.
- **Como configurar:** Adicione o endpoint no array `"f5tts"` de `service-providers.json`:
  ```json
  "f5tts": [
    {
      "name": "f5tts-local",
      "url": "http://192.168.1.10:5050",
      "apiKey": "",
      "enabled": true
    }
  ]
  ```
- **Onde é usado no código:**
  - [`src/functions/SpeechCommands.js`](../src/functions/SpeechCommands.js): Comandos `!falar` e síntese de voz para respostas da assistente.

---

## 🎮 Outros Módulos e Jogos do Ecossistema

Alguns jogos e funcionalidades avançadas rodam como serviços independentes e são configurados diretamente no arquivo `.env`:

### 🌸 Waifuletes (Roleta de Waifus / Minigame Mudae)
- **Variáveis no `.env`:**
  ```ini
  WAIFULETES_API_URL=http://host.docker.internal:3030
  WAIFULETES_API_KEY=seu_token_aqui
  ```
- **Onde é usado no código:** [`src/functions/WaifuGame.js`](../src/functions/WaifuGame.js).
- **Função:** Controla rolagem de personagens de animes/jogos, reivindicação (claim), casamentos, sistema de valor e perfil de colecionador.

### 🌿 Jardim das Sombras (Fazenda Gótica)
- **Variáveis no `.env`:**
  ```ini
  JARDIM_API_URL=http://host.docker.internal:3040
  JARDIM_API_KEY=chave_secreta_da_fazenda
  ```
- **Onde é usado no código:** [`src/services/ShadowGardenClient.js`](../src/services/ShadowGardenClient.js).
- **Função:** Gerencia sementes, plantações, colheitas, estoque e o ecossistema econômico do minigame gótico de fazenda.

### 🛡️ NudeNet (Filtro NSFW) & rembg (Remoção de Fundo)
- **NudeNet:** Configurado em `service-providers.json` (`"nudenet"`) para análise de quarentena de fotos adultas indesejadas em grupos.
- **rembg:** Configurado em `service-providers.json` (`"rembg"`) com múltiplos provedores e fallback transparente (ex.: Hyperion remoto e/ou container local). O container Docker local é opcional e gerenciado via `REMBG_LOCAL=7000` no `.env`.

---

## 🌐 Gerenciamento Dinâmico via Painel Web

A Ravena possui uma interface web nativa para gerenciar os provedores de serviços sem precisar editar arquivos manualmente:

1. Acesse no navegador:
   ```
   http://localhost:5000/service-providers
   ```
   *(Utilize as credenciais definidas em `managementUser` e `managementPW` no `bots.json`)*.
2. Na interface visual, você pode:
   - Adicionar ou remover provedores de LLM, Whisper, Bonsai, F5-TTS, ComfyUI, etc.
   - Ativar ou desativar provedores individualmente através de um toggle.
   - Testar a conectividade em tempo real antes de salvar.
   - Modificar temperaturas, limites de tokens e multiplicadores de timeout.

Para integrações automatizadas, você também pode consultar e atualizar provedores via API REST nos endpoints:
- `GET /api/service-providers`: Retorna a configuração atual.
- `POST /api/service-providers`: Atualiza os provedores em tempo real.
