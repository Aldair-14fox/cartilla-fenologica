// CSV en formato largo: una fila por terminal, con los datos de muestra/rama/
// brote repetidos. Mismo layout que el export del cliente, para que un archivo
// bajado del servidor y otro del dispositivo se puedan concatenar sin tocar nada.

export const CSV_HEADERS = [
  "muestra_id", "fecha", "evaluador", "fundo", "modulo", "lote", "valvula", "variedad", "codigo_planta",
  "n_rama", "rama_altura_cm", "rama_diametro_mm", "rama_flujo",
  "n_brote", "brote_altura_cm", "brote_diametro_mm", "brote_axilas_activas",
  "n_terminal", "term_altura_cm", "term_diametro_mm", "term_axilas_activas",
  "term_flores", "term_cuajados", "term_verdes", "term_envero", "term_peduncular_total", "term_cuaje_pct",
];

function cell(v) {
  v = v == null ? "" : String(v);
  return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function num(v) {
  const x = parseFloat(v);
  return isNaN(x) ? 0 : x;
}

export function buildCSV(samples) {
  const rows = [CSV_HEADERS.join(",")];
  const pad = (n) => new Array(n).fill("");

  for (const s of samples || []) {
    if (!s) continue;
    const base = [s.id, s.fecha, s.evaluador, s.fundo, s.modulo, s.lote, s.valvula, s.variedad, s.codigo];
    const ramas = s.ramas || [];
    if (!ramas.length) {
      rows.push(base.concat(pad(18)).map(cell).join(","));
      continue;
    }
    ramas.forEach((r, ri) => {
      const rb = [ri + 1, r.altura, r.diametro, r.flujo];
      const brotes = r.brotes || [];
      if (!brotes.length) {
        rows.push(base.concat(rb, pad(14)).map(cell).join(","));
        return;
      }
      brotes.forEach((b, bi) => {
        const bb = [bi + 1, b.altura, b.diametro, b.axilas];
        const terms = b.terminales || [];
        if (!terms.length) {
          rows.push(base.concat(rb, bb, pad(10)).map(cell).join(","));
          return;
        }
        terms.forEach((t, ti) => {
          const flores = num(t.flores);
          const cuaje = flores > 0 ? Math.round((num(t.cuajados) / flores) * 100) : "";
          rows.push(
            base
              .concat(rb, bb, [
                ti + 1, t.altura, t.diametro, t.axilas,
                t.flores, t.cuajados, t.verdes, t.envero, t.peduncular, cuaje,
              ])
              .map(cell)
              .join(",")
          );
        });
      });
    });
  }
  return rows.join("\r\n");
}
