import { getStore } from "@netlify/blobs";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 5;
const SPORT_LIMIT = 3;
const CANDIDATE_LIMIT = 12;
const REPORT_CACHE_VERSION = "volley-points-v2";

type SportKey = "volleyball";

type ApiEvent = {
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
  category?: {
    name?: string;
  };
};

type PickCategory =
  | "vencedor"
  | "handicap"
  | "total"
  | "outros";

type SportPick = {
  fixtureId: number;
  sport: SportKey;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: PickCategory;
  selection: string;
  odd: number;
  bookmaker?: string;
  impliedProbability: number;
  score: number;
  reason?: string;
};

type SportReport = {
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
    cacheVersion?: string;
    cached?: boolean;
  };
  analysis: Record<string, unknown>;
  raw: {
    fixtures: ApiEvent[];
    picks: SportPick[];
  };
};

const SPORTS: Record<SportKey, {
  label: string;
  baseUrl: string;
  eventsPath: string;
  oddsParam: string;
  envKeys: string[];
}> = {
  volleyball: {
    label: "Volei",
    baseUrl: "https://v1.volleyball.api-sports.io",
    eventsPath: "/games",
    oddsParam: "game",
    envKeys: ["API_VOLLEYBALL_KEY", "API_SPORTS_KEY", "API_FOOTBALL_KEY"],
  },
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

function sportKey(sport: SportKey) {
  return SPORTS[sport].envKeys.map(getEnv).find(Boolean) || "";
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
  if (normalized.includes("betano")) return 14;
  if (normalized.includes("pinnacle")) return 13;
  if (normalized.includes("bet365")) return 12;
  if (normalized.includes("betfair")) return 11;
  if (normalized.includes("1xbet")) return 10;
  if (normalized.includes("sbo")) return 9;
  if (normalized.includes("stake")) return 8;
  if (normalized.includes("unibet")) return 7;
  if (normalized.includes("betway")) return 6;
  if (normalized.includes("bwin")) return 5;
  return 1;
}

function hasDifficultLine(value: string) {
  return /(^|[^\d])\d+[,.](25|75)([^\d]|$)/.test(String(value || ""));
}

function extractLine(value: string) {
  const match = String(value || "").match(/(^|[^\d])(\d+(?:[,.]\d+)?)([^\d]|$)/);
  if (!match) return null;
  const line = Number(match[2].replace(",", "."));
  return Number.isFinite(line) ? line : null;
}

function hasInvalidVolleyballPointsLine(market: string, selection: string) {
  if (!isVolleyballTotalPointsMarket(market)) return false;
  const line = extractLine(selection || market);
  return line !== null && line < 15;
}

function isVolleyballTotalSetsMarket(market: string) {
  const normalized = normalizeText(market);
  return (
    normalized.includes("total sets") ||
    normalized.includes("sets total") ||
    normalized.includes("number of sets") ||
    normalized.includes("total de sets")
  );
}

function volleyballSetLabel(market: string) {
  const normalized = normalizeText(market);
  const match = normalized.match(/\b(?:set|sets|seto)\s*([1-5])\b/) || normalized.match(/\b([1-5])(?:st|nd|rd|th)\s*set\b/);
  if (!match) return "";
  const labels: Record<string, string> = {
    "1": "1o set",
    "2": "2o set",
    "3": "3o set",
    "4": "4o set",
    "5": "5o set",
  };
  return labels[match[1]] || "";
}

function isVolleyballTotalPointsMarket(market: string) {
  const normalized = normalizeText(market);
  if (isVolleyballTotalSetsMarket(market)) return false;
  if (normalized.includes("team") || normalized.includes("player")) return false;
  return (
    normalized.includes("total points") ||
    normalized.includes("points total") ||
    normalized.includes("match points") ||
    normalized.includes("set points") ||
    normalized.includes("total de pontos") ||
    (normalized.includes("over under") && normalized.includes("points"))
  );
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

async function apiSports(sport: SportKey, path: string, params: Record<string, string | number | undefined> = {}) {
  const config = SPORTS[sport];
  const key = sportKey(sport);
  const url = new URL(path, config.baseUrl);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": key,
    },
  });

  if (!response.ok) {
    throw new Error(`${config.label} API HTTP ${response.status}`);
  }

  const data = await response.json();
  const errors = Array.isArray(data.errors)
    ? data.errors
    : data.errors && typeof data.errors === "object"
      ? Object.values(data.errors)
      : [];
  if (errors.length) {
    throw new Error(`${config.label} API: ${errors.join(" | ")}`);
  }

  return data.response || [];
}

function participantNames(event: ApiEvent) {
  return {
    home: event.teams?.home?.name || "Mandante",
    away: event.teams?.away?.name || "Visitante",
  };
}

function eventName(event: ApiEvent) {
  const names = participantNames(event);
  return `${names.home} x ${names.away}`;
}

function isPreEvent(event: ApiEvent) {
  const status = normalizeText(String(event.status?.short || event.status?.long || ""));
  return !status || ["ns", "not started", "scheduled", "tbd"].some((item) => status.includes(item));
}

function leaguePriority(event: ApiEvent, sport: SportKey) {
  const league = normalizeText(`${event.league?.name || ""} ${event.country?.name || ""} ${event.category?.name || ""}`);

  if (league.includes("nations league") || league.includes("world championship") || league.includes("olympic")) return 13;
  if (league.includes("champions league") || league.includes("superlega") || league.includes("plusliga")) return 11;
  if (league.includes("italy") || league.includes("poland") || league.includes("turkey") || league.includes("brazil") || league.includes("japan")) return 9;
  if (league.includes("france") || league.includes("germany") || league.includes("russia")) return 8;
  return 4;
}

function isUnsupportedMarket(sport: SportKey, market: string) {
  const normalized = normalizeText(market);
  if (sport === "volleyball" && isVolleyballTotalPointsMarket(market)) return false;
  if (sport === "volleyball" && isVolleyballTotalSetsMarket(market)) return true;

  const commonBad = [
    "alternative",
    "alternate",
    "correct score",
    "exact score",
    "odd even",
    "race to",
    "last",
    "player",
    "minute",
    "round betting",
    "round winner",
    "handicap",
    "asian",
    "spread",
  ];
  if (commonBad.some((fragment) => normalized.includes(fragment))) return true;

  return [
    "set winner",
    "winner set",
    "set handicap",
    "correct set",
  ].some((fragment) => normalized.includes(fragment));
}

function marketCategory(sport: SportKey, market: string, selection = ""): PickCategory {
  const normalizedMarket = normalizeText(market);
  if (isUnsupportedMarket(sport, market)) return "outros";

  if (
    ["winner", "match winner", "home away", "moneyline", "to win"].includes(normalizedMarket) ||
    normalizedMarket.includes("winner") ||
    normalizedMarket.includes("home away") ||
    normalizedMarket.includes("match result") ||
    normalizedMarket.includes("game winner")
  ) return "vencedor";

  if (isVolleyballTotalPointsMarket(market)) return "total";

  return "outros";
}

function displayMarket(sport: SportKey, market: string) {
  const normalized = normalizeText(market);
  if (normalized.includes("winner") || normalized.includes("home away") || normalized.includes("moneyline")) return "Vencedor da partida";
  if (normalized.includes("handicap")) return "Handicap de sets/pontos";
  if (isVolleyballTotalPointsMarket(market)) {
    const setLabel = volleyballSetLabel(market);
    return setLabel ? `Total de pontos ${setLabel} - Mais/Menos` : "Total de pontos - Mais/Menos";
  }
  return String(market || "").replace(/_/g, " ");
}

function displaySelection(selection: string, event: ApiEvent) {
  const raw = String(selection || "").trim();
  const normalized = normalizeText(raw);
  const names = participantNames(event);
  if (normalized === "home" || normalized === "1") return names.home;
  if (normalized === "away" || normalized === "2") return names.away;
  if (normalized === "draw" || normalized === "x") return "Empate";
  if (normalized === "yes") return "Sim";
  if (normalized === "no") return "Nao";
  if (normalized.startsWith("over ")) return raw.replace(/^over/i, "Mais de");
  if (normalized.startsWith("under ")) return raw.replace(/^under/i, "Menos de");
  if (normalized.startsWith("home ")) return raw.replace(/^home/i, names.home);
  if (normalized.startsWith("away ")) return raw.replace(/^away/i, names.away);
  return raw.replace(/_/g, " ");
}

function collectOddsValues(sport: SportKey, bookmakers: any[]) {
  const byKey = new Map<string, {
    selection: string;
    odd: number;
    bookmaker?: string;
    market: string;
    category: PickCategory;
  }>();

  for (const bookmaker of bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      const market = String(bet.name || "");
      if (!market || isUnsupportedMarket(sport, market)) continue;

      for (const value of bet.values || []) {
        const selection = String(value.value || "");
        if (hasDifficultLine(`${market} ${selection}`)) continue;
        if (sport === "volleyball" && hasInvalidVolleyballPointsLine(market, selection)) continue;

        const odd = Number.parseFloat(String(value.odd || "0"));
        const category = marketCategory(sport, market, selection);
        if (category === "outros") continue;
        if (!Number.isFinite(odd) || odd < 1.12 || odd > 2.25) continue;

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

const CATEGORY_BASE_SCORE: Record<PickCategory, number> = {
  vencedor: 50,
  total: 39,
  outros: 0,
};

const CATEGORY_TARGET_ODD: Record<PickCategory, number> = {
  vencedor: 1.45,
  total: 1.62,
  outros: 1.7,
};

function pickScore(pick: Pick<SportPick, "odd" | "category" | "bookmaker">, event: ApiEvent, sport: SportKey) {
  const target = CATEGORY_TARGET_ODD[pick.category] || 1.7;
  const oddDistancePenalty = Math.abs(pick.odd - target) * 8;
  const shortPricePenalty = pick.odd < 1.2 ? 9 : 0;
  const longPricePenalty = pick.odd > 2.05 ? (pick.odd - 2.05) * 10 : 0;
  const bookmakerBoost = bookmakerPriority(pick.bookmaker) * 0.6;
  return CATEGORY_BASE_SCORE[pick.category] + leaguePriority(event, sport) + bookmakerBoost - oddDistancePenalty - shortPricePenalty - longPricePenalty;
}

function reasonForPick(pick: SportPick) {
  if (pick.category === "vencedor") return "Mercado mais simples do volei: vencedor da partida.";
  if (pick.category === "total") return pick.market.includes("set")
    ? "Total de pontos por set, mercado comum e facil de conferir na Bet."
    : "Total de pontos da partida, linha comum para volei.";
  return "Mercado padrao filtrado por odd e clareza.";
}

function bestPicksForEvent(event: ApiEvent, oddsResponse: any[], sport: SportKey) {
  const bookmakers = oddsResponse?.[0]?.bookmakers || [];
  const picks: SportPick[] = [];

  for (const value of collectOddsValues(sport, bookmakers)) {
    const pick: SportPick = {
      fixtureId: event.id,
      sport,
      game: eventName(event),
      league: event.league?.name || event.category?.name || "Competicao nao informada",
      startsAt: event.date,
      market: displayMarket(sport, value.market),
      category: value.category,
      selection: displaySelection(value.selection, event),
      odd: value.odd,
      bookmaker: value.bookmaker,
      impliedProbability: Number((100 / value.odd).toFixed(2)),
      score: 0,
    };
    pick.score = pickScore(pick, event, sport);
    pick.reason = reasonForPick(pick);
    picks.push(pick);
  }

  const ranked = picks.slice().sort((a, b) => b.score - a.score);
  const selected: SportPick[] = [];
  const preferred = ["vencedor", "total"];

  for (const category of preferred as PickCategory[]) {
    const pick = ranked.find((item) => item.category === category);
    if (pick) selected.push(pick);
  }

  for (const pick of ranked) {
    if (selected.length >= 3) break;
    const duplicate = selected.some((item) => normalizeText(`${item.market}|${item.selection}`) === normalizeText(`${pick.market}|${pick.selection}`));
    if (!duplicate) selected.push(pick);
  }

  return selected.sort((a, b) => b.score - a.score);
}

async function fetchWindowEvents(sport: SportKey, date: string) {
  const searchedDates = [date, addDays(date, 1), addDays(date, 2)];
  const all: ApiEvent[] = [];
  const dateErrors: string[] = [];

  for (const itemDate of searchedDates) {
    try {
      const events = await apiSports(sport, SPORTS[sport].eventsPath, {
        date: itemDate,
        timezone: DEFAULT_TIMEZONE,
      });
      all.push(...events);
    } catch (error: any) {
      dateErrors.push(`${itemDate}: ${error?.message || "erro ao buscar jogos"}`);
      if (!all.length && itemDate === date) continue;
      break;
    }
    if (all.filter(isPreEvent).length >= CANDIDATE_LIMIT) break;
  }

  if (!all.length && dateErrors.length) {
    throw new Error(dateErrors.join(" | "));
  }

  const seen = new Set<number>();
  const unique = all.filter((event) => {
    if (!event?.id || seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });

  return {
    events: unique,
    searchedDates,
    searchMode: searchedDates.length > 1 ? "hoje + proximos dias" : "hoje",
  };
}

async function collectSportPicks(sport: SportKey, date: string) {
  const window = await fetchWindowEvents(sport, date);
  const candidates = window.events
    .filter(isPreEvent)
    .sort((a, b) => leaguePriority(b, sport) - leaguePriority(a, sport))
    .slice(0, CANDIDATE_LIMIT);

  let oddsRequests = 0;
  const fixturesWithPicks: Array<{ fixture: ApiEvent; picks: SportPick[] }> = [];

  for (const event of candidates) {
    let odds: any[] = [];
    try {
      oddsRequests += 1;
      odds = await apiSports(sport, "/odds", {
        [SPORTS[sport].oddsParam]: event.id,
      });
    } catch {
      odds = [];
    }

    const picks = bestPicksForEvent(event, odds, sport);
    if (picks.length) fixturesWithPicks.push({ fixture: event, picks });
    if (fixturesWithPicks.length >= SPORT_LIMIT) break;
  }

  fixturesWithPicks.sort((a, b) => (b.picks[0]?.score || 0) - (a.picks[0]?.score || 0));

  return {
    ...window,
    oddsRequests,
    fixtures: fixturesWithPicks.map((item) => item.fixture),
    picks: fixturesWithPicks.flatMap((item) => item.picks).sort((a, b) => b.score - a.score),
  };
}

function chooseTicketSelections(picks: SportPick[], maxSelections: number, mode: "conservative" | "balanced" | "bold") {
  const ranges = {
    conservative: { min: 1.18, max: 1.68, limit: Math.min(2, maxSelections) },
    balanced: { min: 1.22, max: 1.95, limit: Math.min(3, maxSelections) },
    bold: { min: 1.35, max: 2.35, limit: Math.min(4, maxSelections) },
  };
  const range = ranges[mode];
  const chosen: SportPick[] = [];
  const usedEvents = new Set<string>();
  const ranked = picks
    .filter((pick) => pick.odd >= range.min && pick.odd <= range.max)
    .slice()
    .sort((a, b) => b.score - a.score);

  for (const pick of ranked) {
    if (chosen.length >= range.limit) break;
    const eventKey = `${pick.sport}:${pick.fixtureId}`;
    if (usedEvents.has(eventKey)) continue;
    chosen.push(pick);
    usedEvents.add(eventKey);
  }

  for (const pick of ranked) {
    if (chosen.length >= range.limit) break;
    const eventKey = `${pick.sport}:${pick.fixtureId}`;
    if (usedEvents.has(eventKey)) continue;
    chosen.push(pick);
    usedEvents.add(eventKey);
  }

  return chosen;
}

function buildTicket(picks: SportPick[], maxSelections: number, stake: number, mode: "conservative" | "balanced" | "bold") {
  const selections = chooseTicketSelections(picks, maxSelections, mode);
  if (!selections.length) return { selections: [] };
  const totalOdd = selections.reduce((total, selection) => total * selection.odd, 1);
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason: mode === "conservative"
      ? "Bilhete curto com mercados principais e odds mais controladas."
      : mode === "balanced"
        ? "Equilibrio entre Volei, probabilidade e retorno."
        : "Retorno maior usando apenas um mercado por evento.",
  };
}

function deterministicAnalysis(fixtures: ApiEvent[], picks: SportPick[], stake: number, maxSelections: number, date: string) {
  const topPicksByEvent = new Map<string, SportPick[]>();
  for (const pick of picks) {
    const key = `${pick.sport}:${pick.fixtureId}`;
    const list = topPicksByEvent.get(key) || [];
    list.push(pick);
    topPicksByEvent.set(key, list);
  }

  const gameByGame = fixtures.map((event) => {
    const sport = picks.find((pick) => pick.fixtureId === event.id)?.sport || "volleyball";
    const eventPicks = (topPicksByEvent.get(`${sport}:${event.id}`) || []).slice(0, 3);
    const best = eventPicks[0];
    return {
      game: eventName(event),
      apiGame: eventName(event),
      league: event.league?.name || event.category?.name || "Competicao nao informada",
      startsAt: event.date,
      bestMarket: best?.market || "",
      reason: best
        ? `${best.selection} foi a melhor entrada encontrada. ${best.reason || ""}`
        : "Evento encontrado, mas sem odds aproveitaveis nos 3 mercados padrao.",
      risk: best?.odd && best.odd >= 2 ? "alto" : "medio",
      picks: eventPicks,
    };
  });

  return {
    summary: picks.length
      ? `Palpites de Volei gerados para ${date}. Usei casas disponiveis na API e apenas mercados simples de volei.`
      : "Encontrei eventos, mas nao achei odds aproveitaveis nos mercados simples de Volei.",
    gameByGame,
    traps: picks
      .filter((pick) => pick.odd < 1.18 || pick.odd > 2.45)
      .slice(0, 5)
      .map((pick) => ({
        game: pick.game,
        market: pick.market,
        selection: pick.selection,
        odd: pick.odd,
        reason: pick.odd < 1.18 ? "Odd muito baixa para retorno pequeno." : "Odd alta demais para priorizar probabilidade.",
      })),
    conservativeTicket: buildTicket(picks, maxSelections, stake, "conservative"),
    balancedTicket: buildTicket(picks, maxSelections, stake, "balanced"),
    boldTicket: buildTicket(picks, maxSelections, stake, "bold"),
    mainRecommendation: buildTicket(picks, maxSelections, stake, "balanced"),
  };
}

async function computeReport(date: string, stake: number, maxSelections: number): Promise<SportReport> {
  const volleyball = sportKey("volleyball") ? await collectSportPicks("volleyball", date) : null;
  const reports = [volleyball].filter(Boolean) as Array<Awaited<ReturnType<typeof collectSportPicks>>>;
  const fixtures = reports.flatMap((report) => report.fixtures);
  const picks = reports.flatMap((report) => report.picks).sort((a, b) => b.score - a.score);
  const analysis = deterministicAnalysis(fixtures, picks, stake, Math.max(1, Math.min(5, maxSelections)), date);
  const searchedDates = [...new Set(reports.flatMap((report) => report.searchedDates))];

  return {
    source: {
      provider: "API-Volleyball + casas disponiveis + mercados simples",
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "On-demand",
      gamesFound: reports.reduce((sum, report) => sum + report.events.length, 0),
      searchedDates,
      searchMode: searchedDates.length > 1 ? "hoje + proximos dias" : "hoje",
      gameLimit: SPORT_LIMIT,
      candidateLimit: CANDIDATE_LIMIT,
      oddsRequests: reports.reduce((sum, report) => sum + report.oddsRequests, 0),
      gamesAnalyzed: fixtures.length,
      matched: fixtures.length,
      picksFound: picks.length,
      cacheVersion: REPORT_CACHE_VERSION,
    },
    analysis,
    raw: {
      fixtures,
      picks,
    },
  };
}

function reportStore() {
  return getStore({ name: "daily-volleyball-picks", consistency: "strong" });
}

function isUsableReport(report: SportReport | null) {
  const picks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  return Boolean(
    report?.source?.picksFound &&
    report.source.picksFound > 0 &&
    String(report.source.provider || "").includes("API-Volleyball") &&
    report.source.cacheVersion === REPORT_CACHE_VERSION &&
    picks.length &&
    picks.every((pick) => pick.bookmaker && !isUnsupportedMarket(pick.sport, `${pick.market} ${pick.selection}`))
  );
}

async function readCachedReport(date: string) {
  try {
    const report = await reportStore().get(`reports/${REPORT_CACHE_VERSION}/${date}.json`, { type: "json" }) as SportReport | null;
    return isUsableReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveReport(report: SportReport) {
  if (!isUsableReport(report)) return;

  try {
    const store = reportStore();
    await store.setJSON(`reports/${REPORT_CACHE_VERSION}/${report.source.date}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // The response remains useful when blob storage is unavailable locally.
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(1, Math.min(5, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";
  const hasVolleyball = Boolean(sportKey("volleyball"));

  if (!hasVolleyball) {
    return json({
      error: "Chave de Volei ausente",
      setup: [
        "Configure API_VOLLEYBALL_KEY no Netlify.",
        "Se sua conta API-Sports liberar todos os esportes com uma chave, API_SPORTS_KEY ou API_FOOTBALL_KEY tambem pode funcionar.",
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
    const report = await computeReport(date, stake, maxSelections);
    await saveReport(report);
    return json(report);
  } catch (error: any) {
    return json({
      error: "Nao consegui gerar os palpites de Volei",
      detail: error?.message || "Erro desconhecido na busca de dados.",
      setup: [
        "Confira se API_VOLLEYBALL_KEY ou API_SPORTS_KEY tem acesso ao endpoint de volei.",
        "Confira se ainda existe quota no plano da API-Sports.",
        "Tente novamente em alguns minutos se a API estiver limitando requisicoes.",
      ],
    }, { status: 502 });
  }
};

export const config = {
  path: ["/api/daily-volleyball-picks", "/api/daily-combat-court-picks"],
  method: ["GET", "POST"],
};
