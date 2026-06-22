import { getStore } from "@netlify/blobs";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const REPORT_CACHE_VERSION = "manual-br-v1";

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    status?: { long?: string; short?: string; elapsed?: number | null };
  };
  league?: {
    name?: string;
    country?: string;
  };
  teams: {
    home: { id: number; name: string };
    away: { id: number; name: string };
  };
  goals?: {
    home: number | null;
    away: number | null;
  };
};

type PickStatus = "won" | "lost" | "pending" | "void" | "review";

type PickLike = {
  fixtureId?: number;
  fixture_id?: number;
  game?: string;
  market?: string;
  category?: string;
  selection?: string;
  pick?: string;
  value?: string;
  odd?: number | string;
  bookmaker?: string;
  league?: string;
  startsAt?: string;
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

function addDays(date: string, days: number) {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function isDateValue(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function apiFootball(path: string, params: Record<string, string | number | undefined>) {
  const key = getEnv("API_FOOTBALL_KEY");
  if (!key) throw new Error("API_FOOTBALL_KEY ausente");

  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  });

  const response = await fetch(url, {
    headers: {
      "x-apisports-key": key,
    },
  });

  if (!response.ok) throw new Error(`API-Football retornou ${response.status} em ${path}`);

  const data = await response.json();
  const apiErrors = data.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (apiErrors.length) throw new Error(`API-Football: ${apiErrors.join(" | ")}`);
  return data.response || [];
}

function dailyStore() {
  return getStore({ name: "daily-picks", consistency: "strong" });
}

function settlementStore() {
  return getStore({ name: "settled-picks", consistency: "strong" });
}

function isUsefulSettlement(report: any) {
  const items = Array.isArray(report?.items) ? report.items : [];
  return Boolean(report?.source?.date && items.length);
}

async function readCachedSettlement(date: string) {
  try {
    const report = await settlementStore().get(`reports/${date}.json`, { type: "json" });
    return isUsefulSettlement(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveSettlement(report: any) {
  if (!isUsefulSettlement(report)) return;
  const items = Array.isArray(report.items) ? report.items : [];
  const hasClosedPick = items.some((item: any) => ["won", "lost", "void"].includes(String(item?.status || "")));
  if (!hasClosedPick) return;

  try {
    const store = settlementStore();
    await store.setJSON(`reports/${report.source.date}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // The report can still be returned even when Blob persistence is unavailable.
  }
}

async function readReportsForDate(date: string) {
  const store = dailyStore();
  const reports: any[] = [];
  const seen = new Set<string>();
  const prefix = `reports/${REPORT_CACHE_VERSION}/${date}/`;

  try {
    const listed = await store.list({ prefix });
    for (const blob of listed.blobs || []) {
      const key = blob.key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const report = await store.get(key, { type: "json" });
      if (report) reports.push(report);
    }
  } catch {
    // Local/dev stores may not support listing; latest.json below is the fallback.
  }

  try {
    const latest = await store.get("latest.json", { type: "json" }) as any;
    if (latest?.source?.date === date && !seen.has("latest.json")) {
      reports.push(latest);
    }
  } catch {
    // No cached report yet.
  }

  return reports.filter((report) => {
    return report?.source?.date === date && Array.isArray(report?.raw?.picks);
  });
}

async function listReportDates() {
  const store = dailyStore();
  const dates = new Set<string>();
  const prefix = `reports/${REPORT_CACHE_VERSION}/`;

  try {
    const listed = await store.list({ prefix });
    for (const blob of listed.blobs || []) {
      const match = String(blob.key || "").match(/^reports\/[^/]+\/(\d{4}-\d{2}-\d{2})\//);
      if (match) dates.add(match[1]);
    }
  } catch {
    // Listing can be unavailable in local/dev stores; latest.json below is the fallback.
  }

  try {
    const latest = await store.get("latest.json", { type: "json" }) as any;
    if (latest?.source?.date) dates.add(String(latest.source.date));
  } catch {
    // No latest report yet.
  }

  try {
    const settlements = await settlementStore().list({ prefix: "reports/" });
    for (const blob of settlements.blobs || []) {
      const match = String(blob.key || "").match(/^reports\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (match) dates.add(match[1]);
    }
  } catch {
    // Settlement cache is optional.
  }

  return [...dates].sort().reverse();
}

async function resolveReportDate(requestedDate: string | null) {
  const requested = String(requestedDate || "").trim().toLowerCase();
  if (isDateValue(requested)) return requested;

  const today = todayInSaoPaulo();
  const yesterday = addDays(today, -1);
  const dates = await listReportDates();

  if (dates.includes(yesterday)) return yesterday;
  if (dates.includes(today)) return today;
  return dates[0] || yesterday;
}

function ticketSelections(ticket: any) {
  if (!ticket) return [];
  if (Array.isArray(ticket)) return ticket.filter(Boolean);
  if (Array.isArray(ticket.selections)) return ticket.selections.filter(Boolean);
  if (Array.isArray(ticket.picks)) return ticket.picks.filter(Boolean);
  return [];
}

function selectionFixtureId(selection: PickLike) {
  return Number(selection.fixtureId || selection.fixture_id || 0);
}

function selectionText(selection: PickLike) {
  return String(selection.selection || selection.pick || selection.value || "");
}

function pickSignature(selection: PickLike) {
  return [
    selectionFixtureId(selection),
    normalizeText(String(selection.market || selection.category || "")),
    normalizeText(selectionText(selection)),
    Number(selection.odd || 0).toFixed(2),
  ].join("|");
}

function categoryFor(selection: PickLike) {
  const normalized = normalizeText(`${selection.market || ""} ${selection.category || ""} ${selectionText(selection)}`);
  if (isPeriodMarket(selection)) return "periodo";
  if (normalized.includes("tackle") || normalized.includes("tackles") || normalized.includes("desarme") || normalized.includes("desarmes")) return "desarmes";
  if (normalized.includes("dupla") || normalized.includes("double chance")) return "dupla_chance";
  if (normalized.includes("ambas") || normalized.includes("btts") || normalized.includes("both teams")) return "ambas_marcam";
  if (normalized.includes("escanteio") || normalized.includes("canto") || normalized.includes("corner")) return "escanteios";
  if (normalized.includes("cartao") || normalized.includes("cartoes") || normalized.includes("card") || normalized.includes("booking")) return "cartoes";
  if (normalized.includes("chute") || normalized.includes("finalizacao") || normalized.includes("shot")) return "chutes_gol";
  if (normalized.includes("gol") || normalized.includes("gols") || normalized.includes("goal") || normalized.includes("mais") || normalized.includes("menos") || normalized.includes("over") || normalized.includes("under") || normalized.includes("total")) return "mais_menos_gols";
  if (normalized.includes("resultado") || normalized.includes("vitoria") || normalized.includes("vence") || normalized.includes("winner") || normalized.includes("1x2")) return "resultado_final";
  return "outros";
}

function findRawPick(selection: PickLike, rawPicks: PickLike[]) {
  const fixtureId = selectionFixtureId(selection);
  const market = normalizeText(String(selection.market || selection.category || ""));
  const pick = normalizeText(selectionText(selection));
  const odd = Number(selection.odd || 0);

  let best: { pick: PickLike; score: number } | null = null;
  for (const raw of rawPicks) {
    let score = 0;
    if (fixtureId && selectionFixtureId(raw) === fixtureId) score += 8;
    if (market && normalizeText(String(raw.market || raw.category || "")).includes(market)) score += 3;
    const rawSelection = normalizeText(selectionText(raw));
    if (pick && (rawSelection.includes(pick) || pick.includes(rawSelection))) score += 4;
    const rawOdd = Number(raw.odd || 0);
    if (Number.isFinite(odd) && Math.abs(rawOdd - odd) <= 0.03) score += 2;
    if (!best || score > best.score) best = { pick: raw, score };
  }

  return best && best.score >= 7 ? best.pick : null;
}

function collectReportSelections(report: any) {
  const rawPicks = Array.isArray(report?.raw?.picks) ? report.raw.picks : [];
  const analysis = report?.analysis || {};
  const tickets = [
    { name: "Principal", ticket: analysis.mainRecommendation },
    { name: "Conservador", ticket: analysis.conservativeTicket },
    { name: "Equilibrado", ticket: analysis.balancedTicket || analysis.recommendedTicket },
    { name: "Ousado", ticket: analysis.boldTicket },
  ];
  const selections: Array<PickLike & { ticketName?: string; sourceLabel?: string }> = [];

  for (const item of tickets) {
    for (const selection of ticketSelections(item.ticket)) {
      const raw = findRawPick(selection, rawPicks);
      selections.push({
        ...(raw || {}),
        ...selection,
        fixtureId: selectionFixtureId(selection) || selectionFixtureId(raw || {}),
        ticketName: item.name,
        sourceLabel: report?.source?.scopeLabel || "Palpites do dia",
      });
    }
  }

  if (!selections.length) {
    for (const pick of rawPicks) {
      selections.push({
        ...pick,
        ticketName: "Palpite",
        sourceLabel: report?.source?.scopeLabel || "Palpites do dia",
      });
    }
  }

  return selections;
}

function collectSelections(reports: any[]) {
  const byKey = new Map<string, PickLike & { ticketName?: string; sourceLabel?: string }>();
  for (const report of reports) {
    for (const selection of collectReportSelections(report)) {
      const key = pickSignature(selection);
      if (!key.startsWith("0|") && !byKey.has(key)) byKey.set(key, selection);
    }
  }
  return [...byKey.values()];
}

function fixtureIdFromFixture(fixture: ApiFootballFixture) {
  return Number(fixture?.fixture?.id || 0);
}

function collectStoredFixtures(reports: any[]) {
  const byId = new Map<number, ApiFootballFixture>();
  for (const report of reports) {
    const fixtures = Array.isArray(report?.raw?.fixtures) ? report.raw.fixtures : [];
    for (const fixture of fixtures) {
      const fixtureId = fixtureIdFromFixture(fixture);
      if (fixtureId && !byId.has(fixtureId)) byId.set(fixtureId, fixture);
    }
  }
  return byId;
}

function goalValue(fixture: ApiFootballFixture, side: "home" | "away") {
  const goals = fixture.goals?.[side];
  if (goals !== null && goals !== undefined) return Number(goals);
  const fulltime = (fixture as any)?.score?.fulltime?.[side];
  if (fulltime !== null && fulltime !== undefined) return Number(fulltime);
  return NaN;
}

function isFinished(fixture: ApiFootballFixture) {
  const status = fixture.fixture.status?.short || "";
  return ["FT", "AET", "PEN"].includes(status);
}

function isPending(fixture: ApiFootballFixture) {
  const home = goalValue(fixture, "home");
  const away = goalValue(fixture, "away");
  return !isFinished(fixture) || !Number.isFinite(home) || !Number.isFinite(away);
}

function parseLine(selection: PickLike) {
  const normalized = normalizeText(selectionText(selection));
  const original = selectionText(selection);
  const lineMatch = original.match(/(\d+(?:[,.]\d+)?)/);
  if (!lineMatch) return null;

  const line = Number(lineMatch[1].replace(",", "."));
  if (!Number.isFinite(line)) return null;

  if (normalized.includes("mais") || normalized.includes("over")) return { side: "over" as const, line };
  if (normalized.includes("menos") || normalized.includes("under")) return { side: "under" as const, line };
  return null;
}

function lineResult(value: number, line: { side: "over" | "under"; line: number }) {
  if (value === line.line) return "void";
  if (line.side === "over") return value > line.line ? "won" : "lost";
  return value < line.line ? "won" : "lost";
}

function scoreLabel(fixture: ApiFootballFixture) {
  const home = goalValue(fixture, "home");
  const away = goalValue(fixture, "away");
  return Number.isFinite(home) && Number.isFinite(away)
    ? `${home}-${away}`
    : fixture.fixture.status?.long || "Sem placar";
}

function resultSide(fixture: ApiFootballFixture) {
  const home = goalValue(fixture, "home");
  const away = goalValue(fixture, "away");
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function targetGoals(selection: PickLike, fixture: ApiFootballFixture) {
  const market = normalizeText(String(selection.market || ""));
  const pick = normalizeText(selectionText(selection));
  const home = normalizeText(fixture.teams.home.name);
  const away = normalizeText(fixture.teams.away.name);
  if (market.includes(home) || pick.includes(home)) return goalValue(fixture, "home");
  if (market.includes(away) || pick.includes(away)) return goalValue(fixture, "away");
  if (/\bhome\b/.test(market) || market.includes("mandante") || market.includes("casa")) return goalValue(fixture, "home");
  if (/\baway\b/.test(market) || market.includes("visitante") || market.includes("fora")) return goalValue(fixture, "away");
  return goalValue(fixture, "home") + goalValue(fixture, "away");
}

function evaluateGoals(selection: PickLike, fixture: ApiFootballFixture) {
  const line = parseLine(selection);
  if (!line) return { status: "review" as PickStatus, reason: "Linha de gols nao identificada automaticamente." };
  const value = targetGoals(selection, fixture);
  const status = lineResult(value, line) as PickStatus;
  return { status, reason: `Placar ${scoreLabel(fixture)}; base avaliada: ${value}.` };
}

function evaluateBothTeamsScore(selection: PickLike, fixture: ApiFootballFixture) {
  const both = goalValue(fixture, "home") > 0 && goalValue(fixture, "away") > 0;
  const pick = normalizeText(selectionText(selection));
  const wantsYes = pick.includes("sim") || pick.includes("yes");
  const wantsNo = pick.includes("nao") || pick.includes("no");
  if (!wantsYes && !wantsNo) {
    return { status: "review" as PickStatus, reason: "Nao identifiquei se a entrada era Sim ou Nao para ambas marcam." };
  }
  const status = wantsYes === both ? "won" : "lost";
  return { status: status as PickStatus, reason: `Ambos marcaram: ${both ? "sim" : "nao"} (${scoreLabel(fixture)}).` };
}

function evaluateWinner(selection: PickLike, fixture: ApiFootballFixture) {
  const pick = normalizeText(selectionText(selection));
  const result = resultSide(fixture);
  const home = normalizeText(fixture.teams.home.name);
  const away = normalizeText(fixture.teams.away.name);
  const won = (result === "home" && pick.includes(home)) ||
    (result === "away" && pick.includes(away)) ||
    (result === "draw" && (pick.includes("empate") || pick === "x"));
  return { status: won ? "won" as PickStatus : "lost" as PickStatus, reason: `Resultado final: ${scoreLabel(fixture)}.` };
}

function evaluateDoubleChance(selection: PickLike, fixture: ApiFootballFixture) {
  const pick = normalizeText(selectionText(selection));
  const result = resultSide(fixture);
  const home = normalizeText(fixture.teams.home.name);
  const away = normalizeText(fixture.teams.away.name);
  const includesHome = pick.includes(home) || pick.includes("mandante");
  const includesAway = pick.includes(away) || pick.includes("visitante");
  const includesDraw = pick.includes("empate");
  const won = (result === "home" && includesHome) || (result === "away" && includesAway) || (result === "draw" && includesDraw);
  return { status: won ? "won" as PickStatus : "lost" as PickStatus, reason: `Resultado final: ${scoreLabel(fixture)}.` };
}

function statValue(stats: any[], fixture: ApiFootballFixture, selection: PickLike, patterns: string[]) {
  const market = normalizeText(String(selection.market || ""));
  const targetHome = market.includes(normalizeText(fixture.teams.home.name));
  const targetAway = market.includes(normalizeText(fixture.teams.away.name));
  let total = 0;
  let found = false;

  for (const teamStats of stats || []) {
    const teamName = normalizeText(teamStats?.team?.name || "");
    const isHome = teamName === normalizeText(fixture.teams.home.name);
    const isAway = teamName === normalizeText(fixture.teams.away.name);
    if (targetHome && !isHome) continue;
    if (targetAway && !isAway) continue;

    for (const stat of teamStats?.statistics || []) {
      const type = normalizeText(String(stat?.type || ""));
      if (!patterns.some((pattern) => type.includes(pattern))) continue;
      const value = Number(stat?.value || 0);
      if (Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }
  }

  return found ? total : null;
}

function isPeriodMarket(selection: PickLike) {
  const raw = `${selection.market || ""} ${selection.category || ""} ${selectionText(selection)}`;
  const normalized = normalizeText(raw);
  return (
    /\b\d{1,2}\s*m\s*[-–]\s*\d{1,2}\s*m\b/i.test(raw) ||
    normalized.includes("primeiro tempo") ||
    normalized.includes("segundo tempo") ||
    normalized.includes("1 tempo") ||
    normalized.includes("2 tempo") ||
    normalized.includes("first half") ||
    normalized.includes("second half") ||
    normalized.includes("1st half") ||
    normalized.includes("2nd half") ||
    normalized.includes("halftime") ||
    normalized.includes("half time")
  );
}

async function fixtureStatistics(fixtureId: number) {
  try {
    return await apiFootball("/fixtures/statistics", { fixture: fixtureId });
  } catch {
    return [];
  }
}

async function evaluateSelection(selection: PickLike, fixture: ApiFootballFixture, statsCache: Map<number, any[]>, allowLiveApi: boolean) {
  const fixtureId = selectionFixtureId(selection);
  const category = categoryFor(selection);

  if (isPending(fixture)) {
    return { status: "pending" as PickStatus, reason: `Jogo ainda nao finalizado (${fixture.fixture.status?.long || "status aberto"}).` };
  }

  if (category === "mais_menos_gols") return evaluateGoals(selection, fixture);
  if (category === "ambas_marcam") return evaluateBothTeamsScore(selection, fixture);
  if (category === "resultado_final") return evaluateWinner(selection, fixture);
  if (category === "dupla_chance") return evaluateDoubleChance(selection, fixture);
  if (category === "periodo") {
    return { status: "review" as PickStatus, reason: "Mercado por periodo/minuto precisa de eventos detalhados; deixei para conferencia manual." };
  }

  if (["escanteios", "cartoes", "chutes_gol", "desarmes"].includes(category)) {
    const line = parseLine(selection);
    if (!line) return { status: "review" as PickStatus, reason: "Linha nao identificada automaticamente." };
    if (!allowLiveApi) {
      return { status: "review" as PickStatus, reason: "Esse mercado precisa de estatistica pos-jogo; para economizar API, nao atualizei ao vivo." };
    }
    if (!statsCache.has(fixtureId)) statsCache.set(fixtureId, await fixtureStatistics(fixtureId));
    const stats = statsCache.get(fixtureId) || [];
    const patterns = category === "escanteios"
      ? ["corner"]
      : category === "cartoes"
        ? ["yellow cards", "red cards"]
        : category === "chutes_gol"
          ? ["shots on goal"]
          : ["tackles"];
    const value = statValue(stats, fixture, selection, patterns);
    if (value === null) {
      return { status: "review" as PickStatus, reason: "A API nao trouxe estatistica suficiente para confirmar esse mercado." };
    }
    const status = lineResult(value, line) as PickStatus;
    return { status, reason: `Estatistica encontrada: ${value}. Placar ${scoreLabel(fixture)}.` };
  }

  return { status: "review" as PickStatus, reason: "Mercado ainda nao tem regra automatica de fechamento." };
}

function statusLabel(status: PickStatus) {
  if (status === "won") return "Bateu";
  if (status === "lost") return "Nao bateu";
  if (status === "pending") return "Pendente";
  if (status === "void") return "Anulada";
  return "Conferir";
}

function statusTone(status: PickStatus) {
  if (status === "won") return "baixo";
  if (status === "lost") return "alto";
  if (status === "pending") return "medio";
  return "extremo";
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const date = await resolveReportDate(url.searchParams.get("date"));
  const allowLiveApi = url.searchParams.get("refresh") === "1" || url.searchParams.get("live") === "1";

  if (allowLiveApi && !getEnv("API_FOOTBALL_KEY")) {
    return json({
      error: "API_FOOTBALL_KEY ausente",
      setup: [
        "Configure API_FOOTBALL_KEY no Netlify.",
        "O relatorio de acertos precisa consultar placares/resultados na API-Football.",
      ],
    }, { status: 501 });
  }

  try {
    if (!allowLiveApi) {
      const cachedSettlement = await readCachedSettlement(date);
      if (cachedSettlement) {
        return json({
          ...cachedSettlement,
          source: {
            ...cachedSettlement.source,
            cached: true,
            mode: "Fechamento salvo sem chamadas externas",
          },
        });
      }
    }

    const reports = await readReportsForDate(date);
    const selections = collectSelections(reports);
    const storedFixturesById = collectStoredFixtures(reports);

    if (!reports.length || !selections.length) {
      return json({
        error: "Ainda nao existe palpite salvo para essa data",
        detail: "Gere primeiro um palpite de futebol no Sete PRO. Depois volte no relatorio de acertos.",
        setup: [
          "Clique em Futebol hoje para gerar palpites salvos do dia.",
          "Depois que os jogos forem acontecendo, use Acertos do dia para fechar o resultado.",
        ],
      }, { status: 404 });
    }

    const fixtureIds = [...new Set(selections.map(selectionFixtureId).filter(Boolean))];
    let fixtureRequests = 0;
    let cachedFixtureHits = 0;
    const fixturePairs = await Promise.all(fixtureIds.map(async (fixtureId) => {
      const storedFixture = storedFixturesById.get(fixtureId);
      if (storedFixture) {
        cachedFixtureHits += 1;
        return [fixtureId, storedFixture] as const;
      }
      if (!allowLiveApi) return [fixtureId, null] as const;

      try {
        fixtureRequests += 1;
        const fixtures = await apiFootball("/fixtures", { id: fixtureId, timezone: DEFAULT_TIMEZONE });
        return [fixtureId, fixtures[0] || null] as const;
      } catch {
        return [fixtureId, null] as const;
      }
    }));
    const fixturesById = new Map<number, ApiFootballFixture | null>(fixturePairs);
    const statsCache = new Map<number, any[]>();
    const items = [];

    for (const selection of selections) {
      const fixtureId = selectionFixtureId(selection);
      const fixture = fixturesById.get(fixtureId);
      if (!fixture) {
        items.push({
          ...selection,
          fixtureId,
          status: "review",
          label: statusLabel("review"),
          tone: statusTone("review"),
          reason: allowLiveApi
            ? "Nao consegui localizar o fixture na API para fechar esse palpite."
            : "Nao encontrei placar final salvo para esse jogo. Nao chamei a API para economizar quota.",
          result: "--",
          category: categoryFor(selection),
        });
        continue;
      }

      const result = await evaluateSelection(selection, fixture, statsCache, allowLiveApi);
      items.push({
        fixtureId,
        game: selection.game || `${fixture.teams.home.name} x ${fixture.teams.away.name}`,
        league: selection.league || fixture.league?.name || "Competicao nao informada",
        startsAt: selection.startsAt || fixture.fixture.date,
        market: selection.market || selection.category || "--",
        selection: selectionText(selection),
        odd: Number(selection.odd || 0) || null,
        bookmaker: selection.bookmaker || "",
        ticketName: selection.ticketName || "Palpite",
        sourceLabel: selection.sourceLabel || "Palpites do dia",
        status: result.status,
        label: statusLabel(result.status),
        tone: statusTone(result.status),
        reason: result.reason,
        result: scoreLabel(fixture),
        category: categoryFor(selection),
      });
    }

    const summary = items.reduce((acc: Record<string, number>, item: any) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, { won: 0, lost: 0, pending: 0, void: 0, review: 0 });

    const responseBody = {
      source: {
        provider: allowLiveApi ? "Sete PRO + API-Football resultados" : "Sete PRO + dados salvos",
        date,
        generatedAt: new Date().toISOString(),
        timezone: DEFAULT_TIMEZONE,
        reportsFound: reports.length,
        picksChecked: items.length,
        fixtureRequests,
        cachedFixtureHits,
        statisticsRequests: statsCache.size,
        mode: allowLiveApi ? "Atualizacao com API" : "Economico sem chamadas externas",
      },
      summary,
      items,
    };
    await saveSettlement(responseBody);
    return json(responseBody);
  } catch (error: any) {
    return json({
      error: "Nao consegui gerar o relatorio de acertos",
      detail: error?.message || "Erro desconhecido ao consultar resultados.",
      setup: [
        "No modo economico, gere/salve palpites apos os jogos para o relatorio usar placares ja salvos.",
        "Se precisar atualizar placares ao vivo, use refresh=1 no endpoint e confira a quota da API_FOOTBALL_KEY.",
        "Confira se ja existe palpite salvo para o dia escolhido.",
      ],
    }, { status: 502 });
  }
};

export const config = {
  path: "/api/settled-picks",
  method: ["GET"],
};
