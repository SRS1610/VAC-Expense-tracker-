// VAC Expense Tracker — hosts the page and gates the database.
//
//   GET  <function-url>       → serves the ledger page (plain text on *.supabase.co; see README)
//   POST <function-url>/api   → JSON { action, ... }
//        "login"            { username, password }        → { token, user }
//        "logout"           { token }                     → { ok }
//        "change_password"  { token, current, next }      → { ok }
//        "list"             { token }                     → { expenses: [...] }
//        "add"              { token, expense }            → { expense }
//        "delete"           { token, id }                 → { ok }
//
// Accounts live in public.app_users (bcrypt hashes, checked by verify_login()).
// Sessions live in public.app_sessions and last SESSION_DAYS. All data access
// uses the service role key, so every table stays closed to the public keys.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { HTML } from "./page.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SUPABASE_URL}/rest/v1`;
const SESSION_DAYS = 30;

const CATEGORIES = new Set([
  "Veteran assistance", "Program supplies", "Outreach & events", "Office & admin",
  "Travel & mileage", "Rent & utilities", "Software & phone", "Professional services", "Other",
]);
const METHODS = new Set(["Card", "Bank transfer", "Cash", "Check"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${REST}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
}

function rpc(name: string, args: Record<string, unknown>): Promise<Response> {
  return rest(`/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SessionUser = { id: string; username: string; display_name: string };

async function sessionUser(token: unknown): Promise<SessionUser | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const now = encodeURIComponent(new Date().toISOString());
  const r = await rest(`/app_sessions?select=user_id,app_users(id,username,display_name)&token=eq.${token}&expires_at=gt.${now}&limit=1`);
  if (!r.ok) return null;
  const rows = (await r.json()) as { app_users?: SessionUser }[];
  const u = rows[0]?.app_users;
  return u ? { id: u.id, username: u.username, display_name: u.display_name } : null;
}

async function verifyLogin(username: string, password: string): Promise<string | null> {
  const r = await rpc("verify_login", { p_username: username, p_password: password });
  if (!r.ok) return null;
  const id = (await r.json()) as string | null;
  return typeof id === "string" && id ? id : null;
}

function validateExpense(e: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!e || typeof e !== "object") return { ok: false, error: "Missing expense." };
  const x = e as Record<string, unknown>;
  const description = typeof x.description === "string" ? x.description.trim() : "";
  const amount = typeof x.amount === "number" ? Math.round(x.amount * 100) / 100 : NaN;
  const expense_date = typeof x.expense_date === "string" ? x.expense_date : "";
  const category = typeof x.category === "string" ? x.category : "";
  const paid_with = typeof x.paid_with === "string" ? x.paid_with : "";
  const notesRaw = typeof x.notes === "string" ? x.notes.trim() : "";
  if (!description || description.length > 200) return { ok: false, error: "Add a description (up to 200 characters)." };
  if (!(amount > 0) || amount > 1_000_000_000) return { ok: false, error: "Enter an amount above zero." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date) || Number.isNaN(Date.parse(expense_date))) return { ok: false, error: "Pick a valid date." };
  if (!CATEGORIES.has(category)) return { ok: false, error: "Pick a category from the list." };
  if (!METHODS.has(paid_with)) return { ok: false, error: "Pick a payment method from the list." };
  if (notesRaw.length > 300) return { ok: false, error: "Notes must be 300 characters or fewer." };
  return { ok: true, value: { description, amount, expense_date, category, paid_with, notes: notesRaw || null } };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const isApi = /\/api\/?$/.test(url.pathname);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET" && !isApi) {
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  if (req.method !== "POST" || !isApi) return json({ error: "Not found" }, 404);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Send JSON." }, 400); }
  const action = body.action;

  // ----- Sign in -----
  if (action === "login") {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return json({ error: "Enter your username and password." }, 400);
    const userId = await verifyLogin(username, password);
    if (!userId) { await sleep(400); return json({ error: "Wrong username or password." }, 401); }
    const token = randomToken();
    const expires_at = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    const ins = await rest(`/app_sessions`, { method: "POST", body: JSON.stringify({ token, user_id: userId, expires_at }) });
    if (!ins.ok) return json({ error: "Could not start a session." }, 502);
    const ur = await rest(`/app_users?select=username,display_name&id=eq.${userId}&limit=1`);
    const user = ((await ur.json()) as { username: string; display_name: string }[])[0];
    return json({ token, user });
  }

  // ----- Everything else needs a session -----
  const user = await sessionUser(body.token);
  if (!user) return json({ error: "Please sign in again." }, 401);

  if (action === "logout") {
    await rest(`/app_sessions?token=eq.${body.token}`, { method: "DELETE" });
    return json({ ok: true });
  }

  if (action === "change_password") {
    const current = typeof body.current === "string" ? body.current : "";
    const next = typeof body.next === "string" ? body.next : "";
    if (next.length < 8 || next.length > 72) return json({ error: "New password must be 8 to 72 characters." }, 400);
    const ok = await verifyLogin(user.username, current);
    if (ok !== user.id) { await sleep(400); return json({ error: "Current password is not right." }, 401); }
    const r = await rpc("set_password", { p_user_id: user.id, p_password: next });
    if (!r.ok) return json({ error: "Could not change the password." }, 502);
    return json({ ok: true });
  }

  if (action === "list") {
    const r = await rest(`/expenses?select=*&order=expense_date.desc,created_at.desc&limit=5000`);
    if (!r.ok) return json({ error: "Could not read the ledger." }, 502);
    return json({ expenses: await r.json(), user: { username: user.username, display_name: user.display_name } });
  }

  if (action === "add") {
    const v = validateExpense(body.expense);
    if (!v.ok) return json({ error: v.error }, 400);
    const r = await rest(`/expenses`, { method: "POST", body: JSON.stringify({ ...v.value, added_by: user.display_name }) });
    if (!r.ok) return json({ error: "Could not save this expense." }, 502);
    const rows = (await r.json()) as unknown[];
    return json({ expense: rows[0] });
  }

  if (action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bad id." }, 400);
    const r = await rest(`/expenses?id=eq.${id}`, { method: "DELETE" });
    if (!r.ok) return json({ error: "Could not delete this expense." }, 502);
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
