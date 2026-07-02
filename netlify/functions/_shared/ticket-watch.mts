import { getStore } from "@netlify/blobs";

export type WatchPreferences = {
  kickoff: boolean;
  goals: boolean;
  finalResult: boolean;
  selections: boolean;
};

export type WatchedSelection = {
  fixtureId: number;
  sport: "football";
  game: string;
  market: string;
  category: string;
  selection: string;
  odd: number | null;
  startsAt: string;
};

export type SelectionState = {
  status: "pending" | "won" | "lost" | "void" | "review";
  reason: string;
  value?: number | null;
};

export type FixtureWatchState = {
  started: boolean;
  finished: boolean;
  homeGoals: number | null;
  awayGoals: number | null;
  status: string;
  updatedAt: string;
  selections: Record<string, SelectionState>;
};

export type TicketWatch = {
  id: string;
  signature: string;
  subscriptionId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  preferences: WatchPreferences;
  ticket: {
    title: string;
    totalOdd: number | null;
    possibleReturn: number | null;
    selections: WatchedSelection[];
  };
  fixtures: Record<string, FixtureWatchState>;
};

function store() {
  return getStore({ name: "ticket-watches", consistency: "strong" });
}

export function normalizeText(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

export function categoryForSelection(selection: Partial<WatchedSelection>) {
  const text = normalizeText(`${selection.market || ""} ${selection.category || ""} ${selection.selection || ""}`);
  if (text.includes("primeiro tempo") || text.includes("segundo tempo") || text.includes("first half") || text.includes("second half") || text.includes("1st half") || text.includes("2nd half")) return "periodo";
  if (text.includes("dupla chance") || text.includes("double chance")) return "dupla_chance";
  if (text.includes("ambas marcam") || text.includes("both teams") || text.includes("btts")) return "ambas_marcam";
  if (text.includes("escanteio") || text.includes("corner")) return "escanteios";
  if (text.includes("cartao") || text.includes("card") || text.includes("booking")) return "cartoes";
  if (text.includes("chute") || text.includes("shot")) return "chutes_gol";
  if (text.includes("gol") || text.includes("goal") || text.includes("mais") || text.includes("menos") || text.includes("over") || text.includes("under") || text.includes("total")) return "mais_menos_gols";
  if (text.includes("resultado") || text.includes("vencedor") || text.includes("winner") || text.includes("vence") || text.includes("vitoria") || text.includes("1x2")) return "resultado_final";
  return "outros";
}

export function normalizeWatchedSelection(value: any): WatchedSelection | null {
  const fixtureId = Number(value?.fixtureId || value?.fixture_id || 0);
  const sportText = normalizeText(value?.sport || value?.sourceLabel || "");
  const isFootball = !sportText || sportText.includes("foot") || sportText.includes("futebol") || sportText.includes("soccer");
  if (!fixtureId || !isFootball) return null;

  const selection: WatchedSelection = {
    fixtureId,
    sport: "football",
    game: String(value?.game || value?.apiGame || value?.fixture || "Jogo"),
    market: String(value?.market || value?.category || "Mercado"),
    category: String(value?.category || ""),
    selection: String(value?.selection || value?.pick || value?.value || "--"),
    odd: Number.isFinite(Number(value?.odd)) ? Number(value.odd) : null,
    startsAt: String(value?.startsAt || value?.date || value?.time || ""),
  };
  selection.category = categoryForSelection(selection);
  return selection;
}

export function selectionKey(selection: WatchedSelection) {
  return [
    selection.fixtureId,
    normalizeText(selection.market || selection.category),
    normalizeText(selection.selection),
  ].join("|");
}

export async function watchIdFor(subscriptionId: string, signature: string) {
  const input = new TextEncoder().encode(`${subscriptionId}|${signature}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function saveTicketWatch(watch: TicketWatch) {
  await store().setJSON(`watches/${watch.id}.json`, watch);
}

export async function readTicketWatch(id: string) {
  return await store().get(`watches/${id}.json`, { type: "json" }) as TicketWatch | null;
}

export async function disableTicketWatch(id: string) {
  const current = await readTicketWatch(id);
  if (!current) return false;
  await saveTicketWatch({
    ...current,
    active: false,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

export async function listActiveTicketWatches() {
  const watchStore = store();
  const listed = await watchStore.list({ prefix: "watches/" });
  const watches: TicketWatch[] = [];
  const now = Date.now();
  for (const blob of listed.blobs || []) {
    try {
      const watch = await watchStore.get(blob.key, { type: "json" }) as TicketWatch | null;
      if (watch?.active && new Date(watch.expiresAt).getTime() > now) watches.push(watch);
    } catch {
      // Ignore malformed watch records.
    }
  }
  return watches;
}

export async function saveLiveFixtureSnapshot(fixtureId: number, fixture: any, stats: any[] = []) {
  await store().setJSON(`fixtures/football/${fixtureId}.json`, {
    fixtureId,
    fixture: { ...fixture, __stats: stats },
    updatedAt: new Date().toISOString(),
  });
}

export async function listLiveFixtureSnapshots() {
  const watchStore = store();
  const listed = await watchStore.list({ prefix: "fixtures/football/" });
  const snapshots: any[] = [];
  for (const blob of listed.blobs || []) {
    try {
      const snapshot = await watchStore.get(blob.key, { type: "json" });
      if (snapshot) snapshots.push(snapshot);
    } catch {
      // Ignore malformed fixture snapshots.
    }
  }
  return snapshots;
}

function fixtureStatus(fixture: any) {
  return normalizeText(`${fixture?.fixture?.status?.short || ""} ${fixture?.fixture?.status?.long || ""}`);
}

export function fixtureIsLive(fixture: any) {
  const status = fixtureStatus(fixture);
  return ["1h", "ht", "2h", "et", "bt", "p", "live", "in progress"].some((part) => status.split(" ").includes(part) || status.includes(part));
}

export function fixtureIsFinished(fixture: any) {
  const status = fixtureStatus(fixture);
  return ["ft", "aet", "pen"].some((part) => status.split(" ").includes(part)) || status.includes("finished");
}

export function fixtureScore(fixture: any) {
  const home = Number(fixture?.goals?.home);
  const away = Number(fixture?.goals?.away);
  return {
    home: Number.isFinite(home) ? home : null,
    away: Number.isFinite(away) ? away : null,
  };
}

function parseLine(selection: WatchedSelection) {
  const pickText = normalizeText(selection.selection);
  const match = selection.selection.match(/(\d+(?:[,.]\d+)?)/) ||
    `${selection.market} ${selection.selection}`.match(/(\d+(?:[,.]\d+)?)/);
  if (!match) return null;
  const line = Number(match[1].replace(",", "."));
  if (!Number.isFinite(line)) return null;
  if (pickText.includes("mais") || pickText.includes("over")) return { side: "over" as const, line };
  if (pickText.includes("menos") || pickText.includes("under")) return { side: "under" as const, line };
  return null;
}

function statValue(stats: any[], selection: WatchedSelection, patterns: string[]) {
  const market = normalizeText(selection.market);
  const gameParts = selection.game.split(/\s+x\s+/i);
  const targetHome = gameParts[0] && market.includes(normalizeText(gameParts[0]));
  const targetAway = gameParts[1] && market.includes(normalizeText(gameParts[1]));
  let total = 0;
  let found = false;

  for (const teamStats of stats || []) {
    const teamName = normalizeText(teamStats?.team?.name || "");
    if (targetHome && teamName !== normalizeText(gameParts[0])) continue;
    if (targetAway && teamName !== normalizeText(gameParts[1])) continue;
    for (const stat of teamStats?.statistics || []) {
      const type = normalizeText(stat?.type || "");
      if (!patterns.some((pattern) => type.includes(pattern))) continue;
      const value = Number(stat?.value);
      if (Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }
  }
  return found ? total : null;
}

function evaluateLine(value: number, line: { side: "over" | "under"; line: number }, finished: boolean): SelectionState {
  if (line.side === "over" && value > line.line) return { status: "won", reason: `Linha atingida com ${value}.`, value };
  if (line.side === "under" && value > line.line) return { status: "lost", reason: `Linha ultrapassada com ${value}.`, value };
  if (!finished) return { status: "pending", reason: `Em andamento: ${value}.`, value };
  if (value === line.line) return { status: "void", reason: `Linha devolvida em ${value}.`, value };
  return {
    status: line.side === "under" ? "won" : "lost",
    reason: `Resultado final da linha: ${value}.`,
    value,
  };
}

export function selectionNeedsStatistics(selection: WatchedSelection) {
  return ["escanteios", "cartoes", "chutes_gol"].includes(categoryForSelection(selection));
}

export function evaluateWatchedSelection(selection: WatchedSelection, fixture: any, stats: any[] = []): SelectionState {
  const category = categoryForSelection(selection);
  const finished = fixtureIsFinished(fixture);
  const score = fixtureScore(fixture);
  if (score.home === null || score.away === null) return { status: "pending", reason: "Aguardando placar." };
  const totalGoals = score.home + score.away;
  const pick = normalizeText(selection.selection);

  if (category === "mais_menos_gols") {
    const line = parseLine(selection);
    const market = normalizeText(selection.market);
    const gameParts = selection.game.split(/\s+x\s+/i);
    const home = normalizeText(gameParts[0]);
    const away = normalizeText(gameParts[1]);
    const target = (home && market.includes(home)) || market.includes("mandante") || /\bhome\b/.test(market)
      ? score.home
      : (away && market.includes(away)) || market.includes("visitante") || /\baway\b/.test(market)
        ? score.away
        : totalGoals;
    return line ? evaluateLine(target, line, finished) : { status: "review", reason: "Linha nao identificada." };
  }

  if (category === "ambas_marcam") {
    const both = score.home > 0 && score.away > 0;
    const wantsYes = pick.includes("sim") || pick.includes("yes");
    if (wantsYes && both) return { status: "won", reason: `Ambos marcaram (${score.home}-${score.away}).` };
    if (!wantsYes && both) return { status: "lost", reason: `Ambos marcaram (${score.home}-${score.away}).` };
    if (!finished) return { status: "pending", reason: `Placar atual ${score.home}-${score.away}.` };
    return { status: wantsYes ? "lost" : "won", reason: `Resultado final ${score.home}-${score.away}.` };
  }

  if (category === "resultado_final" || category === "dupla_chance") {
    if (!finished) return { status: "pending", reason: `Placar atual ${score.home}-${score.away}.` };
    const parts = selection.game.split(/\s+x\s+/i);
    const home = normalizeText(parts[0]);
    const away = normalizeText(parts[1]);
    const result = score.home > score.away ? "home" : score.away > score.home ? "away" : "draw";
    const includesHome = Boolean(home && pick.includes(home)) || pick.includes("mandante");
    const includesAway = Boolean(away && pick.includes(away)) || pick.includes("visitante");
    const includesDraw = pick.includes("empate") || pick === "x";
    const won = category === "dupla_chance"
      ? (result === "home" && includesHome) || (result === "away" && includesAway) || (result === "draw" && includesDraw)
      : (result === "home" && includesHome) || (result === "away" && includesAway) || (result === "draw" && includesDraw);
    return { status: won ? "won" : "lost", reason: `Resultado final ${score.home}-${score.away}.` };
  }

  if (selectionNeedsStatistics(selection)) {
    const line = parseLine(selection);
    if (!line) return { status: "review", reason: "Linha estatistica nao identificada." };
    const patterns = category === "escanteios"
      ? ["corner"]
      : category === "cartoes"
        ? ["yellow cards", "red cards"]
        : ["shots on goal"];
    const value = statValue(stats, selection, patterns);
    if (value === null) return { status: "pending", reason: "Aguardando estatistica ao vivo." };
    return evaluateLine(value, line, finished);
  }

  return { status: finished ? "review" : "pending", reason: "Mercado sem fechamento automatico." };
}
