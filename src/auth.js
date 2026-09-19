// Autenticacion: PBKDF2-SHA256 sobre WebCrypto (disponible en Workers).
// Las sesiones viven en D1; la cookie lleva un token aleatorio y la tabla
// guarda solo su hash, asi un dump de la base no permite suplantar a nadie.

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias: el campo no quiere re-login diario
const COOKIE_NAME = "cf_sess";

const enc = new TextEncoder();

function b64(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored).split("$");
    if (scheme !== "pbkdf2") return false;
    const iterations = parseInt(iterStr, 10);
    if (!iterations || iterations > 600000) return false;
    const expected = unb64(hashB64);
    const actual = await pbkdf2(password, unb64(saltB64), iterations);
    if (actual.length !== expected.length) return false;
    // comparacion en tiempo constante
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newId() {
  return [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(env, userId) {
  const token = newId() + newId(); // 256 bits de entropia
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  )
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS)
    .run();
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256Hex(token)).run();
}

export function readCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Devuelve el usuario de la sesion o null. Limpia sesiones vencidas al paso.
export async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  const hashed = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.nombre, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  )
    .bind(hashed)
    .first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(hashed).run();
    return null;
  }
  return { id: row.id, username: row.username, nombre: row.nombre, role: row.role };
}
