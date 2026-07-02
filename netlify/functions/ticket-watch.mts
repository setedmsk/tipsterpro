import { savePushSubscription } from "./_shared/push.mts";
import {
  disableTicketWatch,
  listActiveTicketWatches,
  normalizeWatchedSelection,
  readTicketWatch,
  saveTicketWatch,
  watchIdFor,
  type TicketWatch,
  type WatchPreferences,
} from "./_shared/ticket-watch.mts";

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  });
}

function preferencesFrom(value: any): WatchPreferences {
  return {
    kickoff: value?.kickoff !== false,
    goals: value?.goals !== false,
    finalResult: value?.finalResult !== false,
    selections: true,
  };
}

export default async (req: Request) => {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return json({ error: "Metodo nao permitido" }, { status: 405 });
  }

  try {
    const body = await req.json();
    if (req.method === "DELETE") {
      const watchId = String(body?.watchId || "");
      if (!watchId) return json({ error: "watchId ausente" }, { status: 400 });
      return json({ ok: true, disabled: await disableTicketWatch(watchId) });
    }

    const subscription = body?.subscription;
    const ticket = body?.ticket || {};
    const signature = String(ticket?.signature || body?.signature || "").trim();
    if (!signature) return json({ error: "Bilhete sem assinatura valida." }, { status: 400 });

    const selections = (Array.isArray(ticket?.selections) ? ticket.selections : [])
      .map(normalizeWatchedSelection)
      .filter(Boolean)
      .slice(0, 8);
    if (!selections.length) {
      return json({
        error: "Este bilhete nao possui jogo de futebol com fixtureId para acompanhar.",
      }, { status: 422 });
    }

    const subscriptionId = await savePushSubscription(subscription);
    const id = await watchIdFor(subscriptionId, signature);
    const existing = await readTicketWatch(id);
    if (!existing) {
      const activeForDevice = (await listActiveTicketWatches())
        .filter((watch) => watch.subscriptionId === subscriptionId);
      if (activeForDevice.length >= 10) {
        return json({
          error: "Limite de 10 bilhetes acompanhados neste aparelho atingido.",
        }, { status: 429 });
      }
    }
    const now = new Date();
    const latestStart = selections.reduce((latest, selection: any) => {
      const value = new Date(selection.startsAt || 0).getTime();
      return Number.isFinite(value) ? Math.max(latest, value) : latest;
    }, now.getTime());
    const expiresAt = new Date(Math.max(now.getTime(), latestStart) + 18 * 60 * 60 * 1000).toISOString();

    const watch: TicketWatch = {
      id,
      signature,
      subscriptionId,
      active: true,
      createdAt: existing?.createdAt || now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
      preferences: preferencesFrom(body?.preferences),
      ticket: {
        title: String(ticket?.title || "Bilhete Sete PRO"),
        totalOdd: Number.isFinite(Number(ticket?.totalOdd)) ? Number(ticket.totalOdd) : null,
        possibleReturn: Number.isFinite(Number(ticket?.possibleReturn)) ? Number(ticket.possibleReturn) : null,
        selections: selections as any,
      },
      fixtures: existing?.fixtures || {},
    };

    await saveTicketWatch(watch);
    return json({
      ok: true,
      watchId: id,
      signature,
      monitoredSelections: selections.length,
      monitoredFixtures: new Set(selections.map((selection: any) => selection.fixtureId)).size,
      expiresAt,
    });
  } catch (error: any) {
    return json({
      error: "Nao consegui ativar o acompanhamento deste bilhete.",
      detail: error?.message || "Erro desconhecido.",
    }, { status: 400 });
  }
};

export const config = {
  path: "/api/ticket-watch",
  method: ["POST", "DELETE"],
};
