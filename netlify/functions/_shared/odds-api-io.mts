import { externalServiceError, fetchWithTimeout } from "./http.mts";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

const ODDS_API_IO_BASE = "https://api.odds-api.io/v3/";
const DEFAULT_TIMEOUT_MS = 9000;

export const ODDS_API_IO_PROVIDER = "Odds-API.io";

export function oddsApiIoKey(keyNames: string[] = []) {
  const names = [...keyNames, "ODDS_API_IO_KEY", "SPORTS_ODDS_API_KEY"];
  for (const name of names) {
    const value = Netlify.env.get(name);
    if (value) return value;
  }
  return "";
}

export function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

export function arrayFromResponse(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  for (const key of ["data", "response", "results", "events", "bookmakers", "odds"]) {
    if (Array.isArray(data[key])) return data[key];
  }

  return Object.values(data).flatMap((value) => Array.isArray(value) ? value : []);
}

function errorDetail(data: any, fallback: string) {
  if (!data) return fallback;
  if (typeof data === "string") return data;
  const error = data.error || data.errors || data.message || data.detail || data;
  if (Array.isArray(error)) return error.join(" | ");
  if (typeof error === "string") return error;
  if (error?.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch {
    return fallback;
  }
}

export async function oddsApiIoFetch(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  key: string,
  label = ODDS_API_IO_PROVIDER,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const url = new URL(path.replace(/^\/+/, ""), ODDS_API_IO_BASE);
  if (key) url.searchParams.set("apiKey", key);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  }

  const response = await fetchWithTimeout(url, {}, timeoutMs, label);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = errorDetail(data, response.statusText || "Erro sem detalhe");
    const status = response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? response.status : 502;
    throw externalServiceError(label, `HTTP ${response.status}: ${detail}`, status);
  }

  if (data?.error || data?.errors) {
    const detail = errorDetail(data, "Erro retornado pelo provider de odds.");
    throw externalServiceError(label, detail, /quota|rate|limit|too many/i.test(detail) ? 429 : 502);
  }

  return data;
}

export function addDays(date: string, days: number) {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function searchedDatesFor(date: string) {
  return [date, addDays(date, 1), addDays(date, 2)];
}

export function localDateFromIso(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {} as Record<string, string>);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function todayInSaoPaulo() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
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

function dateWindow(date: string) {
  return {
    from: new Date(`${date}T00:00:00-03:00`).toISOString(),
    to: new Date(`${addDays(date, 2)}T23:59:59-03:00`).toISOString(),
  };
}

export async function loadSelectedBookmakers(key: string, fallback: string[]) {
  try {
    const data = await oddsApiIoFetch("/bookmakers/selected", {}, key, ODDS_API_IO_PROVIDER, 7000);
    const selected = arrayFromResponse(data)
      .map((item) => String(item?.name || item?.bookmaker || item || "").trim())
      .filter(Boolean);
    return selected.length ? selected.slice(0, 12) : fallback;
  } catch {
    return fallback;
  }
}

export async function loadEventsForSport(key: string, sport: string, date: string, limit = 24) {
  const window = dateWindow(date);
  const data = await oddsApiIoFetch("/events", {
    sport,
    status: "pending,live",
    from: window.from,
    to: window.to,
    limit,
  }, key, ODDS_API_IO_PROVIDER);

  return arrayFromResponse(data);
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function loadOddsForEvents(key: string, eventIds: string[], bookmakers: string[], maxChunks = 3) {
  const results: any[] = [];
  let oddsRequests = 0;

  for (const ids of chunk(eventIds.filter(Boolean), 10).slice(0, maxChunks)) {
    if (!ids.length) continue;
    oddsRequests += 1;
    const data = await oddsApiIoFetch("/odds/multi", {
      eventIds: ids.join(","),
      bookmakers: bookmakers.join(","),
    }, key, ODDS_API_IO_PROVIDER);
    results.push(...arrayFromResponse(data));
  }

  return { odds: results, oddsRequests };
}

export function parseOdd(value: unknown) {
  const odd = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(odd) ? odd : 0;
}

export function eventName(event: any) {
  const home = String(event?.home || event?.teams?.home?.name || event?.participants?.home?.name || "Mandante");
  const away = String(event?.away || event?.teams?.away?.name || event?.participants?.away?.name || "Visitante");
  return `${home} x ${away}`;
}

export function eventLeague(event: any) {
  return String(event?.league?.name || event?.competition?.name || event?.tournament?.name || "Competicao nao informada");
}

export function eventStart(event: any) {
  return String(event?.date || event?.startTime || event?.startsAt || "");
}

export function eventId(event: any) {
  return String(event?.id || event?.eventId || event?.fixtureId || eventName(event));
}

export function isPregameOrLive(event: any) {
  const status = normalizeText(String(event?.status || event?.statusName || ""));
  return !["settled", "ended", "finished", "cancelled", "canceled", "postponed", "abandoned"].some((item) => status.includes(item));
}

export function isAllowedLocalDate(event: any, allowedDates: Set<string>) {
  const localDate = localDateFromIso(eventStart(event));
  return !localDate || allowedDates.has(localDate);
}
