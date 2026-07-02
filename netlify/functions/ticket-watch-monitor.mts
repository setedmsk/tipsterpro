import { fetchWithTimeout, externalServiceError, missingConfig } from "./_shared/http.mts";
import { getPushSubscriptionById, sendPushToSubscription } from "./_shared/push.mts";
import {
  evaluateWatchedSelection,
  fixtureIsFinished,
  fixtureIsLive,
  fixtureScore,
  listActiveTicketWatches,
  saveLiveFixtureSnapshot,
  saveTicketWatch,
  selectionKey,
  selectionNeedsStatistics,
  type TicketWatch,
} from "./_shared/ticket-watch.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const API_BASE = "https://v3.football.api-sports.io";
const TIMEZONE = "America/Sao_Paulo";

function getEnv(name: string) {
  return Netlify.env.get(name) || "";
}

async function apiFootball(path: string, params: Record<string, string | number | undefined>) {
  const key = getEnv("API_FOOTBALL_KEY");
  if (!key) throw missingConfig("API_FOOTBALL_KEY", "API-Football");
  const url = new URL(path, API_BASE);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }
  const response = await fetchWithTimeout(url, {
    headers: { "x-apisports-key": key },
  }, 9000, "API-Football");
  if (!response.ok) throw externalServiceError("API-Football", `HTTP ${response.status}`, response.status === 429 ? 429 : 502);
  const data = await response.json();
  const errors = data?.errors && typeof data.errors === "object"
    ? Object.values(data.errors).flat().filter(Boolean)
    : [];
  if (errors.length) throw externalServiceError("API-Football", errors.join(" | "), 502);
  return data.response || [];
}

function shouldMonitor(watch: TicketWatch, now: number) {
  return watch.ticket.selections.some((selection) => {
    const start = new Date(selection.startsAt || 0).getTime();
    const state = watch.fixtures[String(selection.fixtureId)];
    if (state?.finished) return false;
    if (state?.started) return true;
    if (!Number.isFinite(start)) return false;
    return start <= now + 15 * 60 * 1000 && start >= now - 6 * 60 * 60 * 1000;
  });
}

function fixtureIdOf(fixture: any) {
  return Number(fixture?.fixture?.id || 0);
}

function statusText(fixture: any) {
  return String(fixture?.fixture?.status?.long || fixture?.fixture?.status?.short || "");
}

function gameName(fixture: any, fallback: string) {
  const home = fixture?.teams?.home?.name;
  const away = fixture?.teams?.away?.name;
  return home && away ? `${home} x ${away}` : fallback;
}

function scoreText(fixture: any) {
  const score = fixtureScore(fixture);
  return score.home !== null && score.away !== null ? `${score.home}-${score.away}` : "--";
}

function uniqueFixtureIds(watches: TicketWatch[]) {
  return [...new Set(watches.flatMap((watch) => watch.ticket.selections.map((selection) => selection.fixtureId)))];
}

async function loadLiveFixtures() {
  const fixtures = await apiFootball("/fixtures", { live: "all", timezone: TIMEZONE });
  return new Map(fixtures.map((fixture: any) => [fixtureIdOf(fixture), fixture]));
}

async function loadFinalFixture(fixtureId: number) {
  const fixtures = await apiFootball("/fixtures", { id: fixtureId, timezone: TIMEZONE });
  return fixtures[0] || null;
}

async function loadStatistics(fixtureId: number) {
  try {
    return await apiFootball("/fixtures/statistics", { fixture: fixtureId });
  } catch {
    return [];
  }
}

function notificationUrl(watch: TicketWatch) {
  return `/?acao=acertos&bilhete=${encodeURIComponent(watch.signature)}`;
}

async function processWatch(
  watch: TicketWatch,
  fixtures: Map<number, any>,
  stats: Map<number, any[]>,
) {
  const subscription = await getPushSubscriptionById(watch.subscriptionId);
  const messages: string[] = [];
  const nextFixtures = { ...watch.fixtures };
  const seenFixtures = new Set<number>();

  for (const selection of watch.ticket.selections) {
    const fixtureId = selection.fixtureId;
    const fixture = fixtures.get(fixtureId);
    if (!fixture) continue;
    seenFixtures.add(fixtureId);
    const key = String(fixtureId);
    const previous = nextFixtures[key];
    const live = fixtureIsLive(fixture);
    const started = live || fixtureIsFinished(fixture);
    const finished = fixtureIsFinished(fixture);
    const score = fixtureScore(fixture);
    const previousTotal = previous?.homeGoals !== null && previous?.homeGoals !== undefined &&
      previous?.awayGoals !== null && previous?.awayGoals !== undefined
      ? Number(previous.homeGoals) + Number(previous.awayGoals)
      : null;
    const currentTotal = score.home !== null && score.away !== null ? score.home + score.away : null;

    if (watch.preferences.kickoff && live && !previous?.started) {
      messages.push(`Comecou: ${gameName(fixture, selection.game)}.`);
    }
    if (
      watch.preferences.goals &&
      previousTotal !== null &&
      currentTotal !== null &&
      currentTotal > previousTotal
    ) {
      messages.push(`Gol em ${gameName(fixture, selection.game)}: ${scoreText(fixture)}.`);
    }

    const currentSelection = evaluateWatchedSelection(selection, fixture, stats.get(fixtureId) || []);
    const previousSelection = previous?.selections?.[selectionKey(selection)];
    if (
      watch.preferences.selections &&
      ["won", "lost", "void"].includes(currentSelection.status) &&
      previousSelection?.status !== currentSelection.status
    ) {
      const label = currentSelection.status === "won" ? "bateu" : currentSelection.status === "lost" ? "nao bateu" : "foi anulada";
      messages.push(`${selection.market} - ${selection.selection}: ${label}.`);
    }

    if (watch.preferences.finalResult && finished && !previous?.finished) {
      messages.push(`Final: ${gameName(fixture, selection.game)} ${scoreText(fixture)}.`);
    }

    nextFixtures[key] = {
      started,
      finished,
      homeGoals: score.home,
      awayGoals: score.away,
      status: statusText(fixture),
      updatedAt: new Date().toISOString(),
      selections: {
        ...(previous?.selections || {}),
        [selectionKey(selection)]: currentSelection,
      },
    };
  }

  const fixtureIds = [...new Set(watch.ticket.selections.map((selection) => selection.fixtureId))];
  const allFinished = fixtureIds.length > 0 && fixtureIds.every((id) => nextFixtures[String(id)]?.finished);
  const updated: TicketWatch = {
    ...watch,
    active: !allFinished,
    updatedAt: new Date().toISOString(),
    fixtures: nextFixtures,
  };
  await saveTicketWatch(updated);

  if (subscription && messages.length) {
    const visibleMessages = messages.slice(0, 3);
    if (messages.length > visibleMessages.length) {
      visibleMessages.push(`Mais ${messages.length - visibleMessages.length} atualizacao(oes) no bilhete.`);
    }
    await sendPushToSubscription(subscription, {
      title: allFinished ? "Sete PRO - Bilhete finalizado" : "Sete PRO - Bilhete ao vivo",
      body: visibleMessages.join(" "),
      tag: `sete-pro-watch-${watch.id}`,
      url: notificationUrl(watch),
    }).catch(() => null);
  }

  return { messages: messages.length, finished: allFinished, fixtures: seenFixtures.size };
}

export async function runTicketWatchMonitor() {
  const watches = await listActiveTicketWatches();
  const now = Date.now();
  const due = watches.filter((watch) => shouldMonitor(watch, now)).slice(0, 30);
  if (!due.length) {
    return { ok: true, watches: watches.length, due: 0, apiRequests: 0, reason: "Nenhum sino com jogo ativo." };
  }

  const watchedIds = new Set(uniqueFixtureIds(due).slice(0, 20));
  const live = await loadLiveFixtures();
  let apiRequests = 1;
  const fixtures = new Map<number, any>();
  for (const [id, fixture] of live) {
    if (watchedIds.has(id)) fixtures.set(id, fixture);
  }

  const previouslyStarted = new Set(due.flatMap((watch) => (
    Object.entries(watch.fixtures)
      .filter(([, state]) => state.started && !state.finished)
      .map(([id]) => Number(id))
  )));
  const needsFinalLookup = new Set(previouslyStarted);
  for (const watch of due) {
    for (const selection of watch.ticket.selections) {
      const start = new Date(selection.startsAt || 0).getTime();
      if (Number.isFinite(start) && now > start + 150 * 60 * 1000) {
        needsFinalLookup.add(selection.fixtureId);
      }
    }
  }
  for (const id of [...needsFinalLookup].slice(0, 4)) {
    if (fixtures.has(id)) continue;
    const fixture = await loadFinalFixture(id).catch(() => null);
    apiRequests += 1;
    if (fixture) fixtures.set(id, fixture);
  }

  const stats = new Map<number, any[]>();
  let statisticsRequests = 0;
  for (const id of watchedIds) {
    if (!fixtures.has(id)) continue;
    const needsStats = due.some((watch) => watch.ticket.selections.some((selection) => (
      selection.fixtureId === id && selectionNeedsStatistics(selection)
    )));
    if (!needsStats) continue;
    if (statisticsRequests >= 4) break;
    stats.set(id, await loadStatistics(id));
    apiRequests += 1;
    statisticsRequests += 1;
  }

  for (const [id, fixture] of fixtures) {
    await saveLiveFixtureSnapshot(id, fixture, stats.get(id) || []);
  }

  const processed = [];
  for (const watch of due) {
    processed.push(await processWatch(watch, fixtures, stats));
  }

  return {
    ok: true,
    watches: watches.length,
    due: due.length,
    fixtures: fixtures.size,
    apiRequests,
    notifications: processed.reduce((sum, item) => sum + item.messages, 0),
    finishedWatches: processed.filter((item) => item.finished).length,
  };
}

export default async () => {
  try {
    return Response.json(await runTicketWatchMonitor(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: "Monitor de bilhetes falhou.",
      detail: error?.message || "Erro desconhecido.",
    }, { status: 500 });
  }
};

export const config = {
  schedule: "*/3 * * * *",
};
