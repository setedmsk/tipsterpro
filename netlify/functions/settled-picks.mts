import { getStore } from "@netlify/blobs";
import { sendPushToAll } from "./_shared/push.mts";
import { externalServiceError, fetchWithTimeout, friendlyErrorPayload, missingConfig } from "./_shared/http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const API_BASKETBALL_BASE = "https://v1.basketball.api-sports.io";
const API_VOLLEYBALL_BASE = "https://v1.volleyball.api-sports.io";
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const FOOTBALL_CACHE_VERSIONS = ["manual-br-v2", "manual-br-v1"];
const VOLLEYBALL_CACHE_VERSION = "volley-points-v2";
const SETTLEMENT_CACHE_VERSION = "multi-sport-v2";
const WEEKLY_SETTLEMENT_CACHE_VERSION = "weekly-v1";

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
  sport?: string;
  reportDate?: string;
  eventDate?: string;
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
  if (!key) throw missingConfig("API_FOOTBALL_KEY", "API-Football");

  const url = new URL(path, API_FOOTBALL_BASE);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  });

  const response = await fetchWithTimeout(url, {
    headers: {
      "x-apisports-key": key,
    },
  }, 8000, "API-Football");

  if (!response.ok) throw externalServiceError("API-Football", `HTTP ${response.status} em ${path}`, response.status === 429 ? 429 : 502);

  const data = await response.json();
  const apiErrors = data.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (apiErrors.length) {
    const detail = apiErrors.join(" | ");
    throw externalServiceError("API-Football", detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }
  return data.response || [];
}

const RESULT_APIS = {
  basketball: {
    label: "API-Basketball",
    baseUrl: API_BASKETBALL_BASE,
    envKeys: ["API_BASKETBALL_KEY", "API_SPORTS_KEY", "API_FOOTBALL_KEY"],
  },
  volleyball: {
    label: "API-Volleyball",
    baseUrl: API_VOLLEYBALL_BASE,
    envKeys: ["API_VOLLEYBALL_KEY", "API_SPORTS_KEY", "API_FOOTBALL_KEY"],
  },
} as const;

type ResultApiSport = keyof typeof RESULT_APIS;

function resultApiKey(sport: ResultApiSport) {
  return RESULT_APIS[sport].envKeys.map(getEnv).find(Boolean) || "";
}

async function apiSportGames(
  sport: ResultApiSport,
  params: Record<string, string | number | undefined>
) {
  const config = RESULT_APIS[sport];
  const key = resultApiKey(sport);
  if (!key) throw missingConfig(config.envKeys[0], config.label);

  const url = new URL("/games", config.baseUrl);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  });

  const response = await fetchWithTimeout(url, {
    headers: {
      "x-apisports-key": key,
    },
  }, 8000, config.label);

  if (!response.ok) {
    throw externalServiceError(config.label, `HTTP ${response.status} em /games`, response.status === 429 ? 429 : 502);
  }

  const data = await response.json();
  const apiErrors = Array.isArray(data.errors)
    ? data.errors.filter(Boolean)
    : data.errors && typeof data.errors === "object"
      ? Object.values(data.errors).flat().filter(Boolean)
      : [];
  if (apiErrors.length) {
    const detail = apiErrors.join(" | ");
    throw externalServiceError(config.label, detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }

  return data.response || [];
}

function dailyStore() {
  return getStore({ name: "daily-picks", consistency: "strong" });
}

function basketballStore() {
  return getStore({ name: "daily-basketball-picks", consistency: "strong" });
}

function volleyballStore() {
  return getStore({ name: "daily-volleyball-picks", consistency: "strong" });
}

function settlementStore() {
  return getStore({ name: "settled-picks", consistency: "strong" });
}

function isUsefulSettlement(report: any) {
  const items = Array.isArray(report?.items) ? report.items : [];
  return Boolean(report?.source?.date && items.length);
}

function isFuturePendingItem(item: any) {
  if (String(item?.status || "") !== "pending") return false;
  const startsAt = new Date(String(item?.startsAt || "")).getTime();
  return Number.isFinite(startsAt) && startsAt > Date.now();
}

async function readCachedSettlement(date: string) {
  try {
    const report = await settlementStore().get(`reports/${SETTLEMENT_CACHE_VERSION}/${date}.json`, { type: "json" });
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
    await store.setJSON(`reports/${SETTLEMENT_CACHE_VERSION}/${report.source.date}.json`, report);
    await store.setJSON("latest.json", report);
  } catch {
    // The report can still be returned even when Blob persistence is unavailable.
  }
}

async function notificationKeyForSettlement(report: any) {
  const items = Array.isArray(report?.items) ? report.items : [];
  const closed = items
    .filter((item: any) => ["won", "lost", "void"].includes(String(item?.status || "")))
    .map((item: any) => [
      item.sport || "",
      item.fixtureId || "",
      item.market || "",
      item.selection || "",
      item.status || "",
      item.result || "",
    ].join("|"))
    .sort()
    .join(";");

  if (!closed) return "";
  const bytes = new TextEncoder().encode(`${report?.source?.date || ""}|${closed}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `notifications/${SETTLEMENT_CACHE_VERSION}/${report.source.date}/${hash}.json`;
}

async function notifySettlementIfNeeded(report: any) {
  const summary = report?.summary || {};
  const closedCount = Number(summary.won || 0) + Number(summary.lost || 0) + Number(summary.void || 0);
  if (!closedCount) return { sent: 0, skipped: true };

  const key = await notificationKeyForSettlement(report);
  if (!key) return { sent: 0, skipped: true };

  const store = settlementStore();
  try {
    const alreadySent = await store.get(key, { type: "json" });
    if (alreadySent) return { sent: 0, skipped: true, duplicate: true };
  } catch {
    // Missing key means this settlement has not been notified yet.
  }

  const won = Number(summary.won || 0);
  const lost = Number(summary.lost || 0);
  const review = Number(summary.review || 0);
  const result = await sendPushToAll({
    title: "Sete PRO - Acertos do dia",
    body: `${won} bateram, ${lost} nao bateram${review ? `, ${review} para conferir` : ""}.`,
    tag: `sete-pro-settlement-${report.source.date}`,
    url: "/?acao=acertos",
  });

  if (!result.skipped) {
    await store.setJSON(key, {
      sentAt: new Date().toISOString(),
      result,
      summary,
    });
  }

  return result;
}

function withSettlementSport(report: any, sport: string) {
  return report
    ? {
        ...report,
        settlementSport: sport,
      }
    : null;
}

async function readFootballReportsForDate(date: string) {
  const store = dailyStore();
  const reports: any[] = [];
  const seen = new Set<string>();

  for (const version of FOOTBALL_CACHE_VERSIONS) {
    const prefix = `reports/${version}/${date}/`;
    const countBefore = reports.length;

    try {
      const listed = await store.list({ prefix });
      for (const blob of listed.blobs || []) {
        const key = blob.key;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const report = await store.get(key, { type: "json" });
        if (report) reports.push(withSettlementSport(report, "football"));
      }
    } catch {
      // Local/dev stores may not support listing; latest.json below is the fallback.
    }

    if (reports.length > countBefore) break;
  }

  try {
    const latest = await store.get("latest.json", { type: "json" }) as any;
    const duplicate = reports.some((report) => (
      String(report?.source?.generatedAt || "") === String(latest?.source?.generatedAt || "") &&
      String(report?.source?.provider || "") === String(latest?.source?.provider || "")
    ));
    if (latest?.source?.date === date && !duplicate) {
      reports.push(withSettlementSport(latest, "football"));
    }
  } catch {
    // No cached report yet.
  }

  return reports.filter((report) => {
    return report?.source?.date === date && Array.isArray(report?.raw?.picks);
  });
}

async function readSingleReportForDate(store: ReturnType<typeof getStore>, date: string, key: string, sport: string) {
  const reports: any[] = [];

  try {
    const report = await store.get(key, { type: "json" }) as any;
    if (report?.source?.date === date && Array.isArray(report?.raw?.picks)) {
      reports.push(withSettlementSport(report, sport));
    }
  } catch {
    // No cached report for this sport/date.
  }

  try {
    const latest = await store.get("latest.json", { type: "json" }) as any;
    if (latest?.source?.date === date && Array.isArray(latest?.raw?.picks)) {
      const alreadyAdded = reports.some((report) => String(report?.source?.provider || "") === String(latest?.source?.provider || ""));
      if (!alreadyAdded) reports.push(withSettlementSport(latest, sport));
    }
  } catch {
    // No latest report for this sport.
  }

  return reports;
}

async function readReportsForDate(date: string) {
  const [football, basketball, volleyball] = await Promise.all([
    readFootballReportsForDate(date),
    readSingleReportForDate(basketballStore(), date, `reports/${date}.json`, "basketball"),
    readSingleReportForDate(volleyballStore(), date, `reports/${VOLLEYBALL_CACHE_VERSION}/${date}.json`, "volleyball"),
  ]);

  return [...football, ...basketball, ...volleyball];
}

async function listReportDates() {
  const store = dailyStore();
  const dates = new Set<string>();

  for (const version of FOOTBALL_CACHE_VERSIONS) {
    try {
      const listed = await store.list({ prefix: `reports/${version}/` });
      for (const blob of listed.blobs || []) {
        const match = String(blob.key || "").match(/^reports\/[^/]+\/(\d{4}-\d{2}-\d{2})\//);
        if (match) dates.add(match[1]);
      }
    } catch {
      // Listing can be unavailable in local/dev stores; latest.json below is the fallback.
    }
  }

  try {
    const latest = await store.get("latest.json", { type: "json" }) as any;
    if (latest?.source?.date) dates.add(String(latest.source.date));
  } catch {
    // No latest report yet.
  }

  for (const [extraStore, prefix] of [
    [basketballStore(), "reports/"],
    [volleyballStore(), `reports/${VOLLEYBALL_CACHE_VERSION}/`],
  ] as const) {
    try {
      const listed = await extraStore.list({ prefix });
      for (const blob of listed.blobs || []) {
        const match = String(blob.key || "").match(/(\d{4}-\d{2}-\d{2})\.json$/);
        if (match) dates.add(match[1]);
      }
    } catch {
      // Extra sport stores are optional.
    }

    try {
      const latest = await extraStore.get("latest.json", { type: "json" }) as any;
      if (latest?.source?.date) dates.add(String(latest.source.date));
    } catch {
      // No latest report for this sport.
    }
  }

  try {
    const settlements = await settlementStore().list({ prefix: "reports/" });
    for (const blob of settlements.blobs || []) {
      const match = String(blob.key || "").match(/^reports\/[^/]+\/(\d{4}-\d{2}-\d{2})\.json$/);
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

function selectionSport(selection: PickLike) {
  const normalized = normalizeText(String(selection.sport || ""));
  if (normalized.includes("basket")) return "basketball";
  if (normalized.includes("volley") || normalized.includes("volei")) return "volleyball";
  if (normalized.includes("foot") || normalized.includes("futebol") || normalized.includes("soccer")) return "football";
  return "football";
}

function pickSignature(selection: PickLike) {
  return [
    selectionSport(selection),
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
  if (normalized.includes("resultado") || normalized.includes("vitoria") || normalized.includes("vence") || normalized.includes("vencedor") || normalized.includes("winner") || normalized.includes("1x2")) return "resultado_final";
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
  const sport = String(report?.settlementSport || "");
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
        sport: selection.sport || raw?.sport || sport || "football",
        reportDate: String(report?.source?.date || ""),
        ticketName: item.name,
        sourceLabel: report?.source?.scopeLabel || (sport === "basketball" ? "Basquete" : sport === "volleyball" ? "Volei" : "Palpites do dia"),
      });
    }
  }

  if (!selections.length) {
    for (const pick of rawPicks) {
      selections.push({
        ...pick,
        sport: pick.sport || sport || "football",
        reportDate: String(report?.source?.date || ""),
        ticketName: "Palpite",
        sourceLabel: report?.source?.scopeLabel || (sport === "basketball" ? "Basquete" : sport === "volleyball" ? "Volei" : "Palpites do dia"),
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
      if (!key.includes("|0|") && !byKey.has(key)) byKey.set(key, selection);
    }
  }
  return [...byKey.values()];
}

function weeklySelectionSignature(selection: PickLike) {
  return [
    selectionSport(selection),
    selectionFixtureId(selection),
    normalizeText(String(selection.market || selection.category || "")),
    normalizeText(selectionText(selection)),
  ].join("|");
}

function collectWeeklySelections(reports: any[]) {
  const byKey = new Map<string, PickLike & { ticketName?: string; sourceLabel?: string }>();

  for (const report of reports) {
    for (const selection of collectReportSelections(report)) {
      const key = weeklySelectionSignature(selection);
      if (key.includes("|0|")) continue;
      const current = byKey.get(key);
      if (!current || String(selection.reportDate || "") > String(current.reportDate || "")) {
        byKey.set(key, selection);
      }
    }
  }

  return [...byKey.values()];
}

function fixtureIdFromFixture(fixture: ApiFootballFixture) {
  return Number((fixture as any)?.fixture?.id || (fixture as any)?.id || 0);
}

function collectStoredFixtures(reports: any[]) {
  const byId = new Map<string, ApiFootballFixture>();
  for (const report of reports) {
    const sport = String(report?.settlementSport || "football");
    const fixtures = Array.isArray(report?.raw?.fixtures) ? report.raw.fixtures : [];
    for (const fixture of fixtures) {
      const fixtureId = fixtureIdFromFixture(fixture);
      const key = fixtureKey(sport, fixtureId);
      if (fixtureId && !byId.has(key)) byId.set(key, fixture);
    }
  }
  return byId;
}

function fixtureKey(sport: string, fixtureId: number) {
  return `${sport || "football"}:${fixtureId}`;
}

function localDateForSelection(selection: PickLike, fallbackDate: string) {
  const startsAt = String(selection.startsAt || "");
  if (!startsAt) return fallbackDate;

  const parsed = new Date(startsAt);
  if (!Number.isFinite(parsed.getTime())) return fallbackDate;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

async function loadUpdatedFixtures(
  selections: PickLike[],
  storedFixturesById: Map<string, ApiFootballFixture>,
  fallbackDate: string
) {
  const queries = new Map<string, { sport: string; date: string }>();

  for (const selection of selections) {
    const fixtureId = selectionFixtureId(selection);
    const sport = selectionSport(selection);
    if (!fixtureId || !["football", "basketball", "volleyball"].includes(sport)) continue;
    const stored = storedFixturesById.get(fixtureKey(sport, fixtureId));
    if (stored && isFinished(stored)) continue;
    const date = localDateForSelection(selection, fallbackDate);
    queries.set(`${sport}:${date}`, { sport, date });
  }

  const requestCounts: Record<string, number> = {
    football: 0,
    basketball: 0,
    volleyball: 0,
  };
  const queryResults = await Promise.all([...queries.values()].map(async ({ sport, date }) => {
    requestCounts[sport] = (requestCounts[sport] || 0) + 1;
    try {
      const fixtures = sport === "football"
        ? await apiFootball("/fixtures", { date, timezone: DEFAULT_TIMEZONE })
        : await apiSportGames(sport as ResultApiSport, { date, timezone: DEFAULT_TIMEZONE });
      return { sport, date, fixtures, error: "" };
    } catch (error: any) {
      return {
        sport,
        date,
        fixtures: [],
        error: error?.message || `Nao consegui atualizar ${sport}.`,
      };
    }
  }));

  const fixturesById = new Map<string, ApiFootballFixture>();
  const warnings: string[] = [];
  const failedQueryKeys = new Set<string>();
  for (const result of queryResults) {
    if (result.error) {
      warnings.push(`${result.sport} ${result.date}: ${result.error}`);
      failedQueryKeys.add(`${result.sport}:${result.date}`);
      continue;
    }
    for (const fixture of result.fixtures || []) {
      const fixtureId = fixtureIdFromFixture(fixture);
      if (fixtureId) fixturesById.set(fixtureKey(result.sport, fixtureId), fixture);
    }
  }

  return {
    fixturesById,
    warnings,
    failedQueryKeys,
    requestCounts,
    fixtureRequests: Object.values(requestCounts).reduce((sum, value) => sum + value, 0),
  };
}

function goalValue(fixture: ApiFootballFixture, side: "home" | "away") {
  const goals = fixture.goals?.[side];
  if (goals !== null && goals !== undefined) return Number(goals);
  const fulltime = (fixture as any)?.score?.fulltime?.[side];
  if (fulltime !== null && fulltime !== undefined) return Number(fulltime);
  const scoreTotal = (fixture as any)?.scores?.[side]?.total;
  if (scoreTotal !== null && scoreTotal !== undefined) return Number(scoreTotal);
  const directScore = (fixture as any)?.scores?.[side];
  if (directScore !== null && directScore !== undefined && typeof directScore !== "object") return Number(directScore);
  return NaN;
}

function fixtureStatusShort(fixture: ApiFootballFixture) {
  return String((fixture as any)?.fixture?.status?.short || (fixture as any)?.status?.short || "");
}

function fixtureStatusLong(fixture: ApiFootballFixture) {
  return String((fixture as any)?.fixture?.status?.long || (fixture as any)?.status?.long || "");
}

function isFinished(fixture: ApiFootballFixture) {
  const status = normalizeText(`${fixtureStatusShort(fixture)} ${fixtureStatusLong(fixture)}`);
  return (
    ["ft", "aet", "pen", "aot", "ap"].some((item) => status.split(" ").includes(item)) ||
    status.includes("match finished") ||
    status.includes("finished") ||
    status.includes("after overtime") ||
    status.includes("ended")
  );
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
    : fixtureStatusLong(fixture) || "Sem placar";
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
  const periodTotal = fixturePeriodPoints(fixture);
  if (market.includes(home) || pick.includes(home)) return goalValue(fixture, "home");
  if (market.includes(away) || pick.includes(away)) return goalValue(fixture, "away");
  if (/\bhome\b/.test(market) || market.includes("mandante") || market.includes("casa")) return goalValue(fixture, "home");
  if (/\baway\b/.test(market) || market.includes("visitante") || market.includes("fora")) return goalValue(fixture, "away");
  if (selectionSport(selection) === "volleyball" && Number.isFinite(periodTotal) && periodTotal > 0) return periodTotal;
  return goalValue(fixture, "home") + goalValue(fixture, "away");
}

function fixturePeriodPoints(fixture: ApiFootballFixture) {
  const periods = (fixture as any)?.periods || {};
  let total = 0;
  let found = false;
  for (const period of Object.values(periods) as any[]) {
    const home = Number(period?.home);
    const away = Number(period?.away);
    if (Number.isFinite(home)) {
      total += home;
      found = true;
    }
    if (Number.isFinite(away)) {
      total += away;
      found = true;
    }
  }
  return found ? total : NaN;
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
    return { status: "pending" as PickStatus, reason: `Jogo ainda nao finalizado (${fixtureStatusLong(fixture) || "status aberto"}).` };
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

function eventDateForSelection(selection: PickLike) {
  return localDateForSelection(selection, String(selection.reportDate || todayInSaoPaulo()));
}

function selectionHasStarted(selection: PickLike, now = Date.now()) {
  const startsAt = new Date(String(selection.startsAt || "")).getTime();
  if (Number.isFinite(startsAt)) return startsAt <= now;
  return eventDateForSelection(selection) < todayInSaoPaulo();
}

function weeklySettlementKey(dateTo: string) {
  return `reports/${WEEKLY_SETTLEMENT_CACHE_VERSION}/${dateTo}.json`;
}

async function readWeeklySettlement(dateTo: string) {
  try {
    const report = await settlementStore().get(weeklySettlementKey(dateTo), { type: "json" });
    return isUsefulSettlement(report) ? report : null;
  } catch {
    return null;
  }
}

async function saveWeeklySettlement(report: any) {
  if (!isUsefulSettlement(report)) return;
  try {
    await settlementStore().setJSON(weeklySettlementKey(report.source.dateTo), report);
  } catch {
    // The weekly report can still be returned when Blob persistence is unavailable.
  }
}

function summarizeStatuses(items: any[]) {
  return items.reduce((acc: Record<string, number>, item: any) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { won: 0, lost: 0, pending: 0, void: 0, review: 0 });
}

function weeklyDaySummaries(items: any[]) {
  const byDate = new Map<string, any[]>();
  for (const item of items) {
    const date = String(item.eventDate || item.reportDate || "");
    const list = byDate.get(date) || [];
    list.push(item);
    byDate.set(date, list);
  }

  return [...byDate.entries()]
    .sort(([dateA], [dateB]) => dateB.localeCompare(dateA))
    .map(([date, dayItems]) => ({
      date,
      summary: summarizeStatuses(dayItems),
      items: dayItems,
    }));
}

async function handleWeeklySettlement(
  allowLiveApi: boolean,
  context: { deploy?: { published?: boolean } }
) {
  const dateTo = todayInSaoPaulo();
  const dateFrom = addDays(dateTo, -6);
  const availableDates = await listReportDates();
  const reportDates = availableDates.filter((date) => date >= dateFrom && date <= dateTo);
  const reports = (await Promise.all(reportDates.map(readReportsForDate))).flat();
  const collected = collectWeeklySelections(reports)
    .map((selection) => ({
      ...selection,
      eventDate: eventDateForSelection(selection),
    }))
    .filter((selection) => selection.eventDate >= dateFrom && selection.eventDate <= dateTo);

  if (!reports.length || !collected.length) {
    return json({
      error: "Ainda nao existe historico de palpites nesta semana",
      detail: "Gere palpites nos botoes esportivos para o Sete PRO acompanhar os resultados.",
      setup: [
        "Use Futebol, Basquete, Volei ou Bingo do 7 para salvar palpites.",
        "Depois volte em Acertos da semana para atualizar os placares.",
      ],
    }, { status: 404 });
  }

  const startedSelections = collected.filter((selection) => selectionHasStarted(selection));
  const upcomingSelections = collected.filter((selection) => !selectionHasStarted(selection));
  const cached = await readWeeklySettlement(dateTo);
  const currentStartedKeys = new Set(startedSelections.map(weeklySelectionSignature));
  const cachedReusable = Array.isArray(cached?.items)
    ? cached.items.flatMap((item: any) => {
        if (!currentStartedKeys.has(weeklySelectionSignature(item))) return [];
        const status = String(item?.status || "");
        if (["won", "lost", "void", "review"].includes(status)) return [item];
        const historicalFailure = status === "pending" &&
          String(item?.eventDate || "") < dateTo &&
          normalizeText(String(item?.reason || "")).includes("nao consegui atualizar");
        if (!historicalFailure) return [];
        return [{
          ...item,
          status: "review",
          label: statusLabel("review"),
          tone: statusTone("review"),
          reason: "Resultado historico indisponivel no plano atual da API. Este item fica fora da contagem de acertos e erros.",
          result: "--",
        }];
      })
    : [];
  const reusableByKey = new Map(cachedReusable.map((item: any) => [weeklySelectionSignature(item), item]));
  const selectionsToUpdate = startedSelections.filter((selection) => !reusableByKey.has(weeklySelectionSignature(selection)));
  const storedFixturesById = collectStoredFixtures(reports);
  const updated = allowLiveApi && selectionsToUpdate.length
    ? await loadUpdatedFixtures(selectionsToUpdate, storedFixturesById, dateTo)
    : {
        fixturesById: new Map<string, ApiFootballFixture>(),
        warnings: [] as string[],
        failedQueryKeys: new Set<string>(),
        requestCounts: { football: 0, basketball: 0, volleyball: 0 },
        fixtureRequests: 0,
      };

  const statsCache = new Map<number, any[]>();
  const refreshedItems: any[] = [];
  const liveKeys = new Set<string>();
  const storedKeys = new Set<string>();
  const fallbackKeys = new Set<string>();

  for (const selection of selectionsToUpdate) {
    const fixtureId = selectionFixtureId(selection);
    const sport = selectionSport(selection);
    const key = fixtureKey(sport, fixtureId);
    const liveFixture = updated.fixturesById.get(key);
    const storedFixture = storedFixturesById.get(key);
    const fixture = liveFixture || storedFixture;
    const fixtureSource = liveFixture ? "live" : storedFixture ? "stored" : "missing";
    if (liveFixture) liveKeys.add(key);
    if (storedFixture) storedKeys.add(key);
    if (allowLiveApi && !liveFixture && storedFixture) fallbackKeys.add(key);

    if (!fixture) {
      refreshedItems.push({
        ...selection,
        fixtureId,
        sport,
        eventDate: eventDateForSelection(selection),
        status: "review",
        label: statusLabel("review"),
        tone: statusTone("review"),
        reason: allowLiveApi
          ? "A API de resultados nao devolveu esse jogo na atualizacao."
          : "Nao encontrei placar final salvo para esse jogo.",
        result: "--",
        category: categoryFor(selection),
      });
      continue;
    }

    const evaluated = await evaluateSelection(selection, fixture, statsCache, allowLiveApi);
    const eventDate = eventDateForSelection(selection);
    const historicalQueryFailed = evaluated.status === "pending" &&
      fixtureSource === "stored" &&
      eventDate < dateTo &&
      updated.failedQueryKeys.has(`${sport}:${eventDate}`);
    const result = historicalQueryFailed
      ? {
          status: "review" as PickStatus,
          reason: "Resultado historico indisponivel no plano atual da API. Este item fica fora da contagem de acertos e erros.",
        }
      : evaluated.status === "pending" && allowLiveApi && fixtureSource === "stored"
      ? {
          status: "pending" as PickStatus,
          reason: `Nao consegui atualizar este placar agora. Ultimo status salvo: ${fixtureStatusLong(fixture) || fixtureStatusShort(fixture) || "sem status"}.`,
        }
      : evaluated;
    refreshedItems.push({
      fixtureId,
      sport,
      game: selection.game || `${fixture.teams.home.name} x ${fixture.teams.away.name}`,
      league: selection.league || fixture.league?.name || "Competicao nao informada",
      startsAt: selection.startsAt || (fixture as any)?.fixture?.date || (fixture as any)?.date,
      eventDate,
      reportDate: selection.reportDate,
      market: selection.market || selection.category || "--",
      selection: selectionText(selection),
      odd: Number(selection.odd || 0) || null,
      bookmaker: selection.bookmaker || "",
      ticketName: selection.ticketName || "Palpite",
      sourceLabel: selection.sourceLabel || "Palpites do Sete",
      status: result.status,
      label: statusLabel(result.status),
      tone: statusTone(result.status),
      reason: result.reason,
      result: scoreLabel(fixture),
      category: categoryFor(selection),
    });
  }

  const items = [...reusableByKey.values(), ...refreshedItems]
    .sort((a: any, b: any) => (
      String(b.eventDate || "").localeCompare(String(a.eventDate || "")) ||
      String(b.startsAt || "").localeCompare(String(a.startsAt || ""))
    ));
  const summary = summarizeStatuses(items);
  const upcoming = upcomingSelections
    .map((selection) => ({
      ...selection,
      eventDate: eventDateForSelection(selection),
      status: "scheduled",
      label: "Agendado",
    }))
    .sort((a, b) => String(a.startsAt || "").localeCompare(String(b.startsAt || "")));

  const responseBody = {
    source: {
      provider: allowLiveApi ? "Sete PRO + APIs oficiais de resultados" : "Sete PRO + historico salvo",
      date: dateTo,
      dateFrom,
      dateTo,
      rangeDays: 7,
      generatedAt: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      reportDates,
      reportsFound: reports.length,
      picksFound: collected.length,
      picksChecked: items.length,
      upcomingCount: upcoming.length,
      fixtureRequests: updated.fixtureRequests,
      fixtureRequestsBySport: updated.requestCounts,
      liveFixtureHits: liveKeys.size,
      cachedFixtureHits: storedKeys.size,
      fallbackFixtureHits: fallbackKeys.size,
      statisticsRequests: statsCache.size,
      warnings: updated.warnings,
      mode: allowLiveApi ? "Historico semanal com atualizacao incremental" : "Historico semanal salvo",
    },
    summary,
    days: weeklyDaySummaries(items),
    items,
    upcoming,
  };

  await saveWeeklySettlement(responseBody);
  if (context?.deploy?.published === true) {
    await notifySettlementIfNeeded(responseBody);
  }
  return json(responseBody);
}

export default async (req: Request, context: { deploy?: { published?: boolean } }) => {
  const url = new URL(req.url);
  if (url.searchParams.get("range") === "7" || url.searchParams.get("weekly") === "1") {
    const allowLiveApi = url.searchParams.get("refresh") === "1" || url.searchParams.get("live") === "1";
    return handleWeeklySettlement(allowLiveApi, context);
  }
  const date = await resolveReportDate(url.searchParams.get("date"));
  const allowLiveApi = url.searchParams.get("refresh") === "1" || url.searchParams.get("live") === "1";

  try {
    const cachedSettlement = await readCachedSettlement(date);
    if (cachedSettlement) {
      const cachedItems = Array.isArray(cachedSettlement.items) ? cachedSettlement.items : [];
      const unresolved = cachedItems.filter((item: any) => ["pending", "review"].includes(String(item?.status || "")));
      const hasUnresolved = unresolved.length > 0;
      const allUnresolvedAreFuture = hasUnresolved && unresolved.every(isFuturePendingItem);
      if (!allowLiveApi || !hasUnresolved || allUnresolvedAreFuture) {
        return json({
          ...cachedSettlement,
          source: {
            ...cachedSettlement.source,
            cached: true,
            fixtureRequests: 0,
            fixtureRequestsBySport: { football: 0, basketball: 0, volleyball: 0 },
            liveFixtureHits: 0,
            fallbackFixtureHits: 0,
            mode: !hasUnresolved
              ? "Fechamento completo salvo"
              : allUnresolvedAreFuture
                ? "Fechamento parcial salvo; jogos ainda agendados"
                : "Fechamento salvo sem chamadas externas",
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

    const selectionKeys = [...new Set(selections
      .map((selection) => fixtureKey(selectionSport(selection), selectionFixtureId(selection)))
      .filter((key) => !key.endsWith(":0")))];

    const updated = allowLiveApi
      ? await loadUpdatedFixtures(selections, storedFixturesById, date)
      : {
          fixturesById: new Map<string, ApiFootballFixture>(),
          warnings: [] as string[],
          failedQueryKeys: new Set<string>(),
          requestCounts: { football: 0, basketball: 0, volleyball: 0 },
          fixtureRequests: 0,
        };

    let cachedFixtureHits = 0;
    let liveFixtureHits = 0;
    let fallbackFixtureHits = 0;
    const fixtureSourceByKey = new Map<string, "live" | "stored" | "missing">();
    const fixturePairs = selectionKeys.map((key) => {
      const updatedFixture = updated.fixturesById.get(key);
      const storedFixture = storedFixturesById.get(key);

      if (updatedFixture) {
        liveFixtureHits += 1;
        fixtureSourceByKey.set(key, "live");
        return [key, updatedFixture] as const;
      }
      if (storedFixture) {
        cachedFixtureHits += 1;
        if (allowLiveApi) fallbackFixtureHits += 1;
        fixtureSourceByKey.set(key, "stored");
        return [key, storedFixture] as const;
      }
      fixtureSourceByKey.set(key, "missing");
      return [key, null] as const;
    });
    const fixturesById = new Map<string, ApiFootballFixture | null>(fixturePairs);
    const statsCache = new Map<number, any[]>();
    const items = [];

    for (const selection of selections) {
      const fixtureId = selectionFixtureId(selection);
      const sport = selectionSport(selection);
      const key = fixtureKey(sport, fixtureId);
      const fixture = fixturesById.get(key);
      const fixtureSource = fixtureSourceByKey.get(key) || "missing";
      if (!fixture) {
        items.push({
          ...selection,
          fixtureId,
          status: "review",
          label: statusLabel("review"),
          tone: statusTone("review"),
          reason: allowLiveApi
            ? "A API de resultados nao devolveu esse jogo na atualizacao. Deixei para conferir em vez de marcar errado."
            : "Nao encontrei placar final salvo para esse jogo. Nao chamei a API para economizar quota.",
          result: "--",
          category: categoryFor(selection),
        });
        continue;
      }

      const evaluated = await evaluateSelection(selection, fixture, statsCache, allowLiveApi);
      const result = evaluated.status === "pending" && allowLiveApi && fixtureSource === "stored"
        ? {
            status: "pending" as PickStatus,
            reason: `Nao consegui atualizar este placar agora. Ultimo status salvo: ${fixtureStatusLong(fixture) || fixtureStatusShort(fixture) || "sem status"}.`,
          }
        : evaluated;
      items.push({
        fixtureId,
        sport,
        game: selection.game || `${fixture.teams.home.name} x ${fixture.teams.away.name}`,
        league: selection.league || fixture.league?.name || "Competicao nao informada",
        startsAt: selection.startsAt || (fixture as any)?.fixture?.date || (fixture as any)?.date,
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
        provider: allowLiveApi ? "Sete PRO + APIs oficiais de resultados" : "Sete PRO + dados salvos",
        date,
        generatedAt: new Date().toISOString(),
        timezone: DEFAULT_TIMEZONE,
        reportsFound: reports.length,
        picksChecked: items.length,
        fixtureRequests: updated.fixtureRequests,
        fixtureRequestsBySport: updated.requestCounts,
        liveFixtureHits,
        cachedFixtureHits,
        fallbackFixtureHits,
        statisticsRequests: statsCache.size,
        warnings: updated.warnings,
        mode: allowLiveApi ? "Atualizacao agrupada com APIs" : "Economico sem chamadas externas",
      },
      summary,
      items,
    };
    await saveSettlement(responseBody);
    if (context?.deploy?.published === true) {
      await notifySettlementIfNeeded(responseBody);
    }
    return json(responseBody);
  } catch (error: any) {
    const friendly = friendlyErrorPayload(error, "Nao consegui gerar o relatorio de acertos");
    return json({
      ...friendly.body,
      setup: [
        "Confira se ja existe palpite salvo para o dia escolhido.",
        "Confirme a quota das APIs de futebol, basquete e volei.",
        "Tente novamente em alguns minutos se algum provedor ainda nao publicou o placar final.",
      ],
    }, { status: friendly.status === 500 ? 502 : friendly.status });
  }
};

export const config = {
  path: "/api/settled-picks",
  method: ["GET"],
};
