// Sincronizacion offline-first.
//
// Contrato: el cliente manda las muestras que cambiaron desde su ultimo sync
// (con updated_at propio) y el `since` del servidor que ya tiene. El servidor
// resuelve por last-write-wins a nivel de MUESTRA completa: si la version del
// cliente es mas nueva, reemplaza el arbol entero (ramas/brotes/terminales);
// si es mas vieja, se ignora y el cliente recibe la del servidor.
//
// Reemplazar el arbol completo en vez de hacer diff por nodo es deliberado:
// una muestra es pequena (decenas de filas) y el operario edita una a la vez,
// asi se evita toda una clase de bugs de merge parcial.

const MAX_SAMPLES_PER_PUSH = 200;

function str(v) {
  return v == null ? "" : String(v);
}

function intOr(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Valida y normaliza una muestra que llega del cliente.
function normalizeSample(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.id).slice(0, 64);
  if (!id) return null;
  const ramas = Array.isArray(raw.ramas) ? raw.ramas : [];
  return {
    id,
    fundo: str(raw.fundo).slice(0, 200),
    modulo: str(raw.modulo).slice(0, 200),
    lote: str(raw.lote).slice(0, 200),
    valvula: str(raw.valvula).slice(0, 200),
    variedad: str(raw.variedad).slice(0, 200),
    evaluador: str(raw.evaluador).slice(0, 200),
    fecha: str(raw.fecha).slice(0, 32),
    codigo: str(raw.codigo).slice(0, 200),
    created_at: intOr(raw.createdAt ?? raw.created_at, now),
    updated_at: intOr(raw.updatedAt ?? raw.updated_at, now),
    deleted: raw.deleted ? 1 : 0,
    ramas: ramas.slice(0, 500).map((r, ri) => ({
      id: str(r && r.id).slice(0, 64),
      pos: ri,
      altura: str(r && r.altura).slice(0, 32),
      diametro: str(r && r.diametro).slice(0, 32),
      flujo: str(r && r.flujo).slice(0, 32),
      brotes: (Array.isArray(r && r.brotes) ? r.brotes : []).slice(0, 500).map((b, bi) => ({
        id: str(b && b.id).slice(0, 64),
        pos: bi,
        altura: str(b && b.altura).slice(0, 32),
        diametro: str(b && b.diametro).slice(0, 32),
        axilas: str(b && b.axilas).slice(0, 32),
        terminales: (Array.isArray(b && b.terminales) ? b.terminales : []).slice(0, 500).map((t, ti) => ({
          id: str(t && t.id).slice(0, 64),
          pos: ti,
          altura: str(t && t.altura).slice(0, 32),
          diametro: str(t && t.diametro).slice(0, 32),
          axilas: str(t && t.axilas).slice(0, 32),
          flores: str(t && t.flores).slice(0, 32),
          cuajados: str(t && t.cuajados).slice(0, 32),
          verdes: str(t && t.verdes).slice(0, 32),
          envero: str(t && t.envero).slice(0, 32),
          peduncular: str(t && t.peduncular).slice(0, 32),
        })),
      })),
    })),
  };
}

// Escribe una muestra reemplazando su arbol. Devuelve las sentencias para batch().
function writeStatements(env, userId, s) {
  const stmts = [];
  stmts.push(
    env.DB.prepare(
      `INSERT INTO samples (id,user_id,fundo,modulo,lote,valvula,variedad,evaluador,fecha,codigo,created_at,updated_at,deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         fundo=excluded.fundo, modulo=excluded.modulo, lote=excluded.lote,
         valvula=excluded.valvula, variedad=excluded.variedad, evaluador=excluded.evaluador,
         fecha=excluded.fecha, codigo=excluded.codigo, updated_at=excluded.updated_at,
         deleted=excluded.deleted`
    ).bind(
      s.id, userId, s.fundo, s.modulo, s.lote, s.valvula, s.variedad,
      s.evaluador, s.fecha, s.codigo, s.created_at, s.updated_at, s.deleted
    )
  );
  // El arbol se reescribe completo; ON DELETE CASCADE limpia brotes/terminales.
  stmts.push(env.DB.prepare("DELETE FROM ramas WHERE sample_id = ?").bind(s.id));
  if (s.deleted) return stmts;

  for (const r of s.ramas) {
    if (!r.id) continue;
    stmts.push(
      env.DB.prepare(
        "INSERT INTO ramas (id,sample_id,pos,altura,diametro,flujo) VALUES (?,?,?,?,?,?)"
      ).bind(r.id, s.id, r.pos, r.altura, r.diametro, r.flujo)
    );
    for (const b of r.brotes) {
      if (!b.id) continue;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO brotes (id,rama_id,pos,altura,diametro,axilas) VALUES (?,?,?,?,?,?)"
        ).bind(b.id, r.id, b.pos, b.altura, b.diametro, b.axilas)
      );
      for (const t of b.terminales) {
        if (!t.id) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO terminales (id,brote_id,pos,altura,diametro,axilas,flores,cuajados,verdes,envero,peduncular)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            t.id, b.id, t.pos, t.altura, t.diametro, t.axilas,
            t.flores, t.cuajados, t.verdes, t.envero, t.peduncular
          )
        );
      }
    }
  }
  return stmts;
}

// Reconstruye el arbol anidado de las muestras del usuario cambiadas desde `since`.
export async function pullSamples(env, userId, since) {
  const samples = await env.DB.prepare(
    `SELECT * FROM samples WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT 500`
  )
    .bind(userId, since)
    .all();
  const rows = samples.results || [];
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");

  const ramasRes = await env.DB.prepare(
    `SELECT * FROM ramas WHERE sample_id IN (${placeholders}) ORDER BY pos ASC`
  ).bind(...ids).all();
  const ramas = ramasRes.results || [];

  const ramaIds = ramas.map((r) => r.id);
  let brotes = [];
  if (ramaIds.length) {
    const p2 = ramaIds.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT * FROM brotes WHERE rama_id IN (${p2}) ORDER BY pos ASC`
    ).bind(...ramaIds).all();
    brotes = res.results || [];
  }

  const broteIds = brotes.map((b) => b.id);
  let terminales = [];
  if (broteIds.length) {
    const p3 = broteIds.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT * FROM terminales WHERE brote_id IN (${p3}) ORDER BY pos ASC`
    ).bind(...broteIds).all();
    terminales = res.results || [];
  }

  const termsByBrote = new Map();
  for (const t of terminales) {
    if (!termsByBrote.has(t.brote_id)) termsByBrote.set(t.brote_id, []);
    termsByBrote.get(t.brote_id).push({
      id: t.id, altura: t.altura, diametro: t.diametro, axilas: t.axilas,
      flores: t.flores, cuajados: t.cuajados, verdes: t.verdes,
      envero: t.envero, peduncular: t.peduncular,
    });
  }

  const brotesByRama = new Map();
  for (const b of brotes) {
    if (!brotesByRama.has(b.rama_id)) brotesByRama.set(b.rama_id, []);
    brotesByRama.get(b.rama_id).push({
      id: b.id, altura: b.altura, diametro: b.diametro, axilas: b.axilas,
      terminales: termsByBrote.get(b.id) || [],
    });
  }

  const ramasBySample = new Map();
  for (const r of ramas) {
    if (!ramasBySample.has(r.sample_id)) ramasBySample.set(r.sample_id, []);
    ramasBySample.get(r.sample_id).push({
      id: r.id, altura: r.altura, diametro: r.diametro, flujo: r.flujo,
      brotes: brotesByRama.get(r.id) || [],
    });
  }

  return rows.map((s) => ({
    id: s.id,
    fundo: s.fundo, modulo: s.modulo, lote: s.lote, valvula: s.valvula,
    variedad: s.variedad, evaluador: s.evaluador, fecha: s.fecha, codigo: s.codigo,
    createdAt: s.created_at, updatedAt: s.updated_at,
    deleted: s.deleted ? 1 : 0,
    ramas: ramasBySample.get(s.id) || [],
  }));
}

export async function handleSync(request, env, user) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return { status: 400, data: { error: "Cuerpo invalido" } };
  }

  const now = Date.now();
  const since = intOr(body.since, 0);
  const incoming = Array.isArray(body.samples) ? body.samples : [];
  if (incoming.length > MAX_SAMPLES_PER_PUSH) {
    return { status: 413, data: { error: "Demasiadas muestras en un solo envio" } };
  }

  const accepted = [];
  const rejected = [];

  if (incoming.length) {
    const normalized = incoming.map((s) => normalizeSample(s, now)).filter(Boolean);
    const ids = normalized.map((s) => s.id);

    // Version del servidor para decidir quien gana, y de quien es cada muestra.
    const existing = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const res = await env.DB.prepare(
        `SELECT id, user_id, updated_at FROM samples WHERE id IN (${placeholders})`
      ).bind(...ids).all();
      for (const row of res.results || []) existing.set(row.id, row);
    }

    let stmts = [];
    for (const s of normalized) {
      const prev = existing.get(s.id);
      // Una muestra ajena nunca se sobreescribe, aunque el cliente mande su id.
      if (prev && prev.user_id !== user.id) {
        rejected.push({ id: s.id, reason: "ajena" });
        continue;
      }
      if (prev && prev.updated_at >= s.updated_at) {
        rejected.push({ id: s.id, reason: "desactualizada" });
        continue;
      }
      stmts = stmts.concat(writeStatements(env, user.id, s));
      accepted.push(s.id);
    }
    if (stmts.length) await env.DB.batch(stmts);
  }

  // Devolvemos lo que cambio en el servidor, excluyendo lo que acabamos de
  // aceptar de este cliente (ya lo tiene).
  const serverChanges = (await pullSamples(env, user.id, since)).filter(
    (s) => !accepted.includes(s.id)
  );

  return {
    status: 200,
    data: {
      now,
      accepted,
      rejected,
      samples: serverChanges,
      user: { username: user.username, nombre: user.nombre, role: user.role },
    },
  };
}
