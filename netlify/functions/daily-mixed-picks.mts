import { fetchWithTimeout } from "./_shared/http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_STAKE = 5;
const DEFAULT_MAX_SELECTIONS = 7;

type MixedPick = {
  fixtureId: string;
  sport: string;
  game: string;
  league: string;
  startsAt: string;
  market: string;
  category: string;
  selection: string;
  odd: number;
  bookmaker?: string;
  impliedProbability: number;
  score: number;
  reason?: string;
  sourceProvider?: string;
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

function todayInSaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function product(items: number[]) {
  return items.reduce((total, item) => total * item, 1);
}

function sportFromProvider(provider: string) {
  const normalized = normalizeText(provider);
  if (normalized.includes("basket")) return "Basquete";
  if (normalized.includes("volley") || normalized.includes("volei")) return "Volei";
  if (normalized.includes("tennis") || normalized.includes("tenis") || normalized.includes("atp") || normalized.includes("wta")) return "Tenis";
  if (normalized.includes("e sports") || normalized.includes("esports") || normalized.includes("odds api io")) return "E-sports";
  return "Futebol";
}

function pickSportKey(pick: MixedPick) {
  return normalizeText(pick.sport || "futebol");
}

function pickEventKey(pick: MixedPick) {
  return `${pickSportKey(pick)}:${pick.fixtureId || normalizeText(pick.game)}`;
}

function extractLine(value: string) {
  const match = String(value || "").match(/(^|[^\d])(\d+(?:[,.]\d+)?)([^\d]|$)/);
  if (!match) return null;
  const line = Number(match[2].replace(",", "."));
  return Number.isFinite(line) ? line : null;
}

function hasInvalidVolleyballTotalLine(pick: MixedPick) {
  const sport = pickSportKey(pick);
  if (sport !== "volei" && sport !== "volleyball") return false;
  const text = normalizeText(`${pick.market} ${pick.selection} ${pick.category}`);
  const looksLikeTotal = text.includes("mais menos") || text.includes("over under") || text.includes("total");
  if (!looksLikeTotal) return false;
  const line = extractLine(`${pick.selection} ${pick.market}`);
  return line !== null && line < 15;
}

function isUnsupportedMixedPick(pick: MixedPick) {
  const text = normalizeText(`${pick.market} ${pick.selection} ${pick.category}`);
  if (hasInvalidVolleyballTotalLine(pick)) return true;
  return [
    "handicap",
    "spread",
    "asian",
    "total sets",
    "sets total",
    "number of sets",
    "tackles",
    "desarmes",
    "correct score",
    "exact score",
    "player",
    "race to",
    "odd even",
    "round",
    "kill",
    "kills",
    "map handicap",
    "team total",
    "home total",
    "away total",
  ].some((fragment) => text.includes(fragment));
}

function categoryBoost(category: string, market: string) {
  const text = normalizeText(`${category} ${market}`);
  if (text.includes("dupla") || text.includes("double chance")) return 7;
  if (text.includes("vencedor") || text.includes("resultado final") || text.includes("winner")) return 6;
  if (text.includes("pontos") || text.includes("points")) return 5;
  if (text.includes("games")) return 5;
  if (text.includes("set")) return 4;
  if (text.includes("gols") || text.includes("goals")) return 5;
  if (text.includes("ambas")) return 4;
  if (text.includes("mapas")) return 4;
  if (text.includes("escanteio") || text.includes("cart")) return 2;
  return 0;
}

function mixedScore(pick: MixedPick, targetOdd = 1.55) {
  const sourceScore = Number(pick.score || 0);
  const normalizedSourceScore = Math.max(0, Math.min(65, sourceScore));
  const oddDistancePenalty = Math.abs(pick.odd - targetOdd) * 9;
  const tooLowPenalty = pick.odd < 1.15 ? 12 : 0;
  const tooHighPenalty = pick.odd > 1.9 ? (pick.odd - 1.9) * 18 : 0;
  return normalizedSourceScore + categoryBoost(pick.category, pick.market) - oddDistancePenalty - tooLowPenalty - tooHighPenalty;
}

function normalizePick(raw: any, provider: string): MixedPick | null {
  if (!raw || typeof raw !== "object") return null;
  const odd = Number(raw.odd);
  if (!Number.isFinite(odd) || odd < 1.1 || odd > 2.05) return null;

  const pick: MixedPick = {
    fixtureId: String(raw.fixtureId || raw.fixture_id || raw.id || raw.game || ""),
    sport: raw.sport ? String(raw.sport) : sportFromProvider(provider),
    game: String(raw.game || raw.apiGame || raw.fixture || raw.match || "Jogo nao identificado"),
    league: String(raw.league || raw.competition || "Competicao nao informada"),
    startsAt: String(raw.startsAt || raw.date || ""),
    market: String(raw.market || raw.category || "Mercado"),
    category: String(raw.category || raw.market || "outros"),
    selection: String(raw.selection || raw.pick || raw.value || "--"),
    odd,
    bookmaker: raw.bookmaker || raw.book || raw.sportsbook || "",
    impliedProbability: Number(raw.impliedProbability || (100 / odd).toFixed(2)),
    score: Number(raw.score || 0),
    reason: raw.reason || "",
    sourceProvider: provider,
  };

  if (isUnsupportedMixedPick(pick)) return null;
  return pick;
}

function collectReportPicks(report: any) {
  const provider = String(report?.source?.provider || "Fonte");
  const rawPicks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  const ticketPicks = [
    report?.analysis?.mainRecommendation,
    report?.analysis?.balancedTicket,
    report?.analysis?.conservativeTicket,
    report?.analysis?.boldTicket,
  ].flatMap((ticket) => {
    if (!ticket) return [];
    if (Array.isArray(ticket)) return ticket;
    if (Array.isArray(ticket.selections)) return ticket.selections;
    if (Array.isArray(ticket.picks)) return ticket.picks;
    return [];
  });

  const picks = [...ticketPicks, ...rawPicks]
    .map((pick) => normalizePick(pick, provider))
    .filter((pick): pick is MixedPick => Boolean(pick));
  const byKey = new Map<string, MixedPick>();
  for (const pick of picks) {
    const key = normalizeText(`${pickEventKey(pick)}|${pick.market}|${pick.selection}`);
    const current = byKey.get(key);
    if (!current || mixedScore(pick) > mixedScore(current) || (mixedScore(pick) === mixedScore(current) && pick.odd > current.odd)) {
      byKey.set(key, pick);
    }
  }
  return [...byKey.values()];
}

async function fetchJson(req: Request, path: string, params: URLSearchParams) {
  const url = new URL(path, new URL(req.url).origin);
  params.forEach((value, key) => url.searchParams.append(key, value));
  const response = await fetchWithTimeout(url, {}, 12000, "Mix do dia");
  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

async function loadSources(req: Request, date: string, stake: number, refresh: boolean) {
  const baseParams = new URLSearchParams({
    date,
    stake: String(stake),
    maxSelections: "5",
  });
  if (refresh) baseParams.set("refresh", "1");

  const footballParams = new URLSearchParams(baseParams);
  footballParams.set("markets", "mais/menos gols,ambas marcam,dupla chance,resultado final");

  const sources = [
    { key: "football", label: "Futebol", path: "/api/daily-picks", params: footballParams },
    { key: "basketball", label: "Basquete", path: "/api/daily-basketball-picks", params: new URLSearchParams(baseParams) },
    { key: "volleyball", label: "Volei", path: "/api/daily-volleyball-picks", params: new URLSearchParams(baseParams) },
    { key: "tennis", label: "Tenis", path: "/api/daily-tennis-picks", params: new URLSearchParams(baseParams) },
    { key: "esports", label: "E-sports", path: "/api/daily-esports-picks", params: new URLSearchParams(baseParams) },
  ];

  const results = await Promise.all(sources.map(async (source) => {
    try {
      const result = await fetchJson(req, source.path, source.params);
      return { source, ...result };
    } catch (error: any) {
      return {
        source,
        ok: false,
        status: 0,
        data: { error: "Falha ao chamar fonte", detail: error?.message || String(error || "") },
      };
    }
  }));

  return results;
}

function chooseMixedSelections(picks: MixedPick[], maxSelections: number, targetOdd: number) {
  const sportLimits: Record<string, number> = {
    futebol: 3,
    basquete: 2,
    volei: 2,
    volleyball: 2,
    tenis: 1,
    tennis: 1,
    "e sports": 1,
    esports: 1,
  };
  const selected: MixedPick[] = [];
  const usedEvents = new Set<string>();
  const sportCounts = new Map<string, number>();

  const ranked = picks
    .filter((pick) => pick.odd >= 1.12 && pick.odd <= 1.9)
    .sort((a, b) => mixedScore(b, targetOdd) - mixedScore(a, targetOdd));

  const availableSports = [...new Set(ranked.map(pickSportKey))];
  for (const sport of availableSports) {
    if (selected.length >= maxSelections) break;
    const pick = ranked.find((item) => pickSportKey(item) === sport && !usedEvents.has(pickEventKey(item)));
    if (!pick) continue;
    selected.push(pick);
    usedEvents.add(pickEventKey(pick));
    sportCounts.set(sport, (sportCounts.get(sport) || 0) + 1);
  }

  for (const pick of ranked) {
    if (selected.length >= maxSelections) break;
    const eventKey = pickEventKey(pick);
    if (usedEvents.has(eventKey)) continue;
    const sport = pickSportKey(pick);
    const limit = sportLimits[sport] || 2;
    if ((sportCounts.get(sport) || 0) >= limit) continue;
    selected.push(pick);
    usedEvents.add(eventKey);
    sportCounts.set(sport, (sportCounts.get(sport) || 0) + 1);
  }

  return selected;
}

function buildTicket(selections: MixedPick[], stake: number, reason: string) {
  if (!selections.length) return { selections: [] };
  const totalOdd = product(selections.map((pick) => pick.odd));
  return {
    selections,
    totalOdd: Number(totalOdd.toFixed(2)),
    possibleReturn: Number((totalOdd * stake).toFixed(2)),
    reason,
  };
}

function buildGameByGame(picks: MixedPick[]) {
  const uniqueByEvent = new Map<string, MixedPick>();
  for (const pick of picks) {
    const key = pickEventKey(pick);
    if (!uniqueByEvent.has(key)) uniqueByEvent.set(key, pick);
    if (uniqueByEvent.size >= 12) break;
  }

  return [...uniqueByEvent.values()].map((pick) => ({
    game: pick.game,
    apiGame: pick.game,
    league: `${pick.sport} | ${pick.league}`,
    startsAt: pick.startsAt,
    bestMarket: pick.market,
    reason: `${pick.selection} foi selecionado para o mix. Odd ${pick.odd.toFixed(2)} com mercado simples.`,
    risk: pick.odd >= 1.75 ? "medio-alto" : "medio",
    picks: [pick],
  }));
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayInSaoPaulo();
  const stake = Number(url.searchParams.get("stake") || DEFAULT_STAKE);
  const maxSelections = Math.max(4, Math.min(7, Number(url.searchParams.get("maxSelections") || DEFAULT_MAX_SELECTIONS)));
  const refresh = url.searchParams.get("refresh") === "1" || req.method === "POST";

  const results = await loadSources(req, date, stake, refresh);
  const warnings = results
    .filter((result) => !result.ok)
    .map((result) => `${result.source.label}: ${result.data?.detail || result.data?.error || `HTTP ${result.status}`}`);
  const successfulReports = results.filter((result) => result.ok).map((result) => result.data);
  const picks = successfulReports.flatMap(collectReportPicks);

  if (!picks.length) {
    return json({
      error: "Nao encontrei selecoes suficientes para o Bingo do 7",
      detail: warnings.length ? warnings.join(" | ") : "As fontes responderam sem picks aproveitaveis.",
      setup: [
        "Tente futebol, basquete ou volei individual para ver qual fonte tem dados hoje.",
        "Se tenis/e-sports falhar com 429, a Odds-API.io atingiu o limite de requests.",
      ],
    }, { status: 502 });
  }

  const ranked = picks.sort((a, b) => mixedScore(b, 1.55) - mixedScore(a, 1.55));
  const conservativeSelections = chooseMixedSelections(ranked, Math.min(4, maxSelections), 1.38);
  const balancedSelections = chooseMixedSelections(ranked, Math.min(5, maxSelections), 1.52);
  const boldSelections = chooseMixedSelections(ranked, maxSelections, 1.65);
  const mainSelections = boldSelections.length >= 5 ? boldSelections : balancedSelections;
  const sportsUsed = [...new Set(mainSelections.map((pick) => pick.sport))];

  const analysis = {
    summary: `Mix multi-esporte de ${date}: combinei futebol, basquete, volei, tenis e e-sports quando disponiveis. O foco foi odd alta por soma de selecoes simples: vencedor, gols/pontos/games e dupla chance quando aparece.`,
    gameByGame: buildGameByGame(ranked),
    traps: warnings.map((warning) => ({
      game: "Fonte indisponivel",
      market: "API",
      selection: warning,
      odd: null,
      reason: warning.includes("429") || warning.includes("REQUEST_LIMIT")
        ? "Limite de requests da API atingido; deixei essa fonte fora do mix."
        : "Fonte ignorada para nao quebrar o bilhete mixado.",
    })),
    conservativeTicket: buildTicket(conservativeSelections, stake, "Mix curto com uma selecao forte por esporte disponivel."),
    balancedTicket: buildTicket(balancedSelections, stake, "Mix equilibrado com odd maior sem repetir evento."),
    boldTicket: buildTicket(boldSelections, stake, "Mix agressivo: 5 a 7 selecoes simples para buscar odd alta."),
    mainRecommendation: buildTicket(mainSelections, stake, "Minha sugestao para o mix: odd alta construida por mercados simples em esportes diferentes."),
  };

  return json({
    source: {
      provider: "Sete PRO Bingo do 7 multi-esporte",
      date,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      schedule: "Sob demanda",
      searchMode: "futebol + basquete + volei + tenis + e-sports",
      gameLimit: maxSelections,
      candidateLimit: picks.length,
      gamesAnalyzed: new Set(picks.map(pickEventKey)).size,
      matched: mainSelections.length,
      picksFound: picks.length,
      sportsUsed,
      warnings,
      oddsRequests: successfulReports.reduce((sum: number, report: any) => sum + Number(report?.source?.oddsRequests || 0), 0),
    },
    analysis,
    raw: {
      fixtures: [],
      picks: ranked,
    },
  });
};

export const config = {
  path: "/api/daily-mixed-picks",
  method: ["GET", "POST"],
};
