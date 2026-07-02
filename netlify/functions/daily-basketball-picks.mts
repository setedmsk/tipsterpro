import { getStore } from "@netlify/blobs";
import { externalServiceError, fetchWithTimeout, friendlyErrorPayload } from "./_shared/http.mts";
import { isUpcomingStart, pruneUpcomingReport } from "./_shared/upcoming.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_BASKETBALL_BASE = "https://v1.basketball.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 5;
const BASKETBALL_GAME_LIMIT = 5;
const BASKETBALL_CANDIDATE_LIMIT = 10;

type BasketballGame = {
  id: number;
  date: string;
  time?: string;
  timestamp?: number;
  timezone?: string;
  status?: {
    long?: string;
    short?: string;
    timer?: string | null;
  };
  league?: {
    id?: number;
    name?: string;
    type?: string;
    season?: string | number;
  };
  country?: {
    name?: string;
    code?: string;
  };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
};

type BasketballCategory =
  | "vencedor"
  | "handicap"
  | "pontos_totais"
  | "outros";

type BasketballPick = {
  fixtureId: number;
  sport: "basketball";
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: BasketballCategory;
  selection: string;
  odd: number;
  bookmaker?: string;
  impliedProbability: number;
  score: number;
  reason?: string;
};

type BasketballReport = {
  source: {
    provider: string;
    date: string;
    generatedAt: string;
    timezone: string;
    schedule: string;
    gamesFound: number;
    searchedDates: string[];
    searchMode: string;
    gameLimit: number;
    candidateLimit: number;
    oddsRequests: number;
    gamesAnalyzed: number;
    matched: number;
    picksFound: number;
    cached?: boolean;
  };
  analysis: Record<string, unknown>;
  raw: {
    fixtures: BasketballGame[];
    picks: BasketballPick[];
  };
};

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function getEnv(name: string) {
  return Netlify.env.get(name) || "";
}

function basketballKey() {
  return getEnv("API_BASKETBALL_KEY") || getEnv("API_FOOTBALL_KEY") || getEnv("API_SPORTS_KEY");
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bookmakerPriority(name?: string) {
  const normalized = normalizeText(String(name || ""));
  if (normalized.includes("betano")) return 12;
  return 0;
}

function isBetanoBookmaker(name?: string) {
  return normalizeText(String(name || "")).includes("betano");
}

function selectionLine(value: string) {
  const match = String(value || "").match(/\d+(?:[,.]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function isWholeGameBasketballTotal(selection: string) {
  const line = selectionLine(selection);
  return line === null || (line >= 100 && line <= 260);
}

function todayInSaoPaulo() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function apiBasketball(path: string, params: Record<string, string | number | undefined> = {}) {
  const key = basketballKey();
  const url = new URL(path, API_BASKETBALL_BASE);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const response = await fetchWithTimeout(url, {
    headers: {
      "x-apisports-key": key,
    },
  }, 8000, "API-Basketball");

  if (!response.ok) {
    throw externalServiceError("API-Basketball", `HTTP ${response.status}`, response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  const errors = Array.isArray(data.errors)
    ? data.errors
    : data.errors && typeof data.errors === "object"
      ? Object.values(data.errors)
      : [];
  if (errors.length) {
    const detail = errors.join(" | ");
    throw externalServiceError("API-Basketball", detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }

  return data.response || [];
}

function gameName(game: BasketballGame) {
  const home = game.teams?.home?.name || "Mandante";
  const away = game.teams?.away?.name || "Visitante";
  return `${home} x ${away}`;
}

function isPreGame(game: BasketballGame) {
  const status = normalizeText(String(game.status?.short || game.status?.long || ""));
  const pregame = !status || ["ns", "not started", "scheduled", "tbd"].some((item) => status.includes(item));
  return pregame && isUpcomingStart(game.date);
}

function leaguePriority(game: BasketballGame) {
  const league = normalizeText(`${game.league?.name || ""} ${game.country?.name || ""}`);
  if (league.includes("nba")) return 14;
  if (league.includes("euroleague")) return 12;
  if (league.includes("eurocup")) return 10;
  if (league.includes("spain") || league.includes("acb")) return 9;
  if (league.includes("turkey") || league.includes("italy") || league.includes("greece") || league.includes("france") || league.includes("germany")) return 8;
  if (league.includes("australia") || league.includes("china") || league.includes("japan") || league.includes("korea")) return 6;
  if (league.includes("brazil") || league.includes("argentina") || league.includes("uruguay")) return 5;
  return 3;
}

function isUnsupportedMarket(market: string) {
  const normalized = normalizeText(market);
  return [
    "alternative",
    "alternate",
    "quarter",
    "period",
    "half",
    "race to",
    "first",
    "last",
    "player",
    "margin",
    "odd even",
    "correct score",
    "team total",
    "home total",
    "away total",
    "home points",
    "away points",
    "team points",
    "highest scoring",
    "double result",
    "draw no bet",
    "including overtime no",
    "spread",
    "handicap",
    "asian",
  ].some((fragment) => normalized.includes(fragment));
}

function marketCategory(market: string, selection = ""): BasketballCategory {
  const normalizedMarket = normalizeText(market);
  const normalized = normalizeText(`${market} ${selection}`);
  if (isUnsupportedMarket(market)) return "outros";
  if (
    normalizedMarket === "over under" ||
    normalizedMarket === "total points" ||
    normalizedMarket === "match total points" ||
    normalizedMarket === "game total points" ||
    (normalizedMarket.includes("over under") && !normalizedMarket.includes("team"))
  ) return "pontos_totais";
  if (
    normalizedMarket === "winner" ||
    normalizedMarket === "match winner" ||
    normalizedMarket === "home away" ||
    normalizedMarket === "moneyline" ||
    normalizedMarket === "to win"
  ) return "vencedor";
  return "outros";
}

function displayMarket(market: string, game: BasketballGame) {
  const raw = String(market || "").trim();
  const normalized = normalizeText(raw);
  const home = game.teams?.home?.name || "Mandante";
  const away = game.teams?.away?.name || "Visitante";

  if (normalized.includes("over under") || normalized.includes("total") || normalized.includes("points")) return "Total de pontos - Mais/Menos";
  if (normalized.includes("spread") || normalized.includes("handicap")) return "Handicap / spread";
  if (normalized.includes("winner") || normalized.includes("home away") || normalized.includes("moneyline")) return "Vencedor do jogo";
  return raw.replace(/_/g, " ");
}

function displaySelection(selection: string, game: BasketballGame, market: string) {
  const raw = String(selection || "").trim();
  const normalized = normalizeText(raw);
  const normalizedMarket = normalizeText(market);
  const home = game.teams?.home?.name || "Mandante";
  const away = game.teams?.away?.name || "Visitante";

  if (normalized === "home" || normalized === "1") return home;
  if (normalized === "away" || normalized === "2") return away;
  if (normalized === "draw" || normalized === "x") return "Empate";
  if (normalized === "yes") return "Sim";
  if (normalized === "no") return "Nao";
  if (normalized.startsWith("over ")) return raw.replace(/^over/i, "Mais de");
  if (normalized.startsWith("under ")) return raw.replace(/^under/i, "Menos de");
  if (normalized.startsWith("home ")) return raw.replace(/^home/i, home);
  if (normalized.startsWith("away ")) return raw.replace(/^away/i, away);
  if (normalizedMarket.includes("home away") && normalized.includes(normalizeText(home))) return home;
  if (normalizedMarket.includes("home away") && normalized.includes(normalizeText(away))) return away;

  return raw.replace(/_/g, " ");
}

function collectOddsValues(bookmakers: any[]) {
  const byKey = new Map<string, {
    selection: string;
    odd: number;
    bookmaker?: string;
    market: string;
    category: BasketballCategory;
  }>();

  for (const bookmaker of bookmakers || []) {
    if (!isBetanoBookmaker(bookmaker.name)) continue;

    for (const bet of bookmaker.bets || []) {
      const market = String(bet.name || "");
      if (!market || isUnsupportedMarket(market)) continue;

      for (const value of bet.values || []) {
        const selection = String(value.value || "");
        if (hasDifficultLine(`${market} ${selection}`)) continue;

        const odd = Number.parseFloat(String(value.odd || "0"));
        const category = marketCategory(market, selection);
        if (category === "outros") continue;
        if (category === "pontos_totais" && !isWholeGameBasketballTotal(selection)) continue;
        if (!Number.isFinite(odd) || odd < 1.15 || odd > 3.2) continue;

        const key = normalizeText(`${category}|${market}|${selection}`);
        const current = byKey.get(key);
        const priority = bookmakerPriority(bookmaker.name);
        const currentPriority = bookmakerPriority(current?.bookmaker);
        if (!current || priority > currentPriority || (priority === currentPriority && odd > current.odd)) {
          byKey.set(key, {
            selection,
            odd,
            bookmaker: bookmaker.name,
            market,
            category,
          });
        }
      }
    }
  }

  return [...byKey.values()];
}

const CATEGORY_BASE_SCORE: Record<BasketballCategory, number> = {
  vencedor: 48,
  pontos_totais: 41,
  outros: 0,
};

const CATEGORY_TARGET_ODD: Record<BasketballCategory, number> = {
  vencedor: 1.42,
  pontos_totais: 1.76,
  outros: 1.7,
};

function pickScore(pick: Pick<BasketballPick, "odd" | "category" | "bookmaker">, game: BasketballGame) {
  const target = CATEGORY_TARGET_ODD[pick.category] || 1.7;
  const oddDistancePenalty = Math.abs(pick.odd - target) * 7;
  const shortPricePenalty = pick.odd < 1.2 ? 8 : 0;
  const longPricePenalty = pick.odd > 2.25 ? (pick.odd - 2.25) * 5 : 0;
  const bookmakerBoost = bookmakerPriority(pick.bookmaker) * 0.6;
  return CATEGORY_BASE_SCORE[pick.category] + leaguePriority(game) + bookmakerBoost - oddDistancePenalty - shortPricePenalty - longPricePenalty;
}

function reasonForPick(pick: BasketballPick) {
  if (pick.category === "vencedor") return "Mercado direto, bom para priorizar probabilidade quando a odd ainda paga retorno aceitavel.";
  if (pick.category === "pontos_totais") return "Total de pontos do jogo inteiro, filtrando mercado de equipe, quarto e props.";
  return "Mercado analisado pela odd disponivel.";
}

function bestPicksForGame(game: BasketballGame, oddsResponse: any[]) {
  const bookmakers = oddsResponse?.[0]?.bookmakers || [];
  const picks: BasketballPick[] = [];

  for (const value of collectOddsValues(bookmakers)) {
    const market = displayMarket(value.market, game);
    const selection = displaySelection(value.selection, game, value.market);
    const pick: BasketballPick = {
      fixtureId: game.id,
      sport: "basketball",
      game: gameName(game),
      league: game.league?.name || "Liga nao informada",
      startsAt: game.date,
      market,
      category: value.category,
      selection,
      odd: value.odd,
      bookmaker: value.bookmaker,
      impliedProbability: Number((100 / value.odd).toFixed(2)),
      score: 0,
    };
    pick.score = pickScore(pick, game);
    pick.reason = reasonForPick(pick);
    picks.push(pick);
  }

  const ranked = picks.slice().sort((a, b) => b.score - a.score);
  const selected: BasketballPick[] = [];
  const usedCategories = new Set<BasketballCategory>();

  for (const category of ["vencedor", "pontos_totais"] as BasketballCategory[]) {
    const pick = ranked.find((item) => item.category === category);
    if (pick) {
      selected.push(pick);
      usedCategories.add(category);
    }
  }

  for (const pick of ranked) {
    if (selected.length >= 6) break;
    const duplicate = selected.some((item) => normalizeText(`${item.market}|${item.selection}`) === normalizeText(`${pick.market}|${pick.selection}`));
    if (!duplicate) selected.push(pick);
  }

  return selected.sort((a, b) => b.score - a.score);
}

async function fetchWindowGames(date: string) {
  const searchedDates = [date, addDays(date, 1), addDays(date, 2)];
  const all: BasketballGame[] = [];

  for (const itemDate of searchedDates) {
    const games = await apiBasketball("/games", {
      date: itemDate,
      timezone: DEFAULT_TIMEZONE,
    });
    all.push(...games);
    if (all.filter(isPreGame).length >= BASKETBALL_CANDIDATE_LIMIT) break;
  }

  const seen = new Set<number>();
  const unique = all.filter((game) => {
    if (!game?.id || seen.has(game.id)) return false;
    seen.add(game.id);
    return true;
  });

  return {
    games: unique,
    searchedDates,
    searchMode: searchedDates.length > 1 ? "hoje + proximos dias" : "hoje",
  };
}

function chooseTicketSelections(picks: BasketballPick[], maxSelections: number, mode: "conservative" | "balanced" | "bold") {
  const ranges = {
    conservative: { min: 1.2, max: 1.68, limit: Math.min(2, maxSelections) },
    balanced: { min: 1.25, max: 1.95, limit: Math.min(3, maxSelections) },
    bold: { min: 1.35, max: 2.35, limit: Math.min(4, maxSelections) },
  };
  const range = ranges[mode];
  const chosen: BasketballPick[] = [];
  const usedGames = new Set<number>();
  const usedCategories = new Set<BasketballCategory>();
  const ranked = picks
    .filter((pick) => pick.odd >= range.min && pick.odd <= range.max)
    .slice()
    .sort((a, b) => b.score - a.score);

  for (const pick of ranked) {
    if (chosen.length >= range.limit) break;
    if (usedGames.has(pick.fixtureId)) continue;
    if (mode !== "conservative" && usedCategories.has(pick.category) && usedCategories.size < 3) continue;
    chosen.push(pick);
    usedGames.add(pick.fixtureId);
    usedCategories.add(pick.category);
  }

  for (const pick of ranked) {
    if (chosen.length >= range.limit) break;
    if (usedGames.has(pick.fixtureId)) continue;
    chosen.push(pick);
    usedGames.add(pick.fixtureId);
  }

  return chosen;
}

function buildTicket(picks: BasketballPick[], maxSelections: number, stake: number, mode: "conservative" | "balanced" | "bold") {
  const selections = chooseTicketSelections(picks, maxSelections, mode);
  if (!selections.length) return { selections: [] };
  const totalOdd = selections.reduce((total, selection) => total * selection.odd, 1);
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason: mode === "conservative"
      ? "Bilhete curto com odds mais baixas e jogos diferentes."
      : mode === "balanced"
        ? "Melhor equilibrio entre probabilidade, retorno e variedade de mercados."
        : "Bilhete com retorno maior, mantendo no maximo uma entrada por jogo.",
  };
}

function deterministicAnalysis(fixtures: BasketballGame[], picks: BasketballPick[], stake: number, maxSelections: number, date: string) {
  const topGames = fixtures.slice(0, BASKETBALL_GAME_LIMIT);
  const topPicksByGame = new Map<number, BasketballPick[]>();
  for (const pick of picks) {
    const list = topPicksByGame.get(pick.fixtureId) || [];
    list.push(pick);
    topPicksByGame.set(pick.fixtureId, list);
  }

  const gameByGame = topGames.map((game) => {
    const gamePicks = (topPicksByGame.get(game.id) || []).slice(0, 3);
    const best = gamePicks[0];
    return {
      game: gameName(game),
      apiGame: gameName(game),
      league: game.league?.name || "Liga nao informada",
      startsAt: game.date,
      bestMarket: best?.market || "",
      reason: best
        ? `${best.selection} foi a entrada melhor ranqueada para este jogo. ${best.reason || ""}`
        : "Jogo encontrado, mas sem odds pre-jogo aproveitaveis nos mercados principais.",
      risk: best?.odd && best.odd >= 2 ? "alto" : "medio",
      picks: gamePicks,
    };
  });

  return {
    summary: picks.length
      ? `Palpites de Basquete gerados para ${date}. Usei somente odds Betano e mercados simples: vencedor e total de pontos do jogo.`
      : "Encontrei jogos de basquete, mas nao achei odds Betano aproveitaveis nos mercados simples.",
    gameByGame,
    traps: picks
      .filter((pick) => pick.odd < 1.2 || pick.odd > 2.35)
      .slice(0, 5)
      .map((pick) => ({
        game: pick.game,
        market: pick.market,
        selection: pick.selection,
        odd: pick.odd,
        reason: pick.odd < 1.2 ? "Odd muito baixa para entrar no bilhete principal." : "Odd alta demais para o perfil de maior probabilidade.",
      })),
    conservativeTicket: buildTicket(picks, maxSelections, stake, "conservative"),
    balancedTicket: buildTicket(picks, maxSelections, stake, "balanced"),
    boldTicket: buildTicket(picks, maxSelections, stake, "bold"),
    mainRecommendation: buildTicket(picks, maxSelections, stake, "balanced"),
  };
}

async function computeBasketballReport(date: string, stake: number, maxSelections: number): Promise<BasketballReport> {
  const window = await fetchWindowGames(date);
  const candidates = window.games
    .filter(isPreGame)
    .sort((a, b) => leaguePriority(b) - leaguePriority(a))
    .slice(0, BASKETBALL_CANDIDATE_LIMIT);

  let oddsRequests = 0;
  const fixturesWithPicks: Array<{ fixture: BasketballGame; picks: BasketballPick[] }> = [];

  for (const game of candidates) {
    let odds: any[] = [];
    try {
      oddsRequests += 1;
      odds = await apiBasketball("/odds", {
        game: game.id,
      });
    } catch {
      odds = [];
    }

    const picks = bestPicksForGame(game, odds);
    if (picks.length) fixturesWithPicks.push({ fixture: game, picks });
    if (fixturesWithPicks.length >= BASKETBALL_GAME_LIMIT) break;
  }

  fixturesWithPicks.sort((a, b) => {
    const bestA = a.picks[0]?.score || 0;
    const bestB = b.picks[0]?.score || 0;
    return bestB - bestA;
  });

  const fixtures = fixturesWithPicks.map((item) => item.fixture);
  const picks = fixturesWithPicks.flatMap((item) => item.picks).sort((a, b) => b.score - a.score);
  const selectionLimit = Math.max(1, Math.min(BASKETBALL_GAME_LIMIT, maxSelections));
  const analysis = deterministicAnalysis(fixtures, picks, stake, selectionLimit, date);

  return {
    source: {
      provider: "API-Basketball + Betano + Palpites Basquete",
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "On-demand",
      gamesFound: window.games.length,
      searchedDates: window.searchedDates,
      searchMode: window.searchMode,
      gameLimit: BASKETBALL_GAME_LIMIT,
      candidateLimit: BASKETBALL_CANDIDATE_LIMIT,
      oddsRequests,
      gamesAnalyzed: fixtures.length,
      matched: fixtures.length,
      picksFound: picks.length,
    },
    analysis,
    raw: {
      fixtures,
      picks,
    },
  };
}

function basketballStore() {
  return getStore({ name: "daily-basketball-picks", consistency: "strong" });
}

function isUsableReport(report: BasketballReport | null) {
  const picks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  return Boolean(
    report?.source?.picksFound &&
    report.source.picksFound > 0 &&
    String(report.source.provider || "").includes("Betano") &&
    picks.length &&
    picks.every((pick) => isBetanoBookmaker(pick.bookmaker))
  );
}

async function readCachedReport(date: string) {
  try {
    const report = await basketballStore().get(`reports/${date}.json`, { type: "json" }) as BasketballReport | null;
    const upcoming = pruneUpcomingReport(report, DEFAULT_STAKE);
    return isUsableReport(upcoming) ? upcoming : null;
  } catch {
    return null;
  }
}

async function saveReport(report: BasketballReport) {
  if (!isUsableReport(report)) return;

  try {
    const store = basketballStore();
    const snapshot = String(Date.parse(report.source.generatedAt) || Date.now());
    await store.setJSON(`reports/${report.source.date}.json`, report);
    await store.setJSON(`history/${report.source.date}/${snapshot}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // The response is still valid even when local/persistent blob storage is unavailable.
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(1, Math.min(BASKETBALL_GAME_LIMIT, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  if (!basketballKey()) {
    return json({
      error: "Chave da API de basquete ausente",
      setup: [
        "Configure API_BASKETBALL_KEY no Netlify, ou reutilize API_FOOTBALL_KEY se sua conta API-Sports liberar Basketball.",
        "O endpoint usa API-Basketball para jogos e odds de basquete.",
      ],
    }, { status: 501 });
  }

  if (!refresh) {
    const cached = await readCachedReport(date);
    if (cached) {
      return json({
        ...cached,
        source: {
          ...cached.source,
          cached: true,
        },
      });
    }
  }

  try {
    const report = await computeBasketballReport(date, stake, maxSelections);
    await saveReport(report);
    return json(report);
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "Nao consegui gerar os palpites de Basquete");
    return json({
      ...friendly.body,
      setup: [
        "Confira se API_BASKETBALL_KEY ou API_FOOTBALL_KEY tem acesso a API-Basketball.",
        "Confira se ainda existe quota no plano da API-Sports.",
        "Tente novamente em alguns minutos se a API estiver limitando requisicoes.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
};

export const config = {
  path: "/api/daily-basketball-picks",
  method: ["GET", "POST"],
};
