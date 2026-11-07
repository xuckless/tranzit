// Community reports ("Crowded", "Delay", …) — real writes to the user DB's
// `route_reports` table plus the middleware's aggregate read endpoints.
//
// Writes go through the generic user-table upsert (POST /api/v1/user/route_reports),
// the same path lib/plannerEvents.ts uses. route_reports is user-owned: the
// middleware requires `user_id` to match the token's `sub`, so we read the id from
// the current Supabase session. report_id is client-generated so a retried POST
// after a dropped response upserts the same row instead of duplicating it.

import * as Crypto from "expo-crypto";
import { middlewareUpsert } from "@/lib/middleware";
import { MIDDLEWARE_URL } from "@/lib/config";
import { authHeader, getCurrentUserId } from "@/lib/supabase";

export type ReportKind = "crowd" | "delay" | "safety" | "vandal" | "cons" | "other";
export type ReportSeverity = 1 | 2 | 3;

export const REPORT_KINDS: readonly ReportKind[] = [
  "crowd",
  "delay",
  "safety",
  "vandal",
  "cons",
  "other",
];

export function isReportKind(v: string): v is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(v);
}

export interface SubmitReportInput {
  kind: ReportKind;
  severity: ReportSeverity;
  routeId?: string | null;
  tripId?: string | null;
  stopId?: string | null;
  lat?: number | null;
  lng?: number | null;
  note?: string | null;
  /** Reuse on retry so a lost response doesn't create a duplicate row. */
  reportId?: string;
}

export interface ReportSummary {
  route_id: string | null;
  minutes: number;
  total: number;
  by_kind: Record<string, number>;
}

export interface RecentReport {
  report_id: string;
  kind: string;
  severity: number;
  route_id: string | null;
  trip_id: string | null;
  stop_id: string | null;
  created_at: string;
}

/**
 * Calgary's GTFS route ids carry a schedule suffix ("3-20800"); alerts, the UI
 * and riders use the short name ("3"). Reports are stored and queried by the
 * short name so a report made before and after the first STATE groups together.
 */
export function reportRouteKey(routeId: string): string {
  return routeId.trim().replace(/-\d+$/, "");
}

export function newReportId(): string {
  return Crypto.randomUUID();
}

/**
 * Upsert one report. Throws on failure (signed out, network, 4xx/5xx) — callers
 * must show the error and offer a retry; there is no optimistic/fake success.
 * Returns the report_id that was written.
 */
export async function submitReport(input: SubmitReportInput): Promise<string> {
  const userId = await getCurrentUserId();
  if (!userId) throw new Error("Sign in to send a report.");

  const reportId = input.reportId ?? newReportId();
  const row: Record<string, unknown> = {
    report_id: reportId,
    user_id: userId,
    kind: input.kind,
    severity: input.severity,
  };
  if (input.routeId) row.route_id = reportRouteKey(input.routeId);
  if (input.tripId) row.trip_id = input.tripId;
  if (input.stopId) row.stop_id = input.stopId;
  if (input.lat != null && input.lng != null) {
    row.lat = input.lat;
    row.lng = input.lng;
  }
  const note = input.note?.trim();
  if (note) row.note = note;

  await middlewareUpsert("route_reports", row);
  return reportId;
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${MIDDLEWARE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: await authHeader() });
  if (!res.ok) throw new Error(`[reports] GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Report counts in the last `minutes` (optionally for one route). */
export async function fetchReportSummary({
  routeId,
  minutes = 60,
}: { routeId?: string | null; minutes?: number } = {}): Promise<ReportSummary> {
  const params: Record<string, string> = { minutes: String(minutes) };
  if (routeId) params.route_id = reportRouteKey(routeId);
  const s = await getJson<Partial<ReportSummary>>("/api/v1/reports/summary", params);
  return {
    route_id: s.route_id ?? null,
    minutes: s.minutes ?? minutes,
    total: s.total ?? 0,
    by_kind: s.by_kind ?? {},
  };
}

/** Most recent reports, newest first (optionally for one route). */
export async function fetchRecentReports({
  routeId,
  limit = 20,
}: { routeId?: string | null; limit?: number } = {}): Promise<RecentReport[]> {
  const params: Record<string, string> = { limit: String(limit) };
  if (routeId) params.route_id = reportRouteKey(routeId);
  const r = await getJson<RecentReport[] | { data?: RecentReport[] }>(
    "/api/v1/reports/recent",
    params,
  );
  return Array.isArray(r) ? r : (r.data ?? []);
}

/**
 * Thank-you line built from the real summary (which already includes the
 * caller's own report). `routeLabel` is e.g. "Route 3".
 */
export function summaryThanksText(summary: ReportSummary, routeLabel?: string | null): string {
  const window = summary.minutes === 60 ? "the last hour" : `the last ${summary.minutes} min`;
  const where = routeLabel ? ` on ${routeLabel}` : "";
  if (summary.total <= 1) return `You're the first to report this${where} in ${window}.`;
  return `Thanks — ${summary.total} riders reported${where} in ${window}.`;
}

