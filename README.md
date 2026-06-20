# Sete PRO

Sete PRO e um painel simples para transformar jogos, prints e odds em uma analise mais organizada.

A ideia do projeto e bem direta: voce informa os jogos ou envia um print da bet, o app cruza com dados de API quando possivel, limpa mercados confusos e entrega bilhetes mais faceis de conferir na casa de aposta.

## O que ele faz hoje

- Le prints da tela da bet e tenta organizar jogo, mercado e odd.
- Analisa jogos digitados manualmente.
- Busca palpites de futebol apenas quando voce clica, para economizar API.
- Tem botoes separados para Brasileirao Serie A, Brasileirao A+B+C e Brasileirao Serie B/C.
- Tambem tem atalhos para basquete, volei e e-sports.
- Evita mercados ruins ou dificeis, como handicap quebrado, linhas 0.25/0.75 e nomes crus tipo `Away`.
- Usa cache por data, botao e mercados marcados para nao repetir busca desnecessaria.

## Como o projeto esta montado

```text
index.html                         Interface principal
netlify.toml                       Configuracao do Netlify
package.json                       Dependencias e scripts
.env.example                       Exemplo das variaveis de ambiente
netlify/functions/                 Backend do app
  analyze-games.mts                Analise de jogos digitados
  analyze-screenshot.mts           Leitura de prints com IA
  analyze-ticket.mts               Analise de bilhetes informados
  daily-picks.mts                  Palpites de futebol sob demanda
  settled-picks.mts                Relatorio de acertos do dia
  daily-basketball-picks.mts       Palpites de basquete
  daily-volleyball-picks.mts       Palpites de volei
  daily-esports-picks.mts          Palpites de e-sports
  daily-mixed-picks.mts            Mix multi-esporte
  health.mts                       Status do backend
```

## Variaveis que precisam ir no Netlify

Configure em:

`Site configuration > Environment variables`

Principais:

- `API_FOOTBALL_KEY`
- `OPENAI_API_KEY` ou `OPENAI_BASE_URL`

Opcionais:

- `API_BASKETBALL_KEY`
- `API_VOLLEYBALL_KEY`
- `API_SPORTS_KEY`
- `ODDSPAPI_KEY` ou `ODDS_PAPI_KEY`
- `OPENAI_MODEL`
- `OPENAI_VISION_MODEL`
- `DAILY_PICKS_AI=1`

Use o arquivo `.env.example` como cola. Chave real nao entra no Git.

## Rodando local

```bash
npm install
npx netlify dev
```

Para conferir se o build do Netlify passa:

```bash
npx netlify build
```

## Deploy

O projeto foi feito para Netlify:

- Publish directory: `.`
- Functions directory: `netlify/functions`
- Config file: `netlify.toml`

Deploy manual:

```bash
npx netlify deploy
npx netlify deploy --prod
```

## Rotas principais

- `GET /api/health`
- `POST /api/analyze-games`
- `POST /api/analyze-screenshot`
- `POST /api/analyze-ticket`
- `GET|POST /api/daily-picks`
- `GET /api/settled-picks`
- `GET|POST /api/daily-basketball-picks`
- `GET|POST /api/daily-volleyball-picks`
- `GET|POST /api/daily-esports-picks`
- `GET|POST /api/daily-mixed-picks`

## Notas do projeto

O relatorio pesado das 07h foi removido de proposito. Antes ele gastava muita quota da API logo cedo. Agora os palpites sao sob demanda: so consulta quando alguem clica no botao.

Arquivos locais, planilhas, `.env`, `.netlify` e `node_modules` ficam fora do Git pelo `.gitignore`.
