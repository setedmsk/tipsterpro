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
const TENNIS_GAME_LIMIT = 5;
const TENNIS_CANDIDATE_LIMIT = 24;
const BOOKMAKER_FALLBACK = ["Bet365", "Pinnacle", "Unibet", "Betfair", "1xBet", "Stake"];
const KEY_NAMES = ["TENNIS_ODDS_API_KEY"];

type TennisCategory = "vencedor" | "total_games" | "primeiro_set";

type TennisPick = {
  fixtureId: string;
  sport: string;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: TennisCategory;
  selection: string;
  odd: number;
  bookmaker: string;
  impliedProbability: number;
  score: number;
  reason?: string;
};

type TennisReport = {
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
    picks: TennisPick[];
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

function validHalfLine(line: number) {
  const fraction = Math.abs(line % 1);
  return Math.abs(fraction - 0.5) < 0.001 || fraction < 0.001;
}

function isFirstSetMarket(name: string) {
  const text = normalizeText(name);
  return (
    text.includes("1st set") ||
    text.includes("first set") ||
    text.includes("set 1") ||
    text.includes("1 set")
  );
}

function isUnsupportedMarket(name: string) {
  const text = normalizeText(name);
  if (isFirstSetMarket(name) && (text.includes("winner") || text.includes("ml") || text.includes("moneyline"))) return false;
  return [
    "handicap",
    "spread",
    "asian",
    "correct score",
    "exact score",
    "set betting",
    "game handicap",
    "player",
    "aces",
    "double fault",
    "break point",
    "tie break",
    "tiebreak",
    "race to",
    "odd even",
    "retirement",
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
  picks: Map<string, TennisPick>,
  event: any,
  bookmaker: string,
  category: TennisCategory,
  market: string,
  selection: string,
  oddValue: unknown,
) {
  const odd = parseOdd(oddValue);
  if (!Number.isFinite(odd) || odd < 1.15 || odd > 2.35) return;

  const fixtureId = eventId(event);
  const pick: TennisPick = {
    fixtureId,
    sport: "Tenis",
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
  const picks = new Map<string, TennisPick>();
  const home = String(event?.home || "Jogador 1");
  const away = String(event?.away || "Jogador 2");

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

        if (isFirstSetMarket(marketName) && (marketText.includes("winner") || marketText.includes("ml") || marketText.includes("moneyline"))) {
          addPick(picks, event, bookmaker, "primeiro_set", "Vencedor do 1o set", home, row.home);
          addPick(picks, event, bookmaker, "primeiro_set", "Vencedor do 1o set", away, row.away);
          continue;
        }

        if (marketText.includes("total")) {
          const line = Number(row.hdp ?? row.line ?? row.total);
          if (!Number.isFinite(line) || line < 16.5 || line > 30.5 || !validHalfLine(line)) continue;
          addPick(picks, event, bookmaker, "total_games", "Total de games - Mais/Menos", `Mais de ${line.toFixed(1)} games`, row.over);
          addPick(picks, event, bookmaker, "total_games", "Total de games - Mais/Menos", `Menos de ${line.toFixed(1)} games`, row.under);
        }
      }
    }
  }

  return [...picks.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function pickScore(pick: Pick<TennisPick, "odd" | "category" | "bookmaker" | "league">) {
  const base = pick.category === "vencedor" ? 56 : pick.category === "primeiro_set" ? 46 : 43;
  const target = pick.category === "vencedor" ? 1.55 : pick.category === "primeiro_set" ? 1.62 : 1.72;
  const league = normalizeText(pick.league || "");
  const leagueBoost = league.includes("atp") || league.includes("wta") ? 8 : league.includes("challenger") ? 4 : league.includes("itf") ? -3 : 0;
  const oddPenalty = Math.abs(pick.odd - target) * 8;
  const lowPenalty = pick.odd < 1.18 ? 10 : 0;
  const highPenalty = pick.odd > 2.25 ? (pick.odd - 2.25) * 12 : 0;
  return base + leagueBoost + bookmakerPriority(pick.bookmaker) * 0.35 - oddPenalty - lowPenalty - highPenalty;
}

function reasonForPick(pick: TennisPick) {
  if (pick.category === "vencedor") return "Mercado direto de tenis: vencedor da partida, sem handicap.";
  if (pick.category === "primeiro_set") return "Vencedor do 1o set, mercado simples quando a odd compensa.";
  return "Total de games em linha comum, evitando handicap e placar exato.";
}

async function collectTennisPicks(date: string) {
  const key = providerKey();
  const allowedDates = new Set(searchedDatesFor(date));
  const errors: string[] = [];

  const events = (await loadEventsForSport(key, "tennis", date, TENNIS_CANDIDATE_LIMIT))
    .filter(isPregameOrLive)
    .filter((event) => isAllowedLocalDate(event, allowedDates))
    .sort((a, b) => eventStart(a).localeCompare(eventStart(b)));
  const bookmakers = await loadSelectedBookmakers(key, BOOKMAKER_FALLBACK);
  const { odds, oddsRequests } = await loadOddsForEvents(key, events.map(eventId).slice(0, 20), bookmakers, 2);

  const fixturesWithPicks = odds
    .map((event) => ({ event, picks: collectPicksFromEvent(event) }))
    .filter((item) => item.picks.length)
    .sort((a, b) => (b.picks[0]?.score || 0) - (a.picks[0]?.score || 0))
    .slice(0, TENNIS_GAME_LIMIT);

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

function chooseTicketSelections(picks: TennisPick[], maxSelections: number, mode: "conservative" | "balanced" | "bold") {
  const ranges = {
    conservative: { min: 1.18, max: 1.68, limit: Math.min(2, maxSelections) },
    balanced: { min: 1.22, max: 1.95, limit: Math.min(3, maxSelections) },
    bold: { min: 1.35, max: 2.25, limit: Math.min(4, maxSelections) },
  };
  const range = ranges[mode];
  const chosen: TennisPick[] = [];
  const usedEvents = new Set<string>();

  for (const pick of picks.filter((item) => item.odd >= range.min && item.odd <= range.max).sort((a, b) => b.score - a.score)) {
    if (chosen.length >= range.limit) break;
    if (usedEvents.has(pick.fixtureId)) continue;
    chosen.push(pick);
    usedEvents.add(pick.fixtureId);
  }

  return chosen;
}

function buildTicket(picks: TennisPick[], maxSelections: number, stake: number, mode: "conservative" | "balanced" | "bold") {
  const selections = chooseTicketSelections(picks, maxSelections, mode);
  if (!selections.length) return { selections: [] };
  const totalOdd = selections.reduce((total, selection) => total * selection.odd, 1);
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason: mode === "conservative"
      ? "Bilhete curto com mercados mais diretos de tenis."
      : mode === "balanced"
        ? "Melhor equilibrio entre vencedor, total de games e odd."
        : "Retorno maior sem usar handicap ou placar exato.",
  };
}

function deterministicAnalysis(fixtures: any[], picks: TennisPick[], stake: number, maxSelections: number, date: string) {
  const topPicksByEvent = new Map<string, TennisPick[]>();
  for (const pick of picks) {
    const list = topPicksByEvent.get(pick.fixtureId) || [];
    list.push(pick);
    topPicksByEvent.set(pick.fixtureId, list);
  }

  return {
    summary: picks.length
      ? `Palpites de tenis gerados para ${date}. Usei ${ODDS_API_IO_PROVIDER} e mercados simples: vencedor da partida, total de games e vencedor do 1o set. Handicap ficou fora.`
      : "Nao achei odds aproveitaveis em tenis nos mercados simples. O painel ficou vazio de proposito para nao trazer mercados ruins.",
    gameByGame: fixtures.map((fixture) => {
      const eventPicks = (topPicksByEvent.get(eventId(fixture)) || []).slice(0, 3);
      const best = eventPicks[0];
      return {
        game: eventName(fixture),
        apiGame: eventName(fixture),
        league: eventLeague(fixture),
        startsAt: eventStart(fixture),
        bestMarket: best?.market || "",
        reason: best
          ? `${best.selection} foi a melhor entrada encontrada. ${best.reason || ""}`
          : "Evento encontrado, mas sem vencedor/total de games/1o set dentro dos filtros.",
        risk: best?.odd && best.odd >= 1.9 ? "alto" : "medio",
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

async function computeReport(date: string, stake: number, maxSelections: number): Promise<TennisReport> {
  const collected = await collectTennisPicks(date);
  const selectionLimit = Math.max(1, Math.min(TENNIS_GAME_LIMIT, maxSelections));
  const analysis = deterministicAnalysis(collected.fixtures, collected.picks, stake, selectionLimit, date);

  return {
    source: {
      provider: `${ODDS_API_IO_PROVIDER} + Palpites Tenis`,
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "On-demand",
      sportsFound: collected.sportsFound,
      gamesFound: collected.gamesFound,
      searchedDates: searchedDatesFor(date),
      searchMode: "hoje + proximos 2 dias",
      gameLimit: TENNIS_GAME_LIMIT,
      candidateLimit: TENNIS_CANDIDATE_LIMIT,
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
  return getStore({ name: "daily-tennis-picks", consistency: "strong" });
}

function isUsableReport(report: TennisReport | null) {
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
    const report = await reportStore().get(`reports/${date}.json`, { type: "json" }) as TennisReport | null;
    return isUsableReport(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveReport(report: TennisReport) {
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
  const maxSelections = Math.max(1, Math.min(TENNIS_GAME_LIMIT, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  if (!providerKey()) {
    return json({
      error: "Chave Odds-API.io ausente",
      setup: [
        "Configure ODDS_API_IO_KEY no Netlify.",
        "Se quiser separar tenis, pode usar TENNIS_ODDS_API_KEY.",
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
    const friendly = friendlyErrorPayload(error, "Nao consegui gerar os palpites de Tenis");
    return json({
      ...friendly.body,
      setup: [
        "Confira se ODDS_API_IO_KEY esta configurada no Netlify.",
        "Confirme no painel da Odds-API.io se tenis e suas casas selecionadas estao liberados.",
        "Se receber 429, aguarde a janela de limite reiniciar.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
};

export const config = {
  path: "/api/daily-tennis-picks",
  method: ["GET", "POST"],
};
