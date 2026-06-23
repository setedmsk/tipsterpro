import { getStore } from "@netlify/blobs";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const DEFAULT_TIMEZONE = "America/Sao_Paulo";

type ServiceStatus = "ok" | "missing_key" | "warning" | "error";

type ServiceHealth = {
  status: ServiceStatus;
  latency_ms: number | null;
  detail: string;
  optional?: boolean;
  keys?: string[];
  latest?: unknown;
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

function hasAnyEnv(keys: string[]) {
  return keys.some((key) => Boolean(getEnv(key)));
}

function serviceFromKeys(keys: string[], detailOk: string, detailMissing: string, optional = false): ServiceHealth {
  const configured = hasAnyEnv(keys);
  return {
    status: configured ? "ok" : "missing_key",
    latency_ms: null,
    detail: configured ? detailOk : detailMissing,
    optional,
    keys,
  };
}

async function timed<T>(operation: () => Promise<T>) {
  const started = Date.now();
  try {
    const value = await operation();
    return {
      value,
      latency_ms: Date.now() - started,
      error: null as unknown,
    };
  } catch (error) {
    return {
      value: null as T | null,
      latency_ms: Date.now() - started,
      error,
    };
  }
}

async function readBlobJson(storeName: string, key: string) {
  const store = getStore({ name: storeName, consistency: "strong" });
  return await store.get(key, { type: "json" }) as any;
}

function reportSummary(report: any) {
  if (!report || !report.source) return null;
  return {
    date: report.source.date,
    generatedAt: report.source.generatedAt,
    gamesAnalyzed: report.source.gamesAnalyzed,
    picksFound: report.source.picksFound,
    sportsFound: report.source.sportsFound,
  };
}

function errorSummary(error: any) {
  if (!error) return null;
  return {
    date: error.date,
    generatedAt: error.generatedAt,
    message: error.message || error.error || "Erro salvo sem mensagem.",
  };
}

function overallFromRequired(apiFootball: ServiceHealth, openAi: ServiceHealth) {
  const required = [apiFootball, openAi];
  const okCount = required.filter((service) => service.status === "ok").length;
  if (okCount === required.length) return "ok";
  if (okCount === 0) return "down";
  return "degraded";
}

export default async () => {
  const checkedAt = new Date().toISOString();

  const [latestDaily, latestDailyError, latestBasketball, latestVolleyball, latestTennis, latestEsports] = await Promise.all([
    timed(() => readBlobJson("daily-picks", "latest.json")),
    timed(() => readBlobJson("daily-picks", "latest-error.json")),
    timed(() => readBlobJson("daily-basketball-picks", "latest.json")),
    timed(() => readBlobJson("daily-volleyball-picks", "latest.json")),
    timed(() => readBlobJson("daily-tennis-picks", "latest.json")),
    timed(() => readBlobJson("daily-esports-picks", "latest.json")),
  ]);

  const apiFootball = serviceFromKeys(
    ["API_FOOTBALL_KEY"],
    "API-Football configurada. Quota/plano sao validados somente nas chamadas reais.",
    "API_FOOTBALL_KEY ausente."
  );

  const openAi = serviceFromKeys(
    ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    "IA configurada para leitura de print e analise textual.",
    "OPENAI_API_KEY ou Netlify AI Gateway ausente."
  );

  const apiBasketball = serviceFromKeys(
    ["API_BASKETBALL_KEY", "API_SPORTS_KEY", "API_FOOTBALL_KEY"],
    "Basquete configurado por chave especifica ou fallback API-Sports.",
    "API_BASKETBALL_KEY ausente. Pode funcionar se API_SPORTS_KEY ou API_FOOTBALL_KEY liberar Basketball.",
    true
  );

  const apiVolleyball = serviceFromKeys(
    ["API_VOLLEYBALL_KEY", "API_SPORTS_KEY", "API_FOOTBALL_KEY"],
    "Volei configurado por chave especifica ou fallback API-Sports.",
    "API_VOLLEYBALL_KEY ausente. Pode funcionar se API_SPORTS_KEY ou API_FOOTBALL_KEY liberar Volleyball.",
    true
  );

  const esportsOdds = serviceFromKeys(
    ["ESPORTS_ODDS_API_KEY", "ODDS_API_IO_KEY", "SPORTS_ODDS_API_KEY"],
    "Odds-API.io configurada para e-sports.",
    "ODDS_API_IO_KEY ausente. Necessario somente para palpites de e-sports.",
    true
  );

  const tennisOdds = serviceFromKeys(
    ["TENNIS_ODDS_API_KEY", "ODDS_API_IO_KEY", "SPORTS_ODDS_API_KEY"],
    "Odds-API.io configurada para tenis.",
    "ODDS_API_IO_KEY ausente. Necessario somente para palpites de tenis.",
    true
  );

  const blobsOk = !latestDaily.error || latestDaily.value !== null || latestDailyError.value !== null;
  const blobs: ServiceHealth = {
    status: blobsOk ? "ok" : "warning",
    latency_ms: latestDaily.latency_ms,
    detail: blobsOk
      ? "Netlify Blobs acessivel para cache e historico de relatorios."
      : "Nao consegui ler o cache agora. O app ainda pode gerar novos palpites sob demanda.",
    optional: false,
  };

  apiFootball.latest = reportSummary(latestDaily.value);
  apiBasketball.latest = reportSummary(latestBasketball.value);
  apiVolleyball.latest = reportSummary(latestVolleyball.value);
  tennisOdds.latest = reportSummary(latestTennis.value);
  esportsOdds.latest = reportSummary(latestEsports.value);

  const latestPicks = Number((latestDaily.value as any)?.source?.picksFound || 0);
  const hasUsableDailyReport = latestPicks > 0;
  const latestError = errorSummary(latestDailyError.value);
  const overall = overallFromRequired(apiFootball, openAi);

  const services = {
    api_football: apiFootball,
    openai: openAi,
    api_basketball: apiBasketball,
    api_volleyball: apiVolleyball,
    tennis_odds: tennisOdds,
    esports_odds: esportsOdds,
    netlify_blobs: blobs,
  };

  return json({
    overall,
    status: overall,
    checked_at: checkedAt,
    generatedAt: checkedAt,
    timezone: DEFAULT_TIMEZONE,
    services,
    checks: {
      backend: {
        ok: true,
        detail: "Netlify Functions publicadas.",
      },
      apiFootball: {
        ok: apiFootball.status === "ok",
        status: apiFootball.status,
        detail: apiFootball.detail,
        latest: apiFootball.latest,
      },
      visionAi: {
        ok: openAi.status === "ok",
        status: openAi.status,
        detail: openAi.detail,
      },
      basketball: {
        ok: apiBasketball.status === "ok",
        optional: true,
        status: apiBasketball.status,
        detail: apiBasketball.detail,
        latest: apiBasketball.latest,
      },
      volleyball: {
        ok: apiVolleyball.status === "ok",
        optional: true,
        status: apiVolleyball.status,
        detail: apiVolleyball.detail,
        latest: apiVolleyball.latest,
      },
      tennisOdds: {
        ok: tennisOdds.status === "ok",
        optional: true,
        status: tennisOdds.status,
        detail: tennisOdds.detail,
        latest: tennisOdds.latest,
      },
      esportsOdds: {
        ok: esportsOdds.status === "ok",
        optional: true,
        status: esportsOdds.status,
        detail: esportsOdds.detail,
        latest: esportsOdds.latest,
      },
      blobs: {
        ok: blobs.status === "ok",
        status: blobs.status,
        detail: blobs.detail,
        latency_ms: blobs.latency_ms,
      },
      dailyReport: {
        ok: true,
        schedule: "Sob demanda",
        cronUtc: null,
        detail: hasUsableDailyReport
          ? "Relatorio pesado das 07h desativado; palpites sao gerados somente ao clicar nos botoes."
          : "Relatorio pesado das 07h desativado para economizar API. Use os botoes para gerar sob demanda.",
        latest: hasUsableDailyReport ? reportSummary(latestDaily.value) : null,
        latestIgnored: latestDaily.value && !hasUsableDailyReport ? {
          date: (latestDaily.value as any).source?.date,
          generatedAt: (latestDaily.value as any).source?.generatedAt,
          reason: "Cache antigo sem picks foi ignorado pelo modo de palpites.",
        } : null,
        latestError,
      },
    },
  });
};

export const config = {
  path: "/api/health",
  method: ["GET"],
};
