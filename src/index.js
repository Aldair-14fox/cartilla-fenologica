import {
  hashPassword, verifyPassword, createSession, destroySession,
  currentUser, readCookie, sessionCookie, clearCookie, newId,
} from "./auth.js";
import { handleSync, pullSamples } from "./sync.js";
import { buildCSV } from "./csv.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

// Limites de tasa muy simples, en memoria del isolate. No es una defensa
// fuerte (cada isolate cuenta aparte) pero frena el bruteforce trivial de login.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now > rec.reset) {
    attempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}
function clearAttempts(key) {
  attempts.delete(key);
}

function normUsername(v) {
  return String(v || "").trim().toLowerCase();
}

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---- registro ----
  if (path === "/api/register" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const username = normUsername(body.username);
    const password = String(body.password || "");
    const nombre = String(body.nombre || "").trim().slice(0, 120);
    const code = String(body.code || "");

    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return json({ error: "Usuario: 3-32 caracteres (letras, numeros, . _ -)" }, 400);
    }
    if (password.length < 8) {
      return json({ error: "La contrasena debe tener al menos 8 caracteres" }, 400);
    }
    // Si hay REGISTRATION_CODE configurado, se exige. Sin el, cualquiera podria
    // crear cuentas en un despliegue publico.
    if (env.REGISTRATION_CODE && code !== env.REGISTRATION_CODE) {
      return json({ error: "Codigo de registro incorrecto" }, 403);
    }

    const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
      .bind(username).first();
    if (exists) return json({ error: "Ese usuario ya existe" }, 409);

    // El primer usuario del sistema queda como admin.
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
    const role = (countRow && countRow.c) > 0 ? "evaluador" : "admin";

    const id = newId();
    await env.DB.prepare(
      "INSERT INTO users (id,username,nombre,password_hash,role,created_at) VALUES (?,?,?,?,?,?)"
    ).bind(id, username, nombre || username, await hashPassword(password), role, Date.now()).run();

    const token = await createSession(env, id);
    return json(
      { ok: true, user: { username, nombre: nombre || username, role } },
      200,
      { "Set-Cookie": sessionCookie(token) }
    );
  }

  // ---- login ----
  if (path === "/api/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const username = normUsername(body.username);
    const password = String(body.password || "");
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    if (tooManyAttempts(`${ip}:${username}`)) {
      return json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
    }

    const row = await env.DB.prepare(
      "SELECT id, username, nombre, role, password_hash FROM users WHERE username = ?"
    ).bind(username).first();

    // Mismo mensaje para usuario inexistente y clave mala: no filtramos que
    // usuarios existen.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return json({ error: "Usuario o contrasena incorrectos" }, 401);
    }

    clearAttempts(`${ip}:${username}`);
    const token = await createSession(env, row.id);
    return json(
      { ok: true, user: { username: row.username, nombre: row.nombre, role: row.role } },
      200,
      { "Set-Cookie": sessionCookie(token) }
    );
  }

  // ---- logout ----
  if (path === "/api/logout" && method === "POST") {
    await destroySession(env, readCookie(request));
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  // ---- quien soy ----
  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(request, env);
    if (!user) return json({ user: null }, 200);
    return json({ user }, 200);
  }

  // A partir de aqui todo exige sesion.
  const user = await currentUser(request, env);
  if (!user) return json({ error: "No autenticado" }, 401);

  // ---- sync ----
  if (path === "/api/sync" && method === "POST") {
    const { status, data } = await handleSync(request, env, user);
    return json(data, status);
  }

  // ---- export CSV del servidor (todas las muestras del usuario) ----
  if (path === "/api/export.csv" && method === "GET") {
    const samples = (await pullSamples(env, user.id, 0)).filter((s) => !s.deleted);
    const csv = buildCSV(samples);
    return new Response("﻿" + csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cartilla-${user.username}.csv"`,
      },
    });
  }

  // ---- cambiar contrasena ----
  if (path === "/api/password" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const actual = String(body.actual || "");
    const nueva = String(body.nueva || "");
    if (nueva.length < 8) return json({ error: "La nueva contrasena necesita 8+ caracteres" }, 400);
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
      .bind(user.id).first();
    if (!row || !(await verifyPassword(actual, row.password_hash))) {
      return json({ error: "La contrasena actual no coincide" }, 403);
    }
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(nueva), user.id).run();
    return json({ ok: true });
  }

  return json({ error: "Ruta no encontrada" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url);
      } catch (err) {
        console.error("API error", url.pathname, err && err.stack ? err.stack : err);
        return json({ error: "Error interno" }, 500);
      }
    }

    // Todo lo demas lo sirve el binding de assets (PWA estatica).
    return env.ASSETS.fetch(request);
  },
};
