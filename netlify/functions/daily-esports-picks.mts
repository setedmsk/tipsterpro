import { getStore } from "@netlify/blobs";
import { friendlyErrorPayload } from "./_shared/http.mts";
import {
  ODDS_API_IO_PROVIDER,
  eventId,
  eventLeague,
  eventName,
  eventStart,
  isAllowedLocalDate,
  isPregameOrLive,
  loadEventsForSport,
  loadOddsForEvents,
  loadSelectedBookmakers,
  normalizeText,
  oddsApiIoKey,
  parseOdd,
  searchedDatesFor,
  todayInSaoPaulo,
} from "./_shared/odds-api-io.mts";

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 5;
const ESPORTS_GAME_LIMIT = 5;
const ESPORTS_CANDIDATE_LIMIT = 24;
const BOOKMAKER_FALLBACK = ["Pinnacle", "Bet365", "Unibet", "Betfair", "1xBet", "Stake"];
const KEY_NAMES = ["ESPORTS_ODDS_API_KEY"];

type EsportsCategory = "vencedor" | "total_mapas";

type EsportsPick = {
  fixtureId: string;
  sport: string;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: EsportsCategory;
  selection: string;
  odd: number;
  bookmaker: string;
  impliedProbability: number;
  score: number;
  reason?: string;
};

type EsportsReport = {
  source: {
    provider: string;
    date: string;
    generatedAt: string;
    timezone: string;
    schedule: string;
    sportsFound: number;
    gamesFound: number;
    searchedDates: string[];
    searchMode: string;
    gameLimit: number;
    candidateLimit: number;
    dateEligibleFound: number;
    oddsRequests: number;
    gamesAnalyzed: number;
    matched: number;
    picksFound: number;
    bookmakerFilter: string;
    errors?: string[];
    cached?: boolean;
  };
  analysis: Record<string, unknown>;
  raw: {
    fixtures: any[];
    picks: EsportsPick[];
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

function providerKey() {
  return oddsApiIoKey(KEY_NAMES);
}

function bookmakerPriority(bookmaker: string) {
  const normalized = normalizeText(bookmaker);
  if (normalized.includes("pinnacle")) return 14;
  if (normalized.includes("bet365")) return 13;
  if (normalized.includes("betfair")) return 12;
  if (normalized.includes("1xbet")) return 10;
  if (normalized.includes("stake")) return 8;
  if (normalized.includes("unibet")) return 7;
  return 4;
}

function displaySportName(event: any) {
  const name = String(event?.sport?.name || event?.sport || event?.league?.name || "E-sports");
  const text = normalizeText(`${name} ${eventLeague(event)}`);
  if (text.includes("counter") || text.includes("cs2") || text.includes("csgo")) return "CS2";
  if (text.includes("league of legends") || text.includes(" lol ")) return "League of Legends";
  if (text.includes("dota")) return "Dota 2";
  if (text.includes("valorant")) return "Valorant";
  return "E-sports";
}

function validMapLine(line: number) {
  return [1.5, 2.5, 3.5, 4.5, 5.5].some((value) => Math.abs(value - line) < 0.001);
}

function isUnsupportedMarket(name: string) {
  const text = normalizeText(name);
  return [
    "handicap",
    "spread",
    "asian",
    "map handicap",
    "correct score",
    "exact score",
    "first",
    "last",
    "player",
    "kill",
    "kills",
    "round",
    "rounds",
    "pistol",
    "special",
    "odd even",
    "race to",
    "map 1",
    "map 2",
    "map 3",
    "map 4",
    "map 5",
    "1st map",
    "2nd map",
    "3rd map",
    "4th map",
    "5th map",
  ].some((fragment) => text.includes(fragment));
}

function marketRows(market: any) {
  if (Array.isArray(market?.odds)) return market.odds;
  if (Array.isArray(market?.outcomes)) return market.outcomes;
  if (market?.odds && typeof market.odds === "object") return [market.odds];
  return [];
}

function bookmakerMarkets(event: any) {
  const bookmakers = event?.bookmakers || {};
  if (Array.isArray(bookmakers)) {
    return bookmakers.map((entry) => [String(entry.name || entry.bookmaker || "Casa"), entry.markets || entry.odds || []] as const);
  }
  return Object.entries(bookmakers).map(([name, markets]) => [name, markets] as const);
}

function addPick(
  picks: Map<string, EsportsPick>,
  event: any,
  bookmaker: string,
  category: EsportsCategory,
  market: string,
  selection: string,
  oddValue: unknown,
) {
  const odd = parseOdd(oddValue);
  if (!Number.isFinite(odd) || odd < 1.15 || odd > 2.45) return;

  const fixtureId = eventId(event);
  const pick: EsportsPick = {
    fixtureId,
    sport: displaySportName(event),
    game: eventName(event),
    league: eventLeague(event),
    startsAt: eventStart(event),
    market,
    category,
    selection,
    odd: Number(odd.toFixed(2)),
    bookmaker,
    impliedProbability: Number((100 / odd).toFixed(2)),
    score: 0,
  };
  pick.score = pickScore(pick);
  pick.reason = reasonForPick(pick);

  const key = normalizeText(`${fixtureId}|${category}|${market}|${selection}`);
  const current = picks.get(key);
  if (!current || pick.score > current.score || (pick.score === current.score && pick.odd > current.odd)) {
    picks.set(key, pick);
  }
}

function collectPicksFromEvent(event: any) {
  const picks = new Map<string, EsportsPick>();
  const home = String(event?.home || "Time 1");
  const away = String(event?.away || "Time 2");

  for (const [bookmaker, marketsValue] of bookmakerMarkets(event)) {
    const markets = Array.isArray(marketsValue) ? marketsValue : Object.values(marketsValue || {});
    for (const marketEntry of markets as any[]) {
      const marketName = String(marketEntry?.name || marketEntry?.market || marketEntry?.marketName || "");
      const marketText = normalizeText(marketName);
      if (!marketName || isUnsupportedMarket(marketName)) continue;

      for (const row of marketRows(marketEntry)) {
        if (marketName === "ML" || marketText.includes("moneyline") || marketText.includes("match winner")) {
          addPick(picks, event, bookmaker, "vencedor", "Vencedor da partida", home, row.home);
          addPick(picks, event, bookmaker, "vencedor", "Vencedor da partida", away, row.away);
          continue;
        }

        if (marketText.includes("total")) {
          const line = Number(row.hdp ?? row.line ?? row.total);
          if (!Number.isFinite(line) || !validMapLine(line)) continue;
          addPick(picks, event, bookmaker, "total_mapas", "Total de mapas - Mais/Menos", `Mais de ${line.toFixed(1)} mapas`, row.over);
          addPick(picks, event, bookmaker, "total_mapas", "Total de mapas - Mais/Menos", `Menos de ${line.toFixed(1)} mapas`, row.under);
        }
      }
    }
  }

  return [...picks.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function sportPriority(sport: string, league: string) {
  const text = normalizeText(`${sport} ${league}`);
  if (text.includes("counter") || text.includes("cs2") || text.includes("csgo")) return 16;
  if (text.includes("league of legends") || text.includes(" lol ")) return 14;
  if (text.includes("dota")) return 12;
  if (text.includes("valorant")) return 11;
  return 8;
}

function pickScore(pick: Pick<EsportsPick, "odd" | "category" | "sport" | "bookmaker" | "league">) {
  const base = pick.category === "vencedor" ? 54 : 44;
  const target = pick.category === "vencedor" ? 1.62 : 1.75;
  const oddPenalty = Math.abs(pick.odd - target) * 8;
  const lowPenalty = pick.odd < 1.2 ? 12 : 0;
  const highPenalty = pick.odd > 2.35 ? (pick.odd - 2.35) * 8 : 0;
  return base + sportPriority(pick.sport, pick.league) * 0.55 + bookmakerPriority(pick.bookmaker) * 0.35 - oddPenalty - lowPenalty - highPenalty;
}

function reasonForPick(pick: EsportsPick) {
  if (pick.category === "vencedor") return "Mercado mais direto em e-sports: vencedor da partida, sem handicap ou props.";
  return "Total de mapas claro, evitando kills, rounds e mapas individuais.";
}

async function collectEsportsPicks(date: string) {
  const key = providerKey();
  const allowedDates = new Set(searchedDatesFor(date));
  const errors: string[] = [];

  const events = (await loadEventsForSport(key, "esports", date, ESPORTS_CANDIDATE_LIMIT))
    .filter(isPregameOrLive)
    .filter((event) => isAllowedLocalDate(event, allowedDates))
    .sort((a, b) => eventStart(a).localeCompare(eventStart(b)));
  const bookmakers = await loadSelectedBookmakers(key, BOOKMAKER_FALLBACK);
  const { odds, oddsRequests } = await loadOddsForEvents(key, events.map(eventId).slice(0, 20), bookmakers, 2);

  const fixturesWithPicks = odds
    .map((event) => ({ event, picks: collectPicksFromEvent(event) }))
    .filter((item) => item.picks.length)
    .sort((a, b) => (b.picks[0]?.score || 0) - (a.picks[0]?.score || 0))
    .slice(0, ESPORTS_GAME_LIMIT);

  return {
    sportsFound: 1,
    gamesFound: events.length,
    dateEligibleFound: events.length,
    oddsRequests: 2 + oddsRequests,
    errors,
    fixtures: fixturesWithPicks.map((item) => item.event),
    picks: fixturesWithPicks.flatMap((item) => item.picks).sort((a, b) => b.score - a.score),
    bookmakers,
  };
}

function chooseTicketSelections(picks: EsportsPick[], maxSelections: number, mode: "conservative" | "balanced" | "bold") {
  const ranges = {
    conservative: { min: 1.18, max: 1.68, limit: Math.min(2, maxSelections) },
    balanced: { min: 1.22, max: 1.95, limit: Math.min(3, maxSelections) },
    bold: { min: 1.35, max: 2.35, limit: Math.min(4, maxSelections) },
  };
  const range = ranges[mode];
  const chosen: EsportsPick[] = [];
  const usedEvents = new Set<string>();

  for (const pick of picks.filter((item) => item.odd >= range.min && item.odd <= range.max).sort((a, b) => b.score - a.score)) {
    if (chosen.length >= range.limit) break;
    if (usedEvents.has(pick.fixtureId)) continue;
    chosen.push(pick);
    usedEvents.add(pick.fixtureId);
  }

  return chosen;
}

function buildTicket(picks: EsportsPick[], maxSelections: number, stake: number, mode: "conservative" | "balanced" | "bold") {
  const selections = chooseTicketSelections(picks, maxSelections, mode);
  if (!selections.length) return { selections: [] };
  const totalOdd = selections.reduce((total, selection) => total * selection.odd, 1);
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason: mode === "conservative"
      ? "Bilhete curto com mercados principais e odds de maior probabilidade."
      : mode === "balanced"
        ? "Melhor equilibrio entre probabilidade, retorno e clareza dos mercados."
        : "Retorno maior usando somente um mercado simples por evento.",
  };
}

function deterministicAnalysis(fixtures: any[], picks: EsportsPick[], stake: number, maxSelections: number, date: string) {
  const topPicksByEvent = new Map<string, EsportsPick[]>();
  for (const pick of picks) {
    const list = topPicksByEvent.get(pick.fixtureId) || [];
    list.push(pick);
    topPicksByEvent.set(pick.fixtureId, list);
  }

  return {
    summary: picks.length
      ? `Palpites de e-sports gerados para ${date}. Usei ${ODDS_API_IO_PROVIDER} e mercados simples: vencedor da partida e total de mapas.`
      : "Nao achei odds aproveitaveis em e-sports nos mercados simples. O painel ficou vazio de proposito para nao trazer mercados ruins.",
    gameByGame: fixtures.map((fixture) => {
      const eventPicks = (topPicksByEvent.get(eventId(fixture)) || []).slice(0, 3);
      const best = eventPicks[0];
      return {
        game: eventName(fixture),
        apiGame: eventName(fixture),
        league: `${displaySportName(fixture)} | ${eventLeague(fixture)}`,
        startsAt: eventStart(fixture),
        bestMarket: best?.market || "",
        reason: best
          ? `${best.selection} foi a melhor entrada encontrada. ${best.reason || ""}`
          : "Evento encontrado, mas sem vencedor/total de mapas dentro dos filtros.",
        risk: best?.odd && best.odd >= 2 ? "alto" : "medio",
        picks: eventPicks,
      };
    }),
    traps: [],
    conservativeTicket: buildTicket(picks, maxSelections, stake, "conservative"),
    balancedTicket: buildTicket(picks, maxSelections, stake, "balanced"),
    boldTicket: buildTicket(picks, maxSelections, stake, "bold"),
    mainRecommendation: buildTicket(picks, maxSelections, stake, "balanced"),
  };
}

async function computeReport(date: string, stake: number, maxSelections: number): Promise<EsportsReport> {
  const collected = await collectEsportsPicks(date);
  const selectionLimit = Math.max(1, Math.min(ESPORTS_GAME_LIMIT, maxSelections));
  const analysis = deterministicAnalysis(collected.fixtures, collected.picks, stake, selectionLimit, date);

  return {
    source: {
      provider: `${ODDS_API_IO_PROVIDER} + Palpites E-sports`,
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "On-demand",
      sportsFound: collected.sportsFound,
      gamesFound: collected.gamesFound,
      searchedDates: searchedDatesFor(date),
      searchMode: "hoje + proximos 2 dias",
      gameLimit: ESPORTS_GAME_LIMIT,
      candidateLimit: ESPORTS_CANDIDATE_LIMIT,
      dateEligibleFound: collected.dateEligibleFound,
      oddsRequests: collected.oddsRequests,
      gamesAnalyzed: collected.fixtures.length,
      matched: collected.fixtures.length,
      picksFound: collected.picks.length,
      bookmakerFilter: collected.bookmakers.join(", "),
      errors: collected.errors.slice(0, 4),
    },
    analysis,
    raw: {
      fixtures: collected.fixtures,
      picks: collected.picks,
    },
  };
}

function reportStore() {
  return getStore({ name: "daily-esports-picks", consistency: "strong" });
}

function isUsableReport(report: EsportsReport | null) {
  const picks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  return Boolean(
    report?.source?.picksFound &&
    report.source.picksFound > 0 &&
    String(report.source.provider || "").includes(ODDS_API_IO_PROVIDER) &&
    picks.length &&
    picks.every((pick) => pick.bookmaker && !isUnsupportedMarket(`${pick.market} ${pick.selection}`))
  );
}

async function readCachedReport(date: string) {
  try {
    const report = await reportStore().get(`reports/${date}.json`, { type: "json" }) as EsportsReport | null;
    return isUsableReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveReport(report: EsportsReport) {
  if (!isUsableReport(report)) return;

  try {
    const store = reportStore();
    await store.setJSON(`reports/${report.source.date}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // O retorno continua util mesmo se o cache local/Blobs falhar.
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(1, Math.min(ESPORTS_GAME_LIMIT, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  if (!providerKey()) {
    return json({
      error: "Chave Odds-API.io ausente",
      setup: [
        "Configure ODDS_API_IO_KEY no Netlify.",
        "Se quiser separar e-sports, pode usar ESPORTS_ODDS_API_KEY.",
        "Depois publique novamente o site para a Function receber a variavel.",
      ],
    }, { status: 501 });
  }

  if (!refresh) {
    const cached = await readCachedReport(date);
    if (cached) return json({ ...cached, source: { ...cached.source, cached: true } });
  }

  try {
    const report = await computeReport(date, stake, maxSelections);
    await saveReport(report);
    return json(report);
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "Nao consegui gerar os palpites de E-sports");
    return json({
      ...friendly.body,
      setup: [
        "Confira se ODDS_API_IO_KEY esta configurada no Netlify.",
        "Confirme no painel da Odds-API.io se e-sports e suas casas selecionadas estao liberados.",
        "Se receber 429, aguarde a janela de limite reiniciar.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
};

export const config = {
  path: "/api/daily-esports-picks",
  method: ["GET", "POST"],
};
