/* Cartilla Fenológica de Campo — cliente PWA offline-first.
 *
 * Principio: la captura NUNCA depende de la red. Todo se escribe en IndexedDB
 * al instante; la sincronización con el Worker es un proceso de fondo que puede
 * fallar sin afectar al operario. Cada muestra lleva `updatedAt` y `dirty`:
 * dirty=1 significa "tiene cambios que el servidor todavía no confirmó".
 */
(function () {
  "use strict";

  var THEMEKEY = "cartilla_theme";
  var LEGACYKEY = "cartilla_fenologia_v1"; // versión localStorage de la cartilla de un solo archivo
  var META = { activeId: "meta_activeId", since: "meta_since", mode: "meta_mode" };

  /* =========================================================================
     IndexedDB — almacén local
     ========================================================================= */
  var DB_NAME = "cartilla";
  var DB_VERSION = 1;
  var idb = null;

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains("samples")) {
          var st = d.createObjectStore("samples", { keyPath: "id" });
          st.createIndex("dirty", "dirty");
          st.createIndex("updatedAt", "updatedAt");
        }
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta", { keyPath: "k" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) {
    return idb.transaction(store, mode).objectStore(store);
  }

  function idbReq(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function putSample(s) { return idbReq(tx("samples", "readwrite").put(s)); }
  function getAllSamples() { return idbReq(tx("samples", "readonly").getAll()); }
  function deleteSampleRow(id) { return idbReq(tx("samples", "readwrite").delete(id)); }
  function metaGet(k) {
    return idbReq(tx("meta", "readonly").get(k)).then(function (r) { return r ? r.v : null; });
  }
  function metaSet(k, v) { return idbReq(tx("meta", "readwrite").put({ k: k, v: v })); }

  /* =========================================================================
     Estado en memoria
     ========================================================================= */
  var db = { samples: [], activeId: null };
  var user = null;          // null = sin sesión
  var mode = null;          // "cloud" | "local" | null (sin decidir)
  var since = 0;            // reloj del último pull aceptado
  var online = navigator.onLine;

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function n(v) { var x = parseFloat(v); return isNaN(x) ? 0 : x; }
  function esc(s) {
    s = (s == null ? "" : String(s));
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function activeSample() {
    return db.samples.find(function (s) { return s.id === db.activeId; }) || null;
  }
  function findRama(s, rid) { return s.ramas.find(function (r) { return r.id === rid; }); }
  function findBrote(r, bid) { return r.brotes.find(function (b) { return b.id === bid; }); }
  function findTerminal(b, tid) { return b.terminales.find(function (t) { return t.id === tid; }); }

  function visibleSamples() {
    return db.samples.filter(function (s) { return !s.deleted; });
  }

  /* =========================================================================
     Persistencia local (debounced) + estado del chip
     ========================================================================= */
  var saveTimer = null;
  var pendingIds = Object.create(null);

  // Marca la muestra como modificada localmente y agenda su escritura.
  function touch(s) {
    if (!s) return;
    s.updatedAt = Date.now();
    s.dirty = 1;
    pendingIds[s.id] = true;
    scheduleSave();
  }

  function scheduleSave() {
    setSaveState("saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 350);
  }

  function flushSave() {
    var ids = Object.keys(pendingIds);
    pendingIds = Object.create(null);
    var writes = ids.map(function (id) {
      var s = db.samples.find(function (x) { return x.id === id; });
      return s ? putSample(s) : deleteSampleRow(id);
    });
    return Promise.all(writes).then(
      function () {
        setSaveState("saved");
        // Solo vale la pena sincronizar si de verdad quedo algo por subir.
        // El propio sync marca pendingIds para persistir el dirty=0 que acaba
        // de confirmar el servidor; si eso volviera a disparar un sync, cada
        // ronda agendaria la siguiente y la app quedaria en bucle.
        if (dirtyCount()) scheduleSync();
      },
      function () { setSaveState("error"); }
    );
  }

  function dirtyCount() {
    return db.samples.filter(function (s) { return s.dirty; }).length;
  }

  function setSaveState(s) {
    var chip = document.getElementById("savechip");
    var txt = document.getElementById("savetxt");
    var dot = chip && chip.querySelector(".dot");
    if (!chip || !txt || !dot) return;
    chip.classList.toggle("saving", s === "saving");
    dot.classList.remove("offline", "pending");

    if (s === "saving") { txt.textContent = "Guardando…"; return; }
    if (s === "error") { txt.textContent = "Sin guardar"; return; }
    if (s === "syncing") { txt.textContent = "Sincronizando…"; return; }

    var pend = dirtyCount();
    if (mode === "local" || !user) {
      txt.textContent = "En el equipo";
      dot.classList.add("offline");
    } else if (!online) {
      txt.textContent = pend ? pend + " por subir" : "Sin conexión";
      dot.classList.add("offline");
    } else if (pend) {
      txt.textContent = pend + " por subir";
      dot.classList.add("pending");
    } else {
      txt.textContent = "Sincronizado";
    }
  }

  /* =========================================================================
     Fábricas
     ========================================================================= */
  function newTerminal() {
    return { id: uid(), altura: "", diametro: "", axilas: "", flores: "", cuajados: "", verdes: "", envero: "", peduncular: "" };
  }
  function newBrote() { return { id: uid(), altura: "", diametro: "", axilas: "", terminales: [] }; }
  function newRama() { return { id: uid(), altura: "", diametro: "", flujo: "", brotes: [] }; }

  /* =========================================================================
     API
     ========================================================================= */
  function api(path, options) {
    options = options || {};
    return fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || "Error " + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* =========================================================================
     Sincronización
     ========================================================================= */
  var syncTimer = null;
  var syncing = false;

  function scheduleSync(delay) {
    if (mode !== "cloud" || !user || !online) { setSaveState("saved"); return; }
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, delay == null ? 1200 : delay);
  }

  // Serializa una muestra para el servidor: sin campos de UI ni de control local.
  function forWire(s) {
    var strip = function (o, keys) {
      var out = {};
      keys.forEach(function (k) { out[k] = o[k]; });
      return out;
    };
    return {
      id: s.id, fundo: s.fundo, modulo: s.modulo, lote: s.lote, valvula: s.valvula,
      variedad: s.variedad, evaluador: s.evaluador, fecha: s.fecha, codigo: s.codigo,
      createdAt: s.createdAt, updatedAt: s.updatedAt, deleted: s.deleted ? 1 : 0,
      ramas: (s.ramas || []).map(function (r) {
        var ro = strip(r, ["id", "altura", "diametro", "flujo"]);
        ro.brotes = (r.brotes || []).map(function (b) {
          var bo = strip(b, ["id", "altura", "diametro", "axilas"]);
          bo.terminales = (b.terminales || []).map(function (t) {
            return strip(t, ["id", "altura", "diametro", "axilas", "flores", "cuajados", "verdes", "envero", "peduncular"]);
          });
          return bo;
        });
        return ro;
      }),
    };
  }

  function doSync(opts) {
    opts = opts || {};
    if (syncing || mode !== "cloud" || !user) return Promise.resolve();
    if (!online && !opts.force) return Promise.resolve();

    syncing = true;
    var btn = document.getElementById("syncBtn");
    // El sync de fondo es silencioso: cambiar el texto del chip en cada ronda
    // hacia parpadear la barra superior. Solo se avisa si el operario lo pidio.
    if (opts.manual) {
      if (btn) btn.classList.add("spin");
      setSaveState("syncing");
    }

    // Snapshot de lo sucio: si el operario sigue escribiendo durante el sync,
    // esas ediciones quedan con updatedAt mayor y se suben en la próxima ronda.
    var outbox = db.samples.filter(function (s) { return s.dirty; });
    var snapshot = outbox.map(function (s) {
      return { id: s.id, updatedAt: s.updatedAt, wire: forWire(s) };
    });

    return api("/api/sync", {
      method: "POST",
      body: { since: since, samples: snapshot.map(function (x) { return x.wire; }) },
    })
      .then(function (res) {
        // Limpia dirty solo si la muestra no cambió durante el viaje de red.
        (res.accepted || []).forEach(function (id) {
          var snap = snapshot.find(function (x) { return x.id === id; });
          var live = db.samples.find(function (x) { return x.id === id; });
          if (live && snap && live.updatedAt === snap.updatedAt) {
            live.dirty = 0;
            pendingIds[id] = true;
          }
        });

        // Una muestra rechazada por desactualizada llega en res.samples con la
        // versión buena; el rechazo en sí no requiere acción extra.
        (res.rejected || []).forEach(function (r) {
          if (r.reason === "ajena") {
            var live = db.samples.find(function (x) { return x.id === r.id; });
            if (live) { live.dirty = 0; pendingIds[r.id] = true; }
          }
        });

        // Aplica cambios del servidor (otros dispositivos).
        var cambios = 0;
        (res.samples || []).forEach(function (rs) {
          var local = db.samples.find(function (x) { return x.id === rs.id; });
          if (local && local.dirty && local.updatedAt > rs.updatedAt) return; // lo nuestro es más nuevo
          var merged = fromWire(rs);
          if (local) {
            // Conserva el estado de plegado de la UI para no desorientar al operario.
            copyCollapsed(local, merged);
            var i = db.samples.indexOf(local);
            db.samples[i] = merged;
          } else {
            db.samples.push(merged);
          }
          pendingIds[merged.id] = true;
          cambios++;
        });

        if (typeof res.now === "number") {
          since = res.now;
          metaSet(META.since, since);
        }
        if (res.user) { user = res.user; }

        return flushSave().then(function () { return cambios; });
      })
      .then(function (cambios) {
        // Redibujar sin cambios reales hace saltar la pantalla y, si el operario
        // esta escribiendo, le quita el foco del campo a media cifra.
        if (!cambios) {
          setSaveState("saved");
          renderSyncBadges();
          return;
        }
        // Hay novedades de otro equipo, pero si esta escribiendo no le movemos
        // el árbol bajo los dedos: se redibuja al soltar el campo.
        var enFoco = document.activeElement;
        if (enFoco && enFoco.tagName === "INPUT" && enFoco.closest("#tree")) {
          enFoco.addEventListener("blur", function alRedibujar() {
            enFoco.removeEventListener("blur", alRedibujar);
            render();
          });
          setSaveState("saved");
          return;
        }
        render();
      })
      .catch(function (err) {
        if (err.status === 401) {
          // La sesión expiró: seguimos capturando en local sin perder nada.
          user = null;
          setSaveState("saved");
          toast("Sesión expirada, vuelve a entrar");
          render();
        } else {
          setSaveState("saved");
          if (opts.manual) toast("No se pudo sincronizar: " + err.message);
        }
      })
      .then(function () {
        syncing = false;
        // Un sync sin nada que subir termina en decenas de ms: si quitamos la
        // marca al instante, el operario que pulso el boton no llega a ver nada
        // y no sabe si hizo algo. La dejamos un momento visible.
        if (btn && btn.classList.contains("spin")) {
          setTimeout(function () { btn.classList.remove("spin"); }, 600);
        }
      });
  }

  function fromWire(rs) {
    return {
      id: rs.id, fundo: rs.fundo || "", modulo: rs.modulo || "", lote: rs.lote || "",
      valvula: rs.valvula || "", variedad: rs.variedad || "", evaluador: rs.evaluador || "",
      fecha: rs.fecha || "", codigo: rs.codigo || "",
      createdAt: rs.createdAt || Date.now(), updatedAt: rs.updatedAt || Date.now(),
      deleted: rs.deleted ? 1 : 0, dirty: 0,
      ramas: (rs.ramas || []).map(function (r) {
        return {
          id: r.id, altura: r.altura || "", diametro: r.diametro || "", flujo: r.flujo || "",
          brotes: (r.brotes || []).map(function (b) {
            return {
              id: b.id, altura: b.altura || "", diametro: b.diametro || "", axilas: b.axilas || "",
              terminales: (b.terminales || []).map(function (t) {
                return {
                  id: t.id, altura: t.altura || "", diametro: t.diametro || "", axilas: t.axilas || "",
                  flores: t.flores || "", cuajados: t.cuajados || "", verdes: t.verdes || "",
                  envero: t.envero || "", peduncular: t.peduncular || "",
                };
              }),
            };
          }),
        };
      }),
    };
  }

  function copyCollapsed(from, to) {
    var flags = Object.create(null);
    (from.ramas || []).forEach(function (r) {
      flags[r.id] = r._collapsed;
      (r.brotes || []).forEach(function (b) {
        flags[b.id] = b._collapsed;
        (b.terminales || []).forEach(function (t) { flags[t.id] = t._collapsed; });
      });
    });
    (to.ramas || []).forEach(function (r) {
      if (flags[r.id]) r._collapsed = true;
      (r.brotes || []).forEach(function (b) {
        if (flags[b.id]) b._collapsed = true;
        (b.terminales || []).forEach(function (t) { if (flags[t.id]) t._collapsed = true; });
      });
    });
  }

  /* =========================================================================
     Render
     ========================================================================= */
  function render() {
    var auth = document.getElementById("screen-auth");
    var reg = document.getElementById("screen-registro");
    var frm = document.getElementById("screen-formulario");
    var bar = document.getElementById("bottombar");
    var syncBtn = document.getElementById("syncBtn");

    if (syncBtn) syncBtn.hidden = !(mode === "cloud" && user);
    document.getElementById("offlineStrip").hidden = online || mode === "local";

    // Sin decisión de modo todavía → pantalla de acceso.
    if (!mode || (mode === "cloud" && !user)) {
      auth.hidden = false; reg.hidden = true; frm.hidden = true; bar.hidden = true;
      return;
    }
    auth.hidden = true;

    var s = activeSample();
    if (!s || s.deleted) {
      reg.hidden = false; frm.hidden = true; bar.hidden = true;
      renderSavedList();
      setSaveState("saved");
      return;
    }
    reg.hidden = true; frm.hidden = false; bar.hidden = false;
    renderContext(s);
    renderTree(s);
    renderTotals(s);
    setSaveState("saved");
  }

  function renderContext(s) {
    var c = document.getElementById("ctx");
    function chip(l, v) { return v ? '<span class="chip"><b>' + l + "</b>" + esc(v) + "</span>" : ""; }
    c.innerHTML =
      chip("Fundo", s.fundo) + chip("Módulo", s.modulo) + chip("Lote", s.lote) +
      chip("Válvula", s.valvula) + chip("Variedad", s.variedad) +
      (s.codigo ? chip("Planta", s.codigo) : "") + chip("Fecha", s.fecha) +
      (s.evaluador ? chip("Eval.", s.evaluador) : "");
  }

  function renderTree(s) {
    var host = document.getElementById("tree");
    if (!s.ramas.length) {
      host.innerHTML = '<p class="empty">Aún no hay ramas. Toca “Agregar rama” para empezar.</p>';
      return;
    }
    host.innerHTML = s.ramas.map(function (r, ri) { return ramaHTML(r, ri); }).join("");
  }

  function numField(label, unit, kind, ids, val, fmode) {
    var im = fmode === "dec" ? 'inputmode="decimal"' : 'inputmode="numeric"';
    var u = unit ? ' <span class="u">' + unit + "</span>" : "";
    return '<label class="field"><span class="lab">' + label + u + "</span>" +
      '<input class="num" ' + im + ' data-kind="' + kind + '" ' + ids + ' value="' + esc(val) + '"></label>';
  }

  function ramaHTML(r, ri) {
    var col = r._collapsed ? " collapsed" : "";
    var body =
      '<div class="grid three">' +
        numField("Altura", "cm", "rama.altura", 'data-r="' + r.id + '"', r.altura, "dec") +
        numField("Diámetro", "mm", "rama.diametro", 'data-r="' + r.id + '"', r.diametro, "dec") +
        '<label class="field"><span class="lab">Flujo <span class="u">n°</span></span>' +
          '<input class="num" inputmode="numeric" data-kind="rama.flujo" data-r="' + r.id + '" value="' + esc(r.flujo) + '"></label>' +
      "</div>" +
      '<div class="subhead brote-lbl"><span class="lbl">Brotes</span><span class="rule"></span><span class="cnt">' + r.brotes.length + "</span></div>" +
      (r.brotes.length ? r.brotes.map(function (b, bi) { return broteHTML(r, b, bi); }).join("")
        : '<p class="empty">Sin brotes en esta rama.</p>') +
      '<button class="addbtn brote-add" data-add="brote" data-r="' + r.id + '">' + plus() + "Agregar brote</button>";
    return '<div class="node rama' + col + '" data-node="rama" data-r="' + r.id + '">' +
      '<div class="head" data-toggle="' + r.id + '">' +
        '<span class="num">R' + (ri + 1) + "</span>" +
        '<span class="ttl">Rama ' + (ri + 1) + "</span>" +
        '<span class="meta">' + r.brotes.length + " brote" + (r.brotes.length === 1 ? "" : "s") + "</span>" +
        caret() +
        '<button class="del" data-del="rama" data-r="' + r.id + '" title="Eliminar rama" aria-label="Eliminar rama">' + trash() + "</button>" +
      "</div>" +
      '<div class="body">' + body + "</div>" +
    "</div>";
  }

  function broteHTML(r, b, bi) {
    var col = b._collapsed ? " collapsed" : "";
    var ids = 'data-r="' + r.id + '" data-b="' + b.id + '"';
    var body =
      '<div class="grid three">' +
        numField("Altura", "cm", "brote.altura", ids, b.altura, "dec") +
        numField("Diámetro", "mm", "brote.diametro", ids, b.diametro, "dec") +
        numField("Axilas act.", "", "brote.axilas", ids, b.axilas, "num") +
      "</div>" +
      '<div class="subhead terminal-lbl"><span class="lbl">Terminales</span><span class="rule"></span><span class="cnt">' + b.terminales.length + "</span></div>" +
      (b.terminales.length ? b.terminales.map(function (t, ti) { return terminalHTML(r, b, t, ti); }).join("")
        : '<p class="empty">Sin terminales en este brote.</p>') +
      '<button class="addbtn terminal-add" data-add="terminal" data-r="' + r.id + '" data-b="' + b.id + '">' + plus() + "Agregar terminal</button>";
    return '<div class="node brote' + col + '" data-node="brote" data-b="' + b.id + '">' +
      '<div class="head" data-toggle="' + b.id + '">' +
        '<span class="num">B' + (bi + 1) + "</span>" +
        '<span class="ttl">Brote ' + (bi + 1) + "</span>" +
        '<span class="meta">' + b.terminales.length + " term.</span>" +
        caret() +
        '<button class="del" data-del="brote" data-r="' + r.id + '" data-b="' + b.id + '" title="Eliminar brote" aria-label="Eliminar brote">' + trash() + "</button>" +
      "</div>" +
      '<div class="body">' + body + "</div>" +
    "</div>";
  }

  function terminalHTML(r, b, t, ti) {
    var col = t._collapsed ? " collapsed" : "";
    var flores = n(t.flores), cuaj = n(t.cuajados);
    var cuaje = flores > 0 ? Math.round((cuaj / flores) * 100) : null;
    var ids = 'data-r="' + r.id + '" data-b="' + b.id + '" data-t="' + t.id + '"';
    var body =
      '<div class="grid three">' +
        numField("Altura", "cm", "term.altura", ids, t.altura, "dec") +
        numField("Diámetro", "mm", "term.diametro", ids, t.diametro, "dec") +
        numField("Axilas act.", "", "term.axilas", ids, t.axilas, "num") +
      "</div>" +
      '<div class="grid three" style="margin-top:12px">' +
        numField("Flores", "total", "term.flores", ids, t.flores, "num") +
        numField("Cuajados", "", "term.cuajados", ids, t.cuajados, "num") +
        numField("Verdes", "", "term.verdes", ids, t.verdes, "num") +
        numField("Envero", "", "term.envero", ids, t.envero, "num") +
        numField("Pedúnculos", "total", "term.peduncular", ids, t.peduncular, "num") +
      "</div>" +
      '<div class="qc">' +
        '<span class="q">Flores <b>' + flores + "</b></span>" +
        '<span class="q">Cuajados <b>' + cuaj + "</b></span>" +
        (cuaje != null ? '<span class="q cuaje">Cuaje <b>' + cuaje + "%</b></span>" : "") +
      "</div>";
    return '<div class="node terminal' + col + '" data-node="terminal" data-t="' + t.id + '">' +
      '<div class="head" data-toggle="' + t.id + '">' +
        '<span class="num">T' + (ti + 1) + "</span>" +
        '<span class="ttl">Terminal ' + (ti + 1) + "</span>" +
        '<span class="meta">' + flores + " fl.</span>" +
        caret() +
        '<button class="del" data-del="terminal" data-r="' + r.id + '" data-b="' + b.id + '" data-t="' + t.id + '" title="Eliminar terminal" aria-label="Eliminar terminal">' + trash() + "</button>" +
      "</div>" +
      '<div class="body">' + body + "</div>" +
    "</div>";
  }

  function plus() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'; }
  function caret() { return '<svg class="caret" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'; }
  function trash() { return '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>'; }

  /* =========================================================================
     Totales
     ========================================================================= */
  function tally(s) {
    var t = { ramas: s.ramas.length, brotes: 0, terminales: 0, flores: 0, cuajados: 0, verdes: 0, envero: 0, peduncular: 0 };
    s.ramas.forEach(function (r) {
      t.brotes += r.brotes.length;
      r.brotes.forEach(function (b) {
        t.terminales += b.terminales.length;
        b.terminales.forEach(function (x) {
          t.flores += n(x.flores); t.cuajados += n(x.cuajados); t.verdes += n(x.verdes);
          t.envero += n(x.envero); t.peduncular += n(x.peduncular);
        });
      });
    });
    return t;
  }

  function renderTotals(s) {
    var t = tally(s);
    var cuaje = t.flores > 0 ? Math.round((t.cuajados / t.flores) * 100) + "%" : "–";
    document.getElementById("totals").innerHTML =
      '<span class="t">Ramas <b>' + t.ramas + "</b></span>" +
      '<span class="t">Brotes <b>' + t.brotes + "</b></span>" +
      '<span class="t">Term. <b>' + t.terminales + "</b></span>" +
      '<span class="t">Flores <b>' + t.flores + "</b></span>" +
      '<span class="t">Cuaje <b>' + cuaje + "</b></span>";
  }

  // Actualiza solo las etiquetas de respaldo de la lista, sin rehacer el DOM.
  // Se usa tras un sync sin novedades: refresca el estado visible sin que la
  // pantalla salte ni se pierda el foco de un campo.
  function renderSyncBadges() {
    if (mode !== "cloud") return;
    db.samples.forEach(function (s) {
      var row = document.querySelector('.srow [data-open="' + s.id + '"]');
      var badge = row && row.parentNode.querySelector(".sync");
      if (!badge) return;
      badge.className = "sync " + (s.dirty ? "wait" : "up");
      badge.textContent = s.dirty ? "por subir" : "✓";
      badge.title = s.dirty ? "Pendiente de subir" : "Respaldado en el servidor";
    });
  }

  function renderSavedList() {
    var host = document.getElementById("saved-list");
    var list = visibleSamples();
    if (!list.length) { host.innerHTML = ""; return; }
    var rows = list.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
      .map(function (s) {
        var t = tally(s);
        var title = [s.fundo, s.lote, s.variedad].filter(Boolean).join(" · ") || "Muestra sin identificar";
        var sub = (s.fecha || "") + " · " + t.ramas + "R / " + t.brotes + "B / " + t.terminales + "T";
        var badge = "";
        if (mode === "cloud") {
          badge = s.dirty
            ? '<span class="sync wait" title="Pendiente de subir">por subir</span>'
            : '<span class="sync up" title="Respaldado en el servidor">✓</span>';
        }
        return '<div class="srow">' +
          '<div class="info"><div class="t">' + esc(title) + '</div><div class="s">' + esc(sub) + "</div></div>" +
          badge +
          '<button class="open" data-open="' + s.id + '">Abrir</button>' +
          '<button class="del" data-delsample="' + s.id + '" title="Eliminar muestra" aria-label="Eliminar muestra">' + trash() + "</button>" +
        "</div>";
      }).join("");
    host.innerHTML = "<h3>Muestras guardadas (" + list.length + ")</h3>" + rows;
  }

  /* =========================================================================
     Eventos: inputs
     ========================================================================= */
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (el.tagName !== "INPUT" && el.tagName !== "SELECT") return;
    var kind = el.getAttribute("data-kind");
    if (!kind) return;
    var s = activeSample(); if (!s) return;
    var r = el.getAttribute("data-r"), b = el.getAttribute("data-b"), tt = el.getAttribute("data-t");
    var ra = r ? findRama(s, r) : null;
    var br = (ra && b) ? findBrote(ra, b) : null;
    var te = (br && tt) ? findTerminal(br, tt) : null;
    var v = el.value;
    var f = kind.split(".")[1];
    if (kind.indexOf("rama.") === 0 && ra) ra[f] = v;
    else if (kind.indexOf("brote.") === 0 && br) br[f] = v;
    else if (kind.indexOf("term.") === 0 && te) te[f] = v;
    touch(s);
    if (kind.indexOf("term.") === 0 && te) updateTerminalQC(te);
    renderTotals(s);
  });

  function updateTerminalQC(t) {
    var node = document.querySelector('.node.terminal[data-t="' + t.id + '"]');
    if (!node) return;
    var flores = n(t.flores), cuaj = n(t.cuajados);
    var cuaje = flores > 0 ? Math.round((cuaj / flores) * 100) : null;
    var qc = node.querySelector(".qc");
    if (qc) {
      qc.innerHTML = '<span class="q">Flores <b>' + flores + "</b></span>" +
        '<span class="q">Cuajados <b>' + cuaj + "</b></span>" +
        (cuaje != null ? '<span class="q cuaje">Cuaje <b>' + cuaje + "%</b></span>" : "");
    }
    var meta = node.querySelector(".head .meta");
    if (meta) meta.textContent = flores + " fl.";
  }

  /* =========================================================================
     Eventos: clicks del árbol y de la lista
     ========================================================================= */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-add],[data-del],[data-toggle],[data-open],[data-delsample]");
    if (!t) return;
    var s = activeSample();

    if (t.hasAttribute("data-toggle")) {
      if (e.target.closest(".del")) return;
      var id = t.getAttribute("data-toggle");
      var node = t.closest(".node");
      var obj = nodeById(s, id);
      // El plegado es estado de UI: no marca la muestra como modificada.
      if (obj) { obj._collapsed = !obj._collapsed; node.classList.toggle("collapsed", !!obj._collapsed); }
      return;
    }

    if (t.hasAttribute("data-add")) {
      var kind = t.getAttribute("data-add");
      var r = t.getAttribute("data-r"), b = t.getAttribute("data-b");
      if (kind === "brote") { var ra = findRama(s, r); if (ra) ra.brotes.push(newBrote()); }
      if (kind === "terminal") {
        var ra2 = findRama(s, r), br = ra2 && findBrote(ra2, b);
        if (br) br.terminales.push(newTerminal());
      }
      touch(s); render(); focusLastAdded(kind, r, b);
      return;
    }

    if (t.hasAttribute("data-del")) {
      if (!armDelete(t)) return;
      var kd = t.getAttribute("data-del");
      var rr = t.getAttribute("data-r"), bb = t.getAttribute("data-b"), tc = t.getAttribute("data-t");
      if (kd === "rama") s.ramas = s.ramas.filter(function (x) { return x.id !== rr; });
      if (kd === "brote") { var ra3 = findRama(s, rr); if (ra3) ra3.brotes = ra3.brotes.filter(function (x) { return x.id !== bb; }); }
      if (kd === "terminal") {
        var ra4 = findRama(s, rr), br2 = ra4 && findBrote(ra4, bb);
        if (br2) br2.terminales = br2.terminales.filter(function (x) { return x.id !== tc; });
      }
      touch(s); render();
      return;
    }

    if (t.hasAttribute("data-open")) {
      db.activeId = t.getAttribute("data-open");
      metaSet(META.activeId, db.activeId);
      render(); window.scrollTo(0, 0);
      return;
    }

    if (t.hasAttribute("data-delsample")) {
      if (!armDelete(t)) return;
      var idd = t.getAttribute("data-delsample");
      var target = db.samples.find(function (x) { return x.id === idd; });
      if (target) {
        // Borrado lógico: el servidor necesita enterarse para borrarlo en los
        // demás dispositivos. Si nunca se subió, se elimina de una vez.
        if (mode === "cloud" && !target.dirtyNew) {
          target.deleted = 1;
          target.ramas = [];
          touch(target);
        } else {
          db.samples = db.samples.filter(function (x) { return x.id !== idd; });
          pendingIds[idd] = true;
          scheduleSave();
        }
      }
      if (db.activeId === idd) { db.activeId = null; metaSet(META.activeId, null); }
      render();
      return;
    }
  });

  // Los botones de borrar exigen dos toques: un guante en el campo roza cualquier cosa.
  function armDelete(t) {
    if (t.classList.contains("armed")) return true;
    document.querySelectorAll(".del.armed").forEach(function (d) {
      d.classList.remove("armed"); d.innerHTML = trash();
    });
    t.classList.add("armed");
    t.textContent = "Eliminar";
    setTimeout(function () {
      if (t.classList.contains("armed")) { t.classList.remove("armed"); t.innerHTML = trash(); }
    }, 2600);
    return false;
  }

  function nodeById(s, id) {
    if (!s) return null;
    for (var i = 0; i < s.ramas.length; i++) {
      var r = s.ramas[i]; if (r.id === id) return r;
      for (var j = 0; j < r.brotes.length; j++) {
        var b = r.brotes[j]; if (b.id === id) return b;
        for (var k = 0; k < b.terminales.length; k++) {
          if (b.terminales[k].id === id) return b.terminales[k];
        }
      }
    }
    return null;
  }

  function focusLastAdded(kind, r, b) {
    var sel, s = activeSample();
    if (!s) return;
    if (kind === "brote") {
      var ra = findRama(s, r); if (!ra) return;
      var nb = ra.brotes[ra.brotes.length - 1];
      sel = '.node.brote[data-b="' + nb.id + '"]';
    } else if (kind === "terminal") {
      var ra2 = findRama(s, r), br = ra2 && findBrote(ra2, b); if (!br) return;
      var nt = br.terminales[br.terminales.length - 1];
      sel = '.node.terminal[data-t="' + nt.id + '"]';
    } else return;
    var node = document.querySelector(sel);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      var inp = node.querySelector("input");
      if (inp) setTimeout(function () { inp.focus(); }, 250);
    }
  }

  document.getElementById("add-rama").addEventListener("click", function () {
    var s = activeSample(); if (!s) return;
    s.ramas.push(newRama());
    touch(s); render();
    var last = s.ramas[s.ramas.length - 1];
    var node = document.querySelector('.node.rama[data-r="' + last.id + '"]');
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      var inp = node.querySelector("input");
      if (inp) setTimeout(function () { inp.focus(); }, 250);
    }
  });

  /* =========================================================================
     Registro de muestra
     ========================================================================= */
  document.getElementById("form-muestra").addEventListener("submit", function (e) {
    e.preventDefault();
    var g = function (id) { return document.getElementById(id).value.trim(); };
    var now = Date.now();
    var s = {
      id: uid(), createdAt: now, updatedAt: now, dirty: 1, deleted: 0,
      fundo: g("m-fundo"), modulo: g("m-modulo"), lote: g("m-lote"), valvula: g("m-valvula"),
      variedad: g("m-variedad"), evaluador: g("m-evaluador") || (user && user.nombre) || "",
      fecha: g("m-fecha"), codigo: g("m-codigo"),
      ramas: [],
    };
    db.samples.push(s);
    db.activeId = s.id;
    metaSet(META.activeId, s.id);
    pendingIds[s.id] = true;
    scheduleSave();
    this.reset(); setDefaultDate(); prefillEvaluador();
    render(); window.scrollTo(0, 0);
  });

  document.getElementById("backBtn").addEventListener("click", function () {
    db.activeId = null;
    metaSet(META.activeId, null);
    render(); window.scrollTo(0, 0);
  });

  function setDefaultDate() {
    var d = new Date();
    var iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    var el = document.getElementById("m-fecha");
    if (el && !el.value) el.value = iso;
  }

  function prefillEvaluador() {
    var el = document.getElementById("m-evaluador");
    if (el && !el.value && user && user.nombre) el.value = user.nombre;
  }

  /* =========================================================================
     Exportación
     ========================================================================= */
  function csvCell(v) {
    v = (v == null ? "" : String(v));
    return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function buildCSV(scope) {
    var headers = ["muestra_id", "fecha", "evaluador", "fundo", "modulo", "lote", "valvula", "variedad", "codigo_planta",
      "n_rama", "rama_altura_cm", "rama_diametro_mm", "rama_flujo",
      "n_brote", "brote_altura_cm", "brote_diametro_mm", "brote_axilas_activas",
      "n_terminal", "term_altura_cm", "term_diametro_mm", "term_axilas_activas",
      "term_flores", "term_cuajados", "term_verdes", "term_envero", "term_peduncular_total", "term_cuaje_pct"];
    var rows = [headers.join(",")];
    var pad = function (k) { return new Array(k).fill(""); };
    var list = scope === "all" ? visibleSamples() : [activeSample()];
    list.forEach(function (s) {
      if (!s) return;
      var base = [s.id, s.fecha, s.evaluador, s.fundo, s.modulo, s.lote, s.valvula, s.variedad, s.codigo];
      if (!s.ramas.length) { rows.push(base.concat(pad(18)).map(csvCell).join(",")); return; }
      s.ramas.forEach(function (r, ri) {
        var rb = [ri + 1, r.altura, r.diametro, r.flujo];
        if (!r.brotes.length) { rows.push(base.concat(rb, pad(14)).map(csvCell).join(",")); return; }
        r.brotes.forEach(function (b, bi) {
          var bb = [bi + 1, b.altura, b.diametro, b.axilas];
          if (!b.terminales.length) { rows.push(base.concat(rb, bb, pad(10)).map(csvCell).join(",")); return; }
          b.terminales.forEach(function (t, ti) {
            var flores = n(t.flores);
            var cuaje = flores > 0 ? Math.round((n(t.cuajados) / flores) * 100) : "";
            var tb = [ti + 1, t.altura, t.diametro, t.axilas, t.flores, t.cuajados, t.verdes, t.envero, t.peduncular, cuaje];
            rows.push(base.concat(rb, bb, tb).map(csvCell).join(","));
          });
        });
      });
    });
    return rows.join("\r\n");
  }

  function buildJSON(scope) {
    var data = scope === "all" ? visibleSamples() : [activeSample()].filter(Boolean);
    return JSON.stringify(data, function (k, v) {
      return (k === "_collapsed" || k === "dirty" || k === "deleted") ? undefined : v;
    }, 2);
  }

  function slug(s) {
    return String(s || "muestra").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "muestra";
  }

  var expScope = "one", expFmt = "csv";

  function refreshExport() {
    document.getElementById("exp-out").value = expFmt === "csv" ? buildCSV(expScope) : buildJSON(expScope);
    document.querySelectorAll("#exp-fmt button").forEach(function (x) {
      x.classList.toggle("on", x.getAttribute("data-f") === expFmt);
    });
    document.querySelectorAll("#exp-scope button").forEach(function (x) {
      x.classList.toggle("on", x.getAttribute("data-s") === expScope);
    });
  }

  function currentFilename() {
    var s = activeSample();
    var stem = expScope === "all" ? "cartilla-todas" : ("cartilla-" + slug(s && s.fundo) + "-" + slug(s && s.lote));
    return stem + "." + (expFmt === "csv" ? "csv" : "json");
  }

  function doDownload() {
    var text = document.getElementById("exp-out").value;
    var mime = expFmt === "csv" ? "text/csv" : "application/json";
    try {
      var blob = new Blob([expFmt === "csv" ? "﻿" + text : text], { type: mime + ";charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = currentFilename();
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
      toast("Descargando " + currentFilename());
    } catch (err) { toast("No se pudo descargar; usa Copiar"); }
  }

  function doCopy() {
    var ta = document.getElementById("exp-out");
    var text = ta.value;
    function ok() { toast("Copiado al portapapeles"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { legacyCopy(ta); });
    } else legacyCopy(ta);
  }

  function legacyCopy(ta) {
    ta.focus(); ta.select();
    try { document.execCommand("copy"); toast("Copiado"); }
    catch (e) { toast("Selecciona y copia manualmente"); }
  }

  document.getElementById("exportBtn").addEventListener("click", function () {
    document.getElementById("exp-scrim").hidden = false;
    refreshExport();
  });

  document.addEventListener("click", function (e) {
    if (e.target.id === "exp-scrim" || e.target.closest("[data-close-exp]")) {
      document.getElementById("exp-scrim").hidden = true; return;
    }
    var f = e.target.closest("#exp-fmt button");
    if (f) { expFmt = f.getAttribute("data-f"); refreshExport(); return; }
    var sp = e.target.closest("#exp-scope button");
    if (sp) { expScope = sp.getAttribute("data-s"); refreshExport(); return; }
    if (e.target.closest("#exp-download")) { doDownload(); return; }
    if (e.target.closest("#exp-copy")) { doCopy(); return; }
  });

  /* =========================================================================
     Toast y tema
     ========================================================================= */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 1900);
  }

  function applyTheme(m) {
    var root = document.documentElement;
    if (m === "light" || m === "dark") root.setAttribute("data-theme", m);
    else root.removeAttribute("data-theme");
    try { localStorage.setItem(THEMEKEY, m); } catch (e) {}
  }

  document.getElementById("themeBtn").addEventListener("click", function () {
    var cur = document.documentElement.getAttribute("data-theme");
    var next = cur === "dark" ? "light" : cur === "light" ? "auto" : "dark";
    applyTheme(next);
    toast(next === "auto" ? "Tema: sistema" : next === "dark" ? "Tema: oscuro" : "Tema: claro");
  });

  /* =========================================================================
     Pantalla de acceso
     ========================================================================= */
  var authMode = "login";

  function authMsg(text, ok) {
    var el = document.getElementById("auth-msg");
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("ok", !!ok);
  }

  function renderAuthMode() {
    var isReg = authMode === "register";
    document.getElementById("auth-title").textContent = isReg ? "Crear cuenta" : "Entrar a la cartilla";
    document.getElementById("auth-submit").textContent = isReg ? "Crear cuenta y entrar" : "Entrar";
    document.getElementById("auth-toggle").textContent = isReg ? "Ya tengo cuenta" : "Crear una cuenta nueva";
    document.getElementById("a-nombre-wrap").hidden = !isReg;
    document.getElementById("a-code-wrap").hidden = !isReg;
    document.getElementById("a-pass").setAttribute("autocomplete", isReg ? "new-password" : "current-password");
    authMsg("");
  }

  document.getElementById("auth-toggle").addEventListener("click", function () {
    authMode = authMode === "login" ? "register" : "login";
    renderAuthMode();
  });

  document.getElementById("auth-skip").addEventListener("click", function () {
    mode = "local";
    metaSet(META.mode, "local");
    render();
    toast("Trabajando solo en este equipo");
  });

  document.getElementById("form-auth").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = document.getElementById("auth-submit");
    var username = document.getElementById("a-user").value.trim();
    var password = document.getElementById("a-pass").value;
    var body = { username: username, password: password };
    if (authMode === "register") {
      body.nombre = document.getElementById("a-nombre").value.trim();
      body.code = document.getElementById("a-code").value.trim();
    }
    btn.disabled = true;
    authMsg("");
    api(authMode === "register" ? "/api/register" : "/api/login", { method: "POST", body: body })
      .then(function (res) {
        user = res.user;
        mode = "cloud";
        return Promise.all([metaSet(META.mode, "cloud"), metaSet(META.since, 0)]);
      })
      .then(function () {
        since = 0; // pull completo: este equipo puede no tener nada del servidor
        document.getElementById("form-auth").reset();
        // Todo lo capturado en modo local sube en el primer sync.
        db.samples.forEach(function (s) { s.dirty = 1; pendingIds[s.id] = true; });
        prefillEvaluador();
        render();
        return flushSave().then(function () { return doSync({ manual: true, force: true }); });
      })
      .then(function () { toast("Bienvenido, " + ((user && user.nombre) || "")); })
      .catch(function (err) { authMsg(err.message || "No se pudo entrar"); })
      .then(function () { btn.disabled = false; });
  });

  /* =========================================================================
     Hoja de cuenta
     ========================================================================= */
  function openAccount() {
    var body = document.getElementById("acct-body");
    var pend = dirtyCount();
    var html = "";

    if (mode === "cloud" && user) {
      html += '<div class="acct-row"><span class="k">Usuario</span><span class="v">' + esc(user.username) + "</span></div>";
      html += '<div class="acct-row"><span class="k">Nombre</span><span class="v">' + esc(user.nombre || "—") + "</span></div>";
      html += '<div class="acct-row"><span class="k">Rol</span><span class="v">' + esc(user.role || "evaluador") + "</span></div>";
      html += '<div class="acct-row"><span class="k">Conexión</span><span class="v">' +
        (online ? '<span class="pill up">en línea</span>' : '<span class="pill wait">sin señal</span>') + "</span></div>";
      html += '<div class="acct-row"><span class="k">Pendientes</span><span class="v">' +
        (pend ? '<span class="pill wait">' + pend + " muestra" + (pend === 1 ? "" : "s") + " por subir</span>"
              : '<span class="pill up">todo respaldado</span>') + "</span></div>";
      html += '<div class="acct-actions">' +
        '<button class="btn primary" id="acct-sync">Sincronizar ahora</button>' +
        '<a class="btn ghost" href="/api/export.csv">Bajar CSV del servidor</a>' +
        '<button class="btn ghost" id="acct-logout">Salir de la cuenta</button>' +
        "</div>";
      html += '<p class="note">Al salir de la cuenta se borran las muestras de este equipo (siguen en el servidor). Sincroniza antes si tienes pendientes.</p>';
    } else {
      html += '<div class="acct-row"><span class="k">Modo</span><span class="v">solo en este equipo</span></div>';
      html += '<div class="acct-row"><span class="k">Muestras</span><span class="v">' + visibleSamples().length + "</span></div>";
      html += '<div class="acct-actions"><button class="btn primary" id="acct-login">Iniciar sesión y respaldar</button></div>';
      html += '<p class="note">Tus datos están solo en este teléfono. Si inicias sesión, todo lo capturado se sube y queda respaldado.</p>';
    }

    if (installPrompt) {
      html += '<div class="acct-actions instbtn"><button class="btn ghost" id="acct-install">Instalar en la pantalla de inicio</button></div>';
    }

    body.innerHTML = html;
    document.getElementById("acct-scrim").hidden = false;
  }

  document.getElementById("acctBtn").addEventListener("click", openAccount);

  document.addEventListener("click", function (e) {
    if (e.target.id === "acct-scrim" || e.target.closest("[data-close-acct]")) {
      document.getElementById("acct-scrim").hidden = true; return;
    }
    if (e.target.closest("#acct-sync")) {
      doSync({ manual: true, force: true }).then(function () {
        openAccount();
        if (online) toast("Sincronización lista");
      });
      return;
    }
    if (e.target.closest("#acct-login")) {
      document.getElementById("acct-scrim").hidden = true;
      mode = null; metaSet(META.mode, null);
      authMode = "login"; renderAuthMode(); render();
      return;
    }
    if (e.target.closest("#acct-logout")) {
      if (dirtyCount() && !confirm("Tienes muestras sin subir. ¿Salir de todas formas?")) return;
      api("/api/logout", { method: "POST" }).catch(function () {})
        .then(function () {
          user = null; mode = null; since = 0;
          db.samples = []; db.activeId = null;
          return Promise.all([
            metaSet(META.mode, null), metaSet(META.since, 0), metaSet(META.activeId, null),
            idbReq(tx("samples", "readwrite").clear()),
          ]);
        })
        .then(function () {
          document.getElementById("acct-scrim").hidden = true;
          authMode = "login"; renderAuthMode(); render();
        });
      return;
    }
    if (e.target.closest("#acct-install") && installPrompt) {
      installPrompt.prompt();
      installPrompt = null;
      document.getElementById("acct-scrim").hidden = true;
      return;
    }
  });

  document.getElementById("syncBtn").addEventListener("click", function () {
    doSync({ manual: true, force: true }).then(function () {
      if (online) toast(dirtyCount() ? dirtyCount() + " pendientes" : "Todo sincronizado");
      else toast("Sin conexión; se subirá al volver la señal");
    });
  });

  /* =========================================================================
     Red, instalación y arranque
     ========================================================================= */
  window.addEventListener("online", function () {
    online = true;
    document.getElementById("offlineStrip").hidden = mode === "local";
    setSaveState("saved");
    scheduleSync(400);
  });

  window.addEventListener("offline", function () {
    online = false;
    document.getElementById("offlineStrip").hidden = mode === "local";
    setSaveState("saved");
  });

  // Último intento de subir antes de que se cierre la pestaña.
  window.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && dirtyCount()) doSync();
  });

  var installPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installPrompt = e;
  });

  // Migra la cartilla de un solo archivo (localStorage) al almacén nuevo.
  function migrateLegacy() {
    var raw;
    try { raw = localStorage.getItem(LEGACYKEY); } catch (e) { return Promise.resolve(); }
    if (!raw) return Promise.resolve();
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return Promise.resolve(); }
    if (!parsed || !Array.isArray(parsed.samples) || !parsed.samples.length) return Promise.resolve();

    var now = Date.now();
    var existing = Object.create(null);
    db.samples.forEach(function (s) { existing[s.id] = true; });
    var migrated = 0;
    parsed.samples.forEach(function (s) {
      if (!s || !s.id || existing[s.id]) return;
      s.updatedAt = s.updatedAt || now;
      s.createdAt = s.createdAt || now;
      s.dirty = 1;
      s.deleted = 0;
      s.ramas = s.ramas || [];
      db.samples.push(s);
      pendingIds[s.id] = true;
      migrated++;
    });
    if (!migrated) return Promise.resolve();
    return flushSave().then(function () {
      try { localStorage.removeItem(LEGACYKEY); } catch (e) {}
      toast(migrated + " muestra" + (migrated === 1 ? "" : "s") + " importada" + (migrated === 1 ? "" : "s"));
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  }

  function boot() {
    var m = "auto";
    try { m = localStorage.getItem(THEMEKEY) || "auto"; } catch (e) {}
    applyTheme(m);
    setDefaultDate();
    renderAuthMode();

    openDB()
      .then(function (d) {
        idb = d;
        return Promise.all([getAllSamples(), metaGet(META.activeId), metaGet(META.since), metaGet(META.mode)]);
      })
      .then(function (r) {
        db.samples = r[0] || [];
        db.activeId = r[1] || null;
        since = r[2] || 0;
        mode = r[3] || null;
        return migrateLegacy();
      })
      .then(function () {
        // Con sesión guardada, la cookie sigue viva: confirmamos con el servidor.
        if (mode === "cloud") {
          return api("/api/me")
            .then(function (res) { user = res.user || null; })
            .catch(function () { user = null; }); // sin red seguimos trabajando offline
        }
      })
      .then(function () {
        // Sin red no podemos validar la cookie, pero no debemos echar al operario
        // a la pantalla de login: si el modo era cloud, confiamos y sincronizamos después.
        if (mode === "cloud" && !user && !online) {
          user = { username: "…", nombre: "", role: "evaluador", offlineAssumed: true };
        }
        render();
        prefillEvaluador();
        if (mode === "cloud" && user && !user.offlineAssumed) scheduleSync(800);
      })
      .catch(function (err) {
        // IndexedDB bloqueada (modo privado en algunos navegadores): avisamos.
        console.error("boot", err);
        toast("No se pudo abrir el almacén local");
        mode = mode || "local";
        render();
      });

    registerSW();
  }

  boot();
})();
