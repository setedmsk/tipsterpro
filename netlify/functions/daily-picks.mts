import { getStore } from "@netlify/blobs";
import OpenAI from "openai";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 4;
const DAILY_GAME_LIMIT = 5;
const DAILY_FIXTURE_CANDIDATE_LIMIT = 6;
const DAILY_ODDS_BATCH_SIZE = 2;
const REPORT_CACHE_VERSION = "manual-br-v2";

type DailyScope =
  | "all"
  | "brasileirao_a"
  | "brasileirao_mix"
  | "brasileirao_bc";

type LeagueQuery = {
  league: number;
  season: number;
};

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    timezone?: string;
    venue?: { name?: string; city?: string };
    status?: { long?: string; short?: string; elapsed?: number | null };
  };
  league: {
    id: number;
    name: string;
    country?: string;
    season?: number;
  };
  teams: {
    home: { id: number; name: string; winner?: boolean | null };
    away: { id: number; name: string; winner?: boolean | null };
  };
};

type MarketCategory =
  | "resultado_final"
  | "dupla_chance"
  | "mais_menos_gols"
  | "ambas_marcam"
  | "handicap"
  | "escanteios"
  | "cartoes"
  | "chutes_gol"
  | "time_marca"
  | "outros";

type NormalizedPick = {
  fixtureId: number;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: MarketCategory;
  selection: string;
  odd: number;
  bookmaker?: string;
  impliedProbability: number;
  score: number;
};

type DailyReport = {
  source: {
    provider: string;
    date: string;
    generatedAt: string;
    timezone: string;
    schedule: string;
    fixturesFound: number;
    fixtureRequests?: number;
    oddsRequests?: number;
    searchedDates?: string[];
    searchMode?: string;
    gameLimit?: number;
    candidateLimit?: number;
    requestedMarkets?: MarketCategory[];
    marketFilterApplied?: boolean;
    scope?: DailyScope;
    scopeLabel?: string;
    cacheVersion?: string;
    gamesAnalyzed: number;
    matched: number;
    picksFound: number;
    cached?: boolean;
  };
  analysis: Record<string, unknown>;
  raw: {
    fixtures: ApiFootballFixture[];
    picks: NormalizedPick[];
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

function todayInSaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function dateWithOffset(date: string, offsetDays: number) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function isInDailyWindow(fixture: ApiFootballFixture, date: string) {
  const startsAt = new Date(fixture.fixture.date).getTime();
  const start = new Date(`${date}T07:00:00-03:00`).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  return Number.isFinite(startsAt) && startsAt >= start && startsAt < end;
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseDailyScope(value: string | null | undefined): DailyScope {
  const normalized = normalizeText(String(value || ""));
  if (["brasileirao a", "brasileirao serie a", "serie a", "br a", "a"].includes(normalized)) return "brasileirao_a";
  if (["brasileirao mix", "brasileirao a b c", "serie a b c", "a b c", "mix"].includes(normalized)) return "brasileirao_mix";
  if (["brasileirao b c", "serie b c", "br b c", "b c"].includes(normalized)) return "brasileirao_bc";
  return "all";
}

function dailyScopeLabel(scope: DailyScope) {
  if (scope === "brasileirao_a") return "Brasileirao Serie A";
  if (scope === "brasileirao_mix") return "Brasileirao Series A+B+C";
  if (scope === "brasileirao_bc") return "Brasileirao Series B+C";
  return "Futebol do dia";
}

function brazilLeagueQueries(date: string, scope: DailyScope): LeagueQuery[] {
  const season = Number(date.slice(0, 4));
  const serieA = { league: 71, season };
  const serieB = { league: 72, season };
  const serieC = { league: 75, season };

  if (scope === "brasileirao_a") return [serieA];
  if (scope === "brasileirao_bc") return [serieB, serieC];
  if (scope === "brasileirao_mix") return [serieA, serieB, serieC];
  return [];
}

function bookmakerPriority(name?: string) {
  const normalized = normalizeText(String(name || ""));
  if (normalized.includes("betano")) return 18;
  if (normalized.includes("superbet")) return 17;
  if (normalized.includes("pinnacle")) return 16;
  if (normalized.includes("bet365")) return 15;
  if (normalized.includes("betfair")) return 14;
  if (normalized.includes("1xbet")) return 12;
  if (normalized.includes("william hill")) return 10;
  return 0;
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function fixtureName(fixture: ApiFootballFixture) {
  return `${fixture.teams.home.name} x ${fixture.teams.away.name}`;
}

function uniqueFixtures(fixtures: ApiFootballFixture[]) {
  const byId = new Map<number, ApiFootballFixture>();
  for (const fixture of fixtures) {
    byId.set(fixture.fixture.id, fixture);
  }
  return [...byId.values()];
}

async function apiFootball(path: string, params: Record<string, string | number | undefined>) {
  const key = getEnv("API_FOOTBALL_KEY");
  if (!key) {
    throw new Error("API_FOOTBALL_KEY ausente");
  }

  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(name, String(value));
    }
  });

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": key,
    },
  });

  if (!response.ok) {
    throw new Error(`API-Football retornou ${response.status} em ${path}`);
  }

  const data = await response.json();
  const apiErrors = data.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (apiErrors.length) {
    throw new Error(`API-Football: ${apiErrors.join(" | ")}`);
  }
  return data.response || [];
}

const CATEGORY_BASE_SCORE: Record<MarketCategory, number> = {
  mais_menos_gols: 43,
  dupla_chance: 39,
  cartoes: 36,
  escanteios: 35,
  ambas_marcam: 31,
  chutes_gol: 27,
  handicap: 18,
  time_marca: 17,
  resultado_final: 8,
  outros: -100,
};

const CATEGORY_TARGET_ODD: Record<MarketCategory, number> = {
  dupla_chance: 1.35,
  mais_menos_gols: 1.6,
  ambas_marcam: 1.72,
  handicap: 1.72,
  escanteios: 1.68,
  cartoes: 1.72,
  chutes_gol: 1.75,
  time_marca: 1.7,
  resultado_final: 1.62,
  outros: 1.65,
};

function marketCategory(market: string, selection = ""): MarketCategory {
  const normalized = normalizeText(`${market} ${selection}`);

  if (normalized.includes("double chance") || normalized.includes("dupla chance")) return "dupla_chance";
  if (
    normalized.includes("both teams score") ||
    normalized.includes("both teams to score") ||
    normalized.includes("btts") ||
    normalized.includes("ambas marcam")
  ) return "ambas_marcam";
  if (normalized.includes("corner") || normalized.includes("escanteio") || normalized.includes("canto")) return "escanteios";
  if (normalized.includes("yellow") || normalized.includes("booking")) return "cartoes";
  if (normalized.includes("card") || normalized.includes("cartao") || normalized.includes("cartoes")) return "cartoes";
  if (normalized.includes("foul") || normalized.includes("offside")) return "outros";
  if (normalized.includes("shot") || normalized.includes("chute") || normalized.includes("finalizacao")) return "chutes_gol";
  if (normalized.includes("handicap") || normalized.includes("asian") || normalized.includes("spread")) return "outros";
  if (
    normalized.includes("team to score") ||
    normalized.includes("home team score") ||
    normalized.includes("away team score") ||
    normalized.includes("clean sheet")
  ) return "time_marca";
  if (
    normalized.includes("goals") ||
    normalized.includes("gol") ||
    normalized.includes("gols") ||
    normalized.includes("goal line") ||
    normalized.includes("over under") ||
    normalized.includes("over") ||
    normalized.includes("under") ||
    normalized.includes("mais") ||
    normalized.includes("menos") ||
    normalized.includes("total")
  ) return "mais_menos_gols";
  if (
    normalized.includes("match winner") ||
    normalized.includes("winner") ||
    normalized.includes("resultado final") ||
    normalized.includes("vitoria") ||
    normalized.includes("vence") ||
    normalized.includes("1x2") ||
    normalized.includes("match result") ||
    normalized.includes("fulltime result") ||
    normalized === "home away home" ||
    normalized === "home away away"
  ) return "resultado_final";

  return "outros";
}

function userMarketCategory(market: string): MarketCategory {
  const normalized = normalizeText(market);
  if (!normalized) return "outros";
  if (normalized.includes("dupla")) return "dupla_chance";
  if (normalized.includes("ambas") || normalized.includes("btts")) return "ambas_marcam";
  if (normalized.includes("escanteio") || normalized.includes("canto")) return "escanteios";
  if (normalized.includes("cart")) return "cartoes";
  if (normalized.includes("chute") || normalized.includes("finalizacao")) return "chutes_gol";
  if (normalized.includes("handicap") || normalized.includes("asian") || normalized.includes("spread")) return "outros";
  if (normalized.includes("mais") || normalized.includes("menos") || normalized.includes("gol")) return "mais_menos_gols";
  if (normalized.includes("resultado") || normalized.includes("vitoria") || normalized.includes("vence")) return "resultado_final";
  return marketCategory(market);
}

function requestedMarketCategories(markets: unknown) {
  const values = Array.isArray(markets)
    ? markets
    : typeof markets === "string"
      ? markets.split(",")
      : [];
  const categories = values
    .map((market) => userMarketCategory(String(market)))
    .filter((category): category is MarketCategory => category !== "outros");
  return [...new Set(categories)];
}

function hasTimeSegment(value: string) {
  const normalized = normalizeText(value);
  return [
    "first half",
    "second half",
    "1st half",
    "2nd half",
    "half time",
    "halftime",
    "first period",
    "second period",
    "1st period",
    "2nd period",
    "primeiro tempo",
    "segundo tempo",
    "1 tempo",
    "2 tempo",
    "0m 15m",
    "15m 30m",
    "30m 45m",
    "45m 60m",
    "60m 75m",
    "75m 90m",
  ].some((fragment) => normalized.includes(fragment));
}

function isUnsupportedMarket(market: string, selection = "") {
  const normalized = normalizeText(`${market} ${selection}`);
  return [
    "correct score",
    "exact score",
    "first goal scorer",
    "last goal scorer",
    "anytime goal scorer",
    "player",
    "minute",
    "outright",
    "winning margin",
    "method",
    "penalty",
    "handicap",
    "asian",
    "spread",
    "odd even",
    "odd/even",
    "first half",
    "second half",
    "1st half",
    "2nd half",
    "first period",
    "second period",
    "result/both teams",
    "result both teams",
    "corner winner",
    "corners winner",
    "card winner",
    "tackle",
    "tackles",
    "throw in",
    "throwins",
    "throw ins",
  ].some((fragment) => normalized.includes(fragment)) || hasTimeSegment(`${market} ${selection}`);
}

function hasOverUnderLine(value: string) {
  const plain = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(",", ".");
  return /\b(over|under|mais de|menos de)\s+\d+(\.\d+)?\b/.test(plain);
}

function isComboSelection(selection: string) {
  const normalized = normalizeText(selection);
  return String(selection || "").includes("/") || normalized.includes(" and ") || normalized.includes(" e ");
}

function isWholeGameGoalsMarket(market: string, selection: string) {
  const normalized = normalizeText(market);
  if (!hasOverUnderLine(selection)) return false;
  if (isComboSelection(selection)) return false;
  if (["home", "away", "team", "home team", "away team"].some((fragment) => normalized.includes(fragment))) return false;
  return (
    normalized === "total" ||
    normalized === "over under" ||
    normalized.includes("total goals") ||
    normalized.includes("goals over under") ||
    normalized.includes("goal line") ||
    normalized.includes("gols totais") ||
    normalized.includes("total de gols") ||
    normalized.includes("mais menos gols")
  );
}

function isSimpleYesNo(selection: string) {
  return ["yes", "no", "sim", "nao"].includes(normalizeText(selection));
}

function isSimpleResultSelection(selection: string) {
  return ["home", "away", "draw", "1", "2", "x"].includes(normalizeText(selection));
}

function isSimpleDoubleChance(selection: string) {
  const normalized = normalizeText(selection);
  return [
    "home draw",
    "draw home",
    "away draw",
    "draw away",
    "home away",
    "away home",
    "1x",
    "x1",
    "x2",
    "2x",
    "12",
    "21",
  ].includes(normalized);
}

function isStandardPickMarket(category: MarketCategory, market: string, selection: string) {
  if (isUnsupportedMarket(market, selection)) return false;

  const normalizedMarket = normalizeText(market);
  if (category === "mais_menos_gols") return isWholeGameGoalsMarket(market, selection);
  if (category === "ambas_marcam") return isSimpleYesNo(selection);
  if (category === "resultado_final") return isSimpleResultSelection(selection);
  if (category === "dupla_chance") return isSimpleDoubleChance(selection);
  if (category === "escanteios") {
    return hasOverUnderLine(selection) && !isComboSelection(selection) && (
      normalizedMarket.includes("corner") ||
      normalizedMarket.includes("escanteio") ||
      normalizedMarket.includes("canto")
    );
  }
  if (category === "cartoes") {
    return hasOverUnderLine(selection) && !isComboSelection(selection);
  }
  if (category === "chutes_gol") {
    return hasOverUnderLine(selection) && !isComboSelection(selection);
  }

  return false;
}

function displaySelection(selection: string, fixture: ApiFootballFixture, market: string) {
  const normalized = normalizeText(selection);
  const normalizedMarket = normalizeText(market);
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;

  if (normalizedMarket.includes("double chance")) {
    if (normalized.includes("home") && normalized.includes("draw")) return `${home} ou empate`;
    if (normalized.includes("away") && normalized.includes("draw")) return `Empate ou ${away}`;
    if (normalized.includes("home") && normalized.includes("away")) return `${home} ou ${away}`;
    if (normalized.includes("1x")) return `${home} ou empate`;
    if (normalized.includes("x2")) return `Empate ou ${away}`;
    if (normalized.includes("12")) return `${home} ou ${away}`;
  }

  if (normalizedMarket.includes("winner") || normalizedMarket.includes("1x2") || normalizedMarket.includes("home away")) {
    if (normalized === "home" || normalized === "1") return home;
    if (normalized === "away" || normalized === "2") return away;
    if (normalized === "draw" || normalized === "x") return "Empate";
  }

  if (normalized === "home" || normalized === "1") return home;
  if (normalized === "away" || normalized === "2") return away;
  if (normalized === "draw" || normalized === "x") return "Empate";

  if (normalizedMarket.includes("handicap")) {
    return selection
      .replace(/^home/i, home)
      .replace(/^away/i, away)
      .replace(/^draw/i, "Empate");
  }

  if (normalized === "yes") return "Sim";
  if (normalized === "no") return "Nao";
  if (normalized === "none") return "Nenhum";
  if (normalized.startsWith("over ")) return selection.replace(/^over/i, "Mais de");
  if (normalized.startsWith("under ")) return selection.replace(/^under/i, "Menos de");
  if (normalized.startsWith("home ")) return selection.replace(/^home/i, home);
  if (normalized.startsWith("away ")) return selection.replace(/^away/i, away);

  return selection;
}

function displayMarket(market: string, fixture: ApiFootballFixture) {
  const raw = String(market || "").trim();
  const normalized = normalizeText(raw);
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const hasOverUnder = normalized.includes("over under") || normalized.includes("overunder") || normalized.includes("total");

  const sideLabel = (base: string) => {
    if (normalized.includes("home")) return `${base} do ${home}`;
    if (normalized.includes("away")) return `${base} do ${away}`;
    return `${base} totais`;
  };

  if (normalized.includes("double chance") || normalized.includes("dupla chance")) return "Dupla chance";
  if (normalized.includes("both teams") || normalized.includes("btts") || normalized.includes("ambas")) return "Ambas marcam";

  if (normalized.includes("corner") || normalized.includes("escanteio") || normalized.includes("canto")) {
    const base = sideLabel("Escanteios");
    if (normalized.includes("handicap")) return `${base} - handicap`;
    if (normalized.includes("1x2") || normalized.includes("winner")) return "Resultado em escanteios";
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("yellow") || normalized.includes("booking") || normalized.includes("card") || normalized.includes("cartao")) {
    const base = sideLabel(normalized.includes("yellow") ? "Cartoes amarelos" : "Cartoes");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("shot") || normalized.includes("chute") || normalized.includes("finalizacao")) {
    const base = sideLabel("Chutes ao gol");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized === "total" || normalized === "over under") return "Total de gols - Mais/Menos";
  if (normalized.includes("goal") || normalized.includes("gol")) {
    const base = sideLabel("Gols");
    return hasOverUnder ? `${base} - Mais/Menos` : base;
  }

  if (normalized.includes("asian handicap")) return "Handicap asiatico";
  if (normalized.includes("handicap")) return "Handicap";
  if (normalized.includes("team to score")) return "Time marca gol";
  if (normalized.includes("clean sheet")) return "Clean sheet";
  if (normalized.includes("winner") || normalized.includes("1x2") || normalized.includes("home away")) return "Resultado final";

  return raw.replace(/_/g, " ");
}

function pickScore(pick: Pick<NormalizedPick, "market" | "selection" | "odd" | "category" | "bookmaker">, targetOdd?: number) {
  const category = pick.category || marketCategory(pick.market, pick.selection);
  const target = targetOdd || CATEGORY_TARGET_ODD[category];
  const oddDistancePenalty = Math.abs(pick.odd - target) * 7;
  const shortPricePenalty = pick.odd < 1.18 ? 10 : 0;
  const longPricePenalty = pick.odd > 2.8 ? (pick.odd - 2.8) * 3.5 : 0;
  const drawPenalty = category === "resultado_final" && normalizeText(pick.selection) === "empate" ? 6 : 0;
  const bookmakerBoost = Math.min(8, bookmakerPriority(pick.bookmaker) * 0.28);

  return CATEGORY_BASE_SCORE[category] + bookmakerBoost - oddDistancePenalty - shortPricePenalty - longPricePenalty - drawPenalty;
}

function collectOddsValues(bookmakers: any[]) {
  const byKey = new Map<string, {
    selection: string;
    odd: number;
    bookmaker?: string;
    market: string;
    category: MarketCategory;
  }>();

  for (const bookmaker of bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      const market = String(bet.name || "");
      if (!market || isUnsupportedMarket(market)) continue;

      for (const value of bet.values || []) {
        const selection = String(value.value || "");
        if (hasDifficultLine(`${market} ${selection}`)) continue;

        const odd = Number.parseFloat(String(value.odd || "0"));
        const category = marketCategory(market, selection);

        if (category === "outros") continue;
        if (!isStandardPickMarket(category, market, selection)) continue;
        if (!Number.isFinite(odd) || odd < 1.12 || odd > 2.35) continue;

        const key = normalizeText(`${category}|${market}|${selection}`);
        const current = byKey.get(key);
        const priority = bookmakerPriority(bookmaker.name);
        const currentPriority = bookmakerPriority(current?.bookmaker);
        if (!current || odd > current.odd + 0.04 || (Math.abs(odd - current.odd) <= 0.04 && priority > currentPriority)) {
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

function bestPrematchPicks(fixture: ApiFootballFixture, oddsResponse: any[], requestedCategories: MarketCategory[] = []) {
  const bookmakers = oddsResponse?.[0]?.bookmakers || [];
  const candidates: NormalizedPick[] = [];
  const requestedSet = new Set(requestedCategories);

  for (const value of collectOddsValues(bookmakers)) {
    const odd = value.odd;
    if (odd < 1.18 || odd > 2.35) continue;
    if (requestedSet.size && !requestedSet.has(value.category)) continue;

    const pick = {
      fixtureId: fixture.fixture.id,
      game: fixtureName(fixture),
      league: fixture.league.name,
      startsAt: fixture.fixture.date,
      market: displayMarket(value.market, fixture),
      category: value.category,
      selection: displaySelection(value.selection, fixture, value.market),
      odd,
      bookmaker: value.bookmaker,
      impliedProbability: Number((100 / odd).toFixed(2)),
      score: 0,
    };
    pick.score = pickScore(pick);
    candidates.push(pick);
  }

  const ranked = candidates
    .slice()
    .sort((a, b) => b.score - a.score);
  const selected: NormalizedPick[] = [];
  const usedKeys = new Set<string>();
  const defaultPreferredCategories: MarketCategory[] = [
    "mais_menos_gols",
    "ambas_marcam",
    "dupla_chance",
    "escanteios",
    "cartoes",
    "chutes_gol",
    "time_marca",
  ];
  const preferredCategories = requestedCategories.length ? requestedCategories : defaultPreferredCategories;
  const addPick = (pick?: NormalizedPick) => {
    if (!pick) return;
    const key = normalizeText(`${pick.fixtureId}|${pick.market}|${pick.selection}`);
    if (usedKeys.has(key)) return;
    selected.push(pick);
    usedKeys.add(key);
  };

  for (const category of preferredCategories) {
    addPick(ranked.find((pick) => pick.category === category));
  }
  if (!requestedCategories.length || requestedCategories.includes("resultado_final")) {
    addPick(ranked.find((pick) => pick.category === "resultado_final"));
  }

  for (const pick of ranked) {
    if (selected.length >= 10) break;
    const categoryCount = selected.filter((item) => item.category === pick.category).length;
    const maxPerCategory = pick.category === "resultado_final" ? 1 : 2;
    if (categoryCount >= maxPerCategory) continue;
    addPick(pick);
  }

  return selected.slice(0, 10);
}

function leaguePriority(fixture: ApiFootballFixture) {
  const league = normalizeText(fixture.league.name || "");
  const country = normalizeText(fixture.league.country || "");

  if (league.includes("world cup")) return 100;
  if (league.includes("club world cup")) return 96;
  if (league.includes("euro") || league.includes("copa america")) return 92;
  if (league.includes("champions league") || league.includes("libertadores")) return 88;
  if (league.includes("serie a") && country.includes("brazil")) return 82;
  if (league.includes("serie b") && country.includes("brazil")) return 78;
  if (league.includes("serie c") && country.includes("brazil")) return 74;
  if (["england", "spain", "italy", "germany", "france", "portugal"].some((item) => country.includes(item))) return 76;
  if (league.includes("cup") || league.includes("copa")) return 58;
  return 42;
}

function isUsableFixture(fixture: ApiFootballFixture) {
  const status = fixture.fixture.status?.short || "";
  return !["CANC", "PST", "ABD", "AWD", "WO"].includes(status);
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results: R[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function priorityLeagueQueries(date: string) {
  const year = Number(date.slice(0, 4));
  return [
    { league: 1, season: year }, // FIFA World Cup
    { league: 15, season: year }, // FIFA Club World Cup
  ];
}

async function fetchFixturesForDate(date: string, scope: DailyScope = "all") {
  const errors: string[] = [];
  let fixtureRequests = 0;
  const safe = async (path: string, params: Record<string, string | number | undefined>) => {
    fixtureRequests += 1;
    try {
      return await apiFootball(path, params) as ApiFootballFixture[];
    } catch (error: any) {
      errors.push(error?.message || "Erro desconhecido");
      return [];
    }
  };
  const dates = [date, dateWithOffset(date, 1)];
  let searchMode = scope === "all"
    ? "janela diaria ampla sob demanda"
    : `${dailyScopeLabel(scope)} sob demanda`;
  let fixtures: ApiFootballFixture[] = [];

  if (scope === "all") {
    const broadGroups = await Promise.all(dates.map((targetDate) => {
      return safe("/fixtures", {
        date: targetDate,
        timezone: DEFAULT_TIMEZONE,
      });
    }));
    fixtures = uniqueFixtures(broadGroups.flat());
  } else {
    const leagueGroups = await Promise.all(dates.flatMap((targetDate) => {
      return brazilLeagueQueries(targetDate, scope).map((query) => {
        return safe("/fixtures", {
          date: targetDate,
          league: query.league,
          season: query.season,
          timezone: DEFAULT_TIMEZONE,
        });
      });
    }));
    fixtures = uniqueFixtures(leagueGroups.flat());
  }

  if (scope === "all" && !fixtures.length) {
    searchMode = "fallback economico por copas prioritarias";
    const leagueGroups = await Promise.all(dates.flatMap((targetDate) => {
      return priorityLeagueQueries(targetDate).map((query) => {
        return safe("/fixtures", {
          date: targetDate,
          league: query.league,
          season: query.season,
          timezone: DEFAULT_TIMEZONE,
        });
      });
    }));
    fixtures = uniqueFixtures(leagueGroups.flat());
  }

  if (!fixtures.length && errors.length) {
    throw new Error(errors.slice(0, 3).join(" | "));
  }

  return {
    fixtures,
    searchedDates: dates,
    fixtureRequests,
    searchMode,
  };
}

function gameScore(fixture: ApiFootballFixture, picks: NormalizedPick[]) {
  if (!picks.length) return 0;
  const diversity = new Set(picks.map((pick) => pick.category)).size;
  const topScore = picks.slice(0, 4).reduce((total, pick) => total + pick.score, 0) / Math.min(4, picks.length);
  return topScore + diversity * 2 + leaguePriority(fixture) * 0.22;
}

function ticketFromPicks(picks: NormalizedPick[], targetOdd: number, maxSelections: number, stake: number) {
  const ranked = picks
    .filter((pick) => pick.odd >= 1.18 && pick.odd <= 2.55)
    .slice()
    .sort((a, b) => {
      const aScore = pickScore(a, targetOdd);
      const bScore = pickScore(b, targetOdd);
      return bScore - aScore;
    });
  const selected: NormalizedPick[] = [];
  const usedFixtures = new Set<number>();
  const usedCategories = new Set<MarketCategory>();

  for (const avoidResult of [true, false]) {
    for (const requireNewCategory of [true, false]) {
      for (const pick of ranked) {
        if (selected.length >= maxSelections) break;
        if (usedFixtures.has(pick.fixtureId)) continue;
        if (avoidResult && pick.category === "resultado_final") continue;
        if (requireNewCategory && usedCategories.has(pick.category)) continue;

        selected.push(pick);
        usedFixtures.add(pick.fixtureId);
        usedCategories.add(pick.category);
      }
    }
  }

  const totalOdd = selected.reduce((total, pick) => total * pick.odd, 1);
  return {
    selections: selected,
    totalOdd: selected.length ? Number(totalOdd.toFixed(2)) : undefined,
    possibleReturn: selected.length ? Number((totalOdd * stake).toFixed(2)) : undefined,
  };
}

function deterministicAnalysis(params: {
  date: string;
  fixtures: ApiFootballFixture[];
  picks: NormalizedPick[];
  stake: number;
  maxSelections: number;
  requestedMarkets: MarketCategory[];
  scopeLabel?: string;
}) {
  const picksByFixture = new Map<number, NormalizedPick[]>();
  for (const pick of params.picks) {
    const group = picksByFixture.get(pick.fixtureId) || [];
    group.push(pick);
    picksByFixture.set(pick.fixtureId, group);
  }

  const rankedFixtures = params.fixtures
    .map((fixture) => ({
      fixture,
      picks: picksByFixture.get(fixture.fixture.id) || [],
      score: gameScore(fixture, picksByFixture.get(fixture.fixture.id) || []),
    }))
    .filter((item) => item.picks.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, DAILY_GAME_LIMIT);
  const rankedPicks = rankedFixtures.flatMap((item) => item.picks.slice(0, 4));

  return {
    mode: "daily-deterministic",
    summary: `Palpites sob demanda de ${params.scopeLabel || "futebol"} para ${params.date}: ${rankedFixtures.length} jogos na janela de 24h com odds de casas disponiveis${params.requestedMarkets.length ? " nos mercados marcados" : ""}. Priorizei mercados simples de maior probabilidade.`,
    gameByGame: rankedFixtures.map((item, index) => ({
      fixtureId: item.fixture.fixture.id,
      game: fixtureName(item.fixture),
      league: item.fixture.league.name,
      startsAt: item.fixture.fixture.date,
      score: Number(item.score.toFixed(2)),
      reason: index < 4
        ? "Prioridade alta pelo conjunto de liga, disponibilidade de odds e variedade de mercados."
        : "Opcao monitorada para bilhete secundario ou simples.",
      picks: item.picks.slice(0, 5),
    })),
    traps: rankedPicks
      .filter((pick) => pick.odd < 1.2 || pick.odd > 2.8 || (pick.category === "resultado_final" && pick.odd < 1.25))
      .slice(0, 8)
      .map((pick) => ({
        game: pick.game,
        market: pick.market,
        selection: pick.selection,
        odd: pick.odd,
        reason: pick.odd < 1.2 ? "Odd muito baixa para retorno pequeno." : pick.odd > 2.8 ? "Odd alta para multipla." : "Resultado seco curto, melhor comparar com mercado protegido.",
      })),
    conservativeTicket: ticketFromPicks(rankedPicks, 1.45, Math.min(3, params.maxSelections), params.stake),
    balancedTicket: ticketFromPicks(rankedPicks, 1.65, Math.min(4, params.maxSelections), params.stake),
    boldTicket: ticketFromPicks(rankedPicks, 1.9, params.maxSelections, params.stake),
    mainRecommendation: ticketFromPicks(rankedPicks, 1.65, Math.min(4, params.maxSelections), params.stake),
  };
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

async function aiAnalysis(payload: unknown, stake: number, maxSelections: number) {
  if (!getEnv("OPENAI_BASE_URL") && !getEnv("OPENAI_API_KEY")) return null;

  const openai = new OpenAI();
  const model = getEnv("OPENAI_MODEL") || DEFAULT_MODEL;
  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Voce monta palpites sob demanda de futebol com dados de API.",
          "Use somente os fixtures e picks fornecidos no JSON.",
          "Nao invente odds, estatisticas, lesoes ou escalacoes ausentes.",
          "Se requestedMarkets vier preenchido, use somente picks dessas categorias.",
          "Preserve fixtureId, game, market, category, selection, odd e impliedProbability dos picks originais.",
          "Nunca use nomes genericos como Jogo, Match ou Fixture nos tickets.",
          "Nunca use requestedMarkets como texto de market; market precisa ser o nome real do pick original.",
          "Escolha poucos jogos bons do dia, explique mercado por mercado e monte bilhetes prontos.",
          "Nunca coloque duas selecoes do mesmo jogo no mesmo bilhete. Em escanteios, cartoes, gols ou chutes, escolha uma linha por jogo.",
          "Use somente picks recebidos no JSON. Nao use handicap, spread, asian handicap, linhas 0.25/0.75 ou mercados dificeis.",
          "Priorize mercados simples e provaveis: mais/menos gols, mais/menos escanteios, mais/menos cartoes, dupla chance e ambas marcam.",
          "Evite bilhetes so com resultado final quando houver mercados alternativos.",
          "Devolva JSON valido com: summary, gameByGame, traps, conservativeTicket, balancedTicket, boldTicket, mainRecommendation.",
          "Cada ticket deve ter selections, totalOdd e possibleReturn.",
          `Stake=${stake}; maxSelections=${maxSelections}.`,
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ],
  });

  return parseJsonObject(completion.choices[0]?.message?.content || "{}");
}

function ticketSelections(ticket: any) {
  if (!ticket) return [];
  if (Array.isArray(ticket)) return ticket.filter((item) => item && typeof item === "object");
  if (Array.isArray(ticket.selections)) return ticket.selections.filter((item: any) => item && typeof item === "object");
  if (Array.isArray(ticket.picks)) return ticket.picks.filter((item: any) => item && typeof item === "object");
  return ticket && typeof ticket === "object" && (ticket.market || ticket.selection || ticket.odd) ? [ticket] : [];
}

function isGenericGameName(value: unknown) {
  const normalized = normalizeText(String(value || ""));
  return !normalized || normalized === "jogo" || normalized === "jogo nao informado" || normalized === "jogo nao identificado" || normalized === "match" || normalized === "fixture";
}

function isInternalMarketName(value: unknown) {
  const normalized = normalizeText(String(value || "")).replace(/\s+/g, "_");
  return [
    "resultado_final",
    "dupla_chance",
    "mais_menos_gols",
    "ambas_marcam",
    "escanteios",
    "cartoes",
    "chutes_gol",
    "time_marca",
    "outros",
  ].includes(normalized);
}

function selectionGameName(selection: any) {
  if (!selection || typeof selection !== "object") return "";
  if (selection.apiGame) return selection.apiGame;
  if (selection.game) return selection.game;
  if (selection.fixture) return selection.fixture;
  if (selection.match) return selection.match;
  if (selection.event) return selection.event;
  if (selection.matchName) return selection.matchName;
  if (selection.homeTeam && selection.awayTeam) return `${selection.homeTeam} x ${selection.awayTeam}`;
  if (selection.home && selection.away) return `${selection.home} x ${selection.away}`;
  return "";
}

function findMatchingPick(selection: any, picks: NormalizedPick[]) {
  if (!selection || !picks.length) return null;
  const fixtureId = Number(selection.fixtureId || selection.fixture_id || 0);
  const odd = Number(selection.odd);
  const category = marketCategory(String(selection.market || selection.category || ""), String(selection.selection || selection.pick || ""));
  const selectionText = normalizeText(String(selection.selection || selection.pick || selection.value || ""));
  const gameText = normalizeText(String(selectionGameName(selection)));

  let best: { pick: NormalizedPick; score: number } | null = null;
  for (const pick of picks) {
    let score = 0;
    if (fixtureId && pick.fixtureId === fixtureId) score += 10;
    if (Number.isFinite(odd) && Math.abs(pick.odd - odd) <= 0.03) score += 6;
    if (category !== "outros" && pick.category === category) score += 5;
    const pickText = normalizeText(pick.selection);
    if (selectionText && (pickText.includes(selectionText) || selectionText.includes(pickText))) score += 4;
    const pickGame = normalizeText(pick.game);
    if (gameText && !isGenericGameName(gameText) && (pickGame.includes(gameText) || gameText.includes(pickGame))) score += 8;
    if (!best || score > best.score) best = { pick, score };
  }

  return best && best.score >= 6 ? best.pick : null;
}

function repairSelection(selection: any, picks: NormalizedPick[]) {
  const match = findMatchingPick(selection, picks);
  if (!match) return selection;

  const currentGame = selectionGameName(selection);
  const game = isGenericGameName(currentGame)
    ? match.game
    : currentGame;
  const market = isInternalMarketName(selection.market) || !selection.market
    ? match.market
    : selection.market;
  const pick = selection.selection || selection.pick || selection.value || match.selection;

  return {
    ...match,
    ...selection,
    fixtureId: Number(selection.fixtureId || match.fixtureId),
    game,
    market,
    selection: pick,
    odd: Number(selection.odd || match.odd),
    impliedProbability: selection.impliedProbability || match.impliedProbability,
  };
}

function selectionFixtureKey(selection: any) {
  const fixtureId = Number(selection?.fixtureId || selection?.fixture_id || 0);
  if (fixtureId) return `fixture:${fixtureId}`;
  const game = normalizeText(selectionGameName(selection));
  return game && !isGenericGameName(game) ? `game:${game}` : "";
}

function dedupeTicketSelections(selections: any[]) {
  const byFixture = new Map<string, { selection: any; score: number; index: number }>();

  selections.forEach((selection, index) => {
    const category = marketCategory(String(selection.market || selection.category || ""), String(selection.selection || selection.pick || selection.value || ""));
    const key = selectionFixtureKey(selection) || `pick:${normalizeText(`${selection.fixtureId || ""}|${selection.market || ""}|${selection.selection || selection.pick || selection.value || ""}`)}`;
    const odd = Number(selection.odd);
    const score = Number.isFinite(odd)
      ? pickScore({ ...selection, odd, category } as NormalizedPick)
      : -1000;
    const current = byFixture.get(key);
    if (!current || score > current.score) {
      byFixture.set(key, { selection, score, index });
    }
  });

  return [...byFixture.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => item.selection);
}

function hasBrokenTicket(ticket: any) {
  const selections = ticketSelections(ticket);
  if (!selections.length) return true;
  return selections.some((selection) => {
    const game = selectionGameName(selection);
    return isGenericGameName(game);
  });
}

function normalizeTicket(ticket: any, fallbackTicket: any, picks: NormalizedPick[], stake: number) {
  const repairedSelections = ticketSelections(ticket).map((selection) => repairSelection(selection, picks));
  const selections = dedupeTicketSelections(repairedSelections);
  if (!selections.length || selections.some((selection: any) => isGenericGameName(selectionGameName(selection)))) {
    return fallbackTicket;
  }
  const totalOdd = selections.reduce((total: number, selection: any) => {
    const odd = Number(selection.odd);
    return Number.isFinite(odd) && odd > 1 ? total * odd : total;
  }, 1);
  return {
    ...(Array.isArray(ticket) ? {} : ticket),
    selections,
    totalOdd: selections.length ? Number(totalOdd.toFixed(2)) : undefined,
    possibleReturn: selections.length ? Number((totalOdd * stake).toFixed(2)) : undefined,
  };
}

function normalizeDailyAnalysisShape(analysis: any, deterministic: any, picks: NormalizedPick[], stake: number) {
  if (!analysis || typeof analysis !== "object") return deterministic;
  const normalized = { ...analysis };
  const ticketKeys = ["conservativeTicket", "balancedTicket", "boldTicket"] as const;

  for (const key of ticketKeys) {
    normalized[key] = normalizeTicket(normalized[key], deterministic[key], picks, stake);
  }

  normalized.mainRecommendation = normalizeTicket(
    normalized.mainRecommendation,
    normalized.balancedTicket || deterministic.mainRecommendation,
    picks,
    stake
  );

  if (Array.isArray(normalized.gameByGame)) {
    const hasGenericGame = normalized.gameByGame.some((item: any) => isGenericGameName(item?.game || item?.match || item?.fixture));
    if (hasGenericGame) normalized.gameByGame = deterministic.gameByGame;
  } else {
    normalized.gameByGame = deterministic.gameByGame;
  }

  return normalized;
}

async function computeDailyReport(
  date: string,
  stake: number,
  maxSelections: number,
  requestedMarkets: MarketCategory[] = [],
  scope: DailyScope = "all"
): Promise<DailyReport> {
  const fixtureSearch = await fetchFixturesForDate(date, scope);
  const windowFixtures = fixtureSearch.fixtures
    .filter(isUsableFixture)
    .filter((fixture) => isInDailyWindow(fixture, date))
    .sort((a, b) => {
      const priority = leaguePriority(b) - leaguePriority(a);
      return priority || new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime();
    });
  const fixtures = windowFixtures.slice(0, DAILY_FIXTURE_CANDIDATE_LIMIT);

  let oddsRequests = 0;
  const oddsResults: Array<{ fixture: ApiFootballFixture; picks: NormalizedPick[] }> = [];
  for (let index = 0; index < fixtures.length; index += DAILY_ODDS_BATCH_SIZE) {
    const batch = fixtures.slice(index, index + DAILY_ODDS_BATCH_SIZE);
    const batchResults = await mapLimit(batch, DAILY_ODDS_BATCH_SIZE, async (fixture) => {
      oddsRequests += 1;
      try {
        const odds = await apiFootball("/odds", {
          fixture: fixture.fixture.id,
          timezone: DEFAULT_TIMEZONE,
        });
        return {
          fixture,
          picks: bestPrematchPicks(fixture, odds, requestedMarkets),
        };
      } catch {
        return {
          fixture,
          picks: [],
        };
      }
    });
    oddsResults.push(...batchResults);
    if (oddsResults.filter((item) => item.picks.length).length >= DAILY_GAME_LIMIT) break;
  }

  const fixturesWithPicks = oddsResults
    .filter((item) => item.picks.length)
    .sort((a, b) => gameScore(b.fixture, b.picks) - gameScore(a.fixture, a.picks))
    .slice(0, DAILY_GAME_LIMIT);
  const topFixtures = fixturesWithPicks.map((item) => item.fixture);
  const picks = fixturesWithPicks.flatMap((item) => item.picks);
  const deterministic = deterministicAnalysis({
    date,
    fixtures: topFixtures,
    picks,
    stake,
    maxSelections,
    requestedMarkets,
    scopeLabel: dailyScopeLabel(scope),
  });

  let analysis: any = deterministic;
  if (getEnv("DAILY_PICKS_AI") === "1") {
    try {
      const ai = await aiAnalysis({
        generatedAt: new Date().toISOString(),
        date,
        timezone: DEFAULT_TIMEZONE,
        fixtures: topFixtures,
        picks,
        requestedMarkets,
        scope,
        scopeLabel: dailyScopeLabel(scope),
        deterministic,
      }, stake, maxSelections);
      if (ai && typeof ai === "object" && typeof (ai as any).summary === "string") analysis = ai as typeof deterministic;
    } catch {
      analysis = deterministic;
    }
  }
  analysis = normalizeDailyAnalysisShape(analysis, deterministic, picks, stake);

  return {
    source: {
      provider: "API-Football + casas disponiveis + on-demand",
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "Sob demanda",
      fixturesFound: windowFixtures.length,
      fixtureRequests: fixtureSearch.fixtureRequests,
      oddsRequests,
      searchedDates: fixtureSearch.searchedDates,
      searchMode: fixtureSearch.searchMode,
      gameLimit: DAILY_GAME_LIMIT,
      candidateLimit: DAILY_FIXTURE_CANDIDATE_LIMIT,
      scope,
      scopeLabel: dailyScopeLabel(scope),
      cacheVersion: REPORT_CACHE_VERSION,
      gamesAnalyzed: topFixtures.length,
      matched: topFixtures.length,
      picksFound: picks.length,
      requestedMarkets,
      marketFilterApplied: requestedMarkets.length > 0,
    },
    analysis,
    raw: {
      fixtures: topFixtures,
      picks,
    },
  };
}

function dailyStore() {
  return getStore({ name: "daily-picks", consistency: "strong" });
}

function cacheMarketKey(markets: MarketCategory[]) {
  return markets.length ? markets.slice().sort().join("-") : "todos";
}

function reportCacheKey(date: string, scope: DailyScope, markets: MarketCategory[] = []) {
  return `reports/${REPORT_CACHE_VERSION}/${date}/${scope}/${cacheMarketKey(markets)}.json`;
}

function isUsableReport(report: DailyReport | null) {
  const picks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  return Boolean(
    report?.source?.picksFound &&
    report.source.picksFound > 0 &&
    String(report.source.provider || "").includes("casas disponiveis") &&
    report.source.cacheVersion === REPORT_CACHE_VERSION &&
    picks.length &&
    picks.every((pick) => pick.bookmaker)
  );
}

async function readCachedReport(date: string, scope: DailyScope, requestedMarkets: MarketCategory[]) {
  try {
    const report = await dailyStore().get(reportCacheKey(date, scope, requestedMarkets), { type: "json" }) as DailyReport | null;
    return isUsableReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveReport(report: DailyReport) {
  if (!isUsableReport(report)) {
    throw new Error("Palpites sob demanda gerados sem picks validos; nao salvei cache vazio.");
  }

  try {
    const store = dailyStore();
    await store.setJSON(reportCacheKey(report.source.date, report.source.scope || "all", report.source.requestedMarkets || []), report);
    await store.setJSON("latest.json", report);
    await store.delete("latest-error.json");
  } catch {
    // A manual response is still useful even if persistent storage is unavailable locally.
  }
}

export async function saveDailyReportError(date: string, error: unknown) {
  try {
    const store = dailyStore();
    await store.setJSON("latest-error.json", {
      date,
      generatedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error || "Erro desconhecido"),
    });
  } catch {
    // Status storage is best-effort.
  }
}

export async function generateAndSaveDailyReport(
  date = todayInSaoPaulo(),
  stake = DEFAULT_STAKE,
  maxSelections = DEFAULT_MAX_SELECTIONS,
  requestedMarkets: MarketCategory[] = [],
  scope: DailyScope = "all"
) {
  const selectionLimit = Math.max(1, Math.min(DAILY_GAME_LIMIT, maxSelections));
  const report = await computeDailyReport(date, stake, selectionLimit, requestedMarkets, scope);
  if (!isUsableReport(report)) {
    throw new Error("Palpites sob demanda ficaram vazios: a API nao retornou odds/picks validos para os jogos encontrados.");
  }
  await saveReport(report);
  return report;
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(1, Math.min(DAILY_GAME_LIMIT, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const requestedMarkets = requestedMarketCategories(url.searchParams.getAll("markets").join(","));
  const scope = parseDailyScope(url.searchParams.get("scope"));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  if (!getEnv("API_FOOTBALL_KEY")) {
    return json({
      error: "API_FOOTBALL_KEY ausente",
      setup: [
        "Configure API_FOOTBALL_KEY no Netlify.",
        "Os palpites sob demanda precisam da API-Football para fixtures e odds.",
      ],
    }, { status: 501 });
  }

  if (!refresh) {
    const cached = await readCachedReport(date, scope, requestedMarkets);
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
    const report = await generateAndSaveDailyReport(date, stake, maxSelections, requestedMarkets, scope);
    return json(report);
  } catch (error: any) {
    await saveDailyReportError(date, error);
    return json({
      error: "Nao consegui gerar os palpites sob demanda",
      detail: error?.message || "Erro desconhecido na busca de dados.",
      setup: [
        "Confira se a API_FOOTBALL_KEY ainda tem quota no plano.",
        "Confira se o endpoint de fixtures/odds esta disponivel para a competicao.",
        "Tente novamente em alguns minutos se a API estiver limitando requisicoes.",
      ],
    }, { status: 502 });
  }
};

export const config = {
  path: "/api/daily-picks",
  method: ["GET", "POST"],
};
