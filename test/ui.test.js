// Prueba de navegador real: registro, captura, offline, sync entre dispositivos.
const { chromium } = require("playwright");
const B = "http://127.0.0.1:8788";
const SHOT = process.env.SHOT_DIR || require("os").tmpdir();

let pass = 0, fail = 0;
function chk(name, got, want) {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — esperado [${want}] obtuve [${got}]`}`);
  ok ? pass++ : fail++;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---------- Dispositivo A ----------
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const A = await ctxA.newPage();
  A.on("pageerror", (e) => errors.push("A: " + e.message));
  // Los fallos de red durante la prueba offline son intencionales, no son bugs.
  A.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/.test(m.text())) return;
    errors.push("A console: " + m.text());
  });

  await A.goto(B, { waitUntil: "networkidle" });

  console.log("== pantalla de acceso ==");
  chk("muestra login", await A.locator("#screen-auth").isVisible(), true);
  chk("oculta registro de muestra", await A.locator("#screen-registro").isVisible(), false);
  chk("título correcto", (await A.locator("#auth-title").textContent()).trim(), "Entrar a la cartilla");

  // cambiar a registro
  await A.click("#auth-toggle");
  chk("modo registro pide nombre", await A.locator("#a-nombre-wrap").isVisible(), true);
  chk("modo registro pide código", await A.locator("#a-code-wrap").isVisible(), true);

  console.log("== registro ==");
  await A.fill("#a-user", "carla");
  await A.fill("#a-pass", "clave12345");
  await A.fill("#a-nombre", "Carla Ruiz");
  await A.fill("#a-code", "prueba-local");
  await A.click("#auth-submit");
  await A.waitForSelector("#screen-registro:not([hidden])", { timeout: 10000 });
  chk("entra a registrar muestra", await A.locator("#screen-registro").isVisible(), true);
  chk("botón de sync visible", await A.locator("#syncBtn").isVisible(), true);
  chk("evaluador precargado", await A.inputValue("#m-evaluador"), "Carla Ruiz");
  chk("fecha por defecto hoy", (await A.inputValue("#m-fecha")).length, 10);

  console.log("== captura de muestra ==");
  await A.fill("#m-fundo", "Fundo Norte");
  await A.fill("#m-lote", "L-12");
  await A.fill("#m-variedad", "Ventura");
  await A.fill("#m-modulo", "M1");
  await A.click("#form-muestra button[type=submit]");
  await A.waitForSelector("#screen-formulario:not([hidden])", { timeout: 5000 });
  chk("abre la cartilla", await A.locator("#screen-formulario").isVisible(), true);
  chk("chips de contexto", await A.locator("#ctx .chip").count() >= 4, true);
  chk("barra inferior visible", await A.locator("#bottombar").isVisible(), true);

  // árbol: rama > brote > terminal
  await A.click("#add-rama");
  await A.waitForSelector(".node.rama");
  chk("rama creada", await A.locator(".node.rama").count(), 1);
  await A.fill('.node.rama input[data-kind="rama.altura"]', "120.5");
  await A.fill('.node.rama input[data-kind="rama.diametro"]', "14");

  await A.click('.addbtn[data-add="brote"]');
  await A.waitForSelector(".node.brote");
  chk("brote creado", await A.locator(".node.brote").count(), 1);
  await A.fill('.node.brote input[data-kind="brote.altura"]', "35");

  await A.click('.addbtn[data-add="terminal"]');
  await A.waitForSelector(".node.terminal");
  chk("terminal creado", await A.locator(".node.terminal").count(), 1);
  await A.fill('input[data-kind="term.flores"]', "20");
  await A.fill('input[data-kind="term.cuajados"]', "15");

  console.log("== legibilidad de campos (regresión .num) ==");
  // Los inputs numéricos llevan class="num", igual que las insignias R1/B1/T1.
  // Si la regla de color de la insignia no está acotada al encabezado, pinta
  // los campos del color del nivel y el dato se vuelve ilegible.
  const fieldBg = await A.evaluate(() => {
    const out = {};
    for (const [k, sel] of [["rama", '.node.rama input[data-kind="rama.altura"]'],
                            ["brote", '.node.brote input[data-kind="brote.altura"]'],
                            ["terminal", 'input[data-kind="term.flores"]']]) {
      const el = document.querySelector(sel);
      out[k] = el ? getComputedStyle(el).backgroundColor : "(sin campo)";
    }
    out.badge = getComputedStyle(document.querySelector(".node.rama > .head .num")).backgroundColor;
    return out;
  });
  chk("campo de rama con fondo claro", fieldBg.rama, "rgb(255, 255, 255)");
  chk("campo de brote con fondo claro", fieldBg.brote, "rgb(255, 255, 255)");
  chk("campo de terminal con fondo claro", fieldBg.terminal, "rgb(255, 255, 255)");
  chk("insignia R1 conserva su color", fieldBg.badge, "rgb(75, 78, 160)");

  console.log("== cálculo de cuaje ==");
  await A.waitForTimeout(300);
  chk("QC muestra cuaje 75%", (await A.locator(".node.terminal .qc .cuaje").textContent()).includes("75%"), true);
  chk("totales: flores 20", (await A.locator("#totals").textContent()).includes("Flores 20"), true);
  chk("totales: cuaje 75%", (await A.locator("#totals").textContent()).includes("75%"), true);

  await A.screenshot({ path: SHOT + "/ui-cartilla.png", fullPage: false });

  console.log("== persistencia y sync ==");
  await A.waitForFunction(() => document.getElementById("savetxt").textContent === "Sincronizado", null, { timeout: 15000 })
    .then(() => chk("estado = Sincronizado", true, true))
    .catch(async () => chk("estado = Sincronizado", await A.locator("#savetxt").textContent(), "Sincronizado"));

  // recarga: los datos deben seguir ahí (IndexedDB)
  await A.reload({ waitUntil: "networkidle" });
  await A.waitForTimeout(1500);
  chk("tras recarga sigue en la cartilla", await A.locator("#screen-formulario").isVisible(), true);
  chk("valor conservado", await A.inputValue('input[data-kind="term.flores"]'), "20");
  chk("rama conservada", await A.inputValue('.node.rama input[data-kind="rama.altura"]'), "120.5");

  console.log("== reposo: sin bucle de sincronización ==");
  // Antes, doSync marcaba pendingIds -> flushSave llamaba a scheduleSync -> otro
  // doSync, en bucle: ~7 sincronizaciones y 7 reconstrucciones del árbol cada
  // 10 s estando quieto, con la pantalla saltando bajo los dedos del operario.
  let syncsEnReposo = 0;
  await A.route("**/api/sync", (route) => { syncsEnReposo++; route.continue(); });
  await A.evaluate(() => {
    window.__renders = 0;
    new MutationObserver(() => { window.__renders++; })
      .observe(document.getElementById("tree"), { childList: true });
  });
  await A.waitForTimeout(8000);
  const rendersEnReposo = await A.evaluate(() => window.__renders);
  chk("no sincroniza en bucle (<=2 en 8s)", syncsEnReposo <= 2, true);
  chk("no redibuja el árbol en reposo", rendersEnReposo, 0);
  chk("el botón no queda animado", await A.locator("#syncBtn").evaluate((b) => b.classList.contains("spin")), false);
  await A.unroute("**/api/sync");

  console.log("== modo offline ==");
  await ctxA.setOffline(true);
  await A.waitForTimeout(400);
  await A.fill('input[data-kind="term.verdes"]', "7");
  await A.waitForTimeout(900);
  chk("aviso de sin conexión", await A.locator("#offlineStrip").isVisible(), true);
  chk("sigue capturando offline", await A.inputValue('input[data-kind="term.verdes"]'), "7");
  const offTxt = await A.locator("#savetxt").textContent();
  chk("chip indica pendiente", /por subir|Sin conexión/.test(offTxt), true);

  // recarga estando offline: el service worker debe servir el shell
  await A.reload({ waitUntil: "domcontentloaded" });
  await A.waitForTimeout(1500);
  chk("app carga offline (service worker)", await A.locator(".topbar").isVisible(), true);
  chk("dato offline persistido", await A.inputValue('input[data-kind="term.verdes"]'), "7");
  await A.screenshot({ path: SHOT + "/ui-offline.png" });

  console.log("== vuelve la señal ==");
  await ctxA.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event("online")));
  await A.waitForFunction(() => document.getElementById("savetxt").textContent === "Sincronizado", null, { timeout: 20000 })
    .then(() => chk("sincroniza al volver", true, true))
    .catch(async () => chk("sincroniza al volver", await A.locator("#savetxt").textContent(), "Sincronizado"));

  console.log("== segundo dispositivo ==");
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const Bp = await ctxB.newPage();
  Bp.on("pageerror", (e) => errors.push("B: " + e.message));
  await Bp.goto(B, { waitUntil: "networkidle" });
  await Bp.fill("#a-user", "carla");
  await Bp.fill("#a-pass", "clave12345");
  await Bp.click("#auth-submit");
  await Bp.waitForSelector("#screen-registro:not([hidden])", { timeout: 15000 });
  await Bp.waitForTimeout(2500);
  chk("equipo B ve la muestra de A", await Bp.locator(".srow").count(), 1);
  const rowTxt = await Bp.locator(".srow .info .t").textContent();
  chk("con los datos correctos", rowTxt.includes("Fundo Norte") && rowTxt.includes("Ventura"), true);
  chk("marcada como respaldada", await Bp.locator(".srow .sync.up").count(), 1);

  await Bp.click(".srow .open");
  await Bp.waitForSelector("#screen-formulario:not([hidden])");
  await Bp.waitForTimeout(500);
  chk("B abre el árbol completo", await Bp.locator(".node.terminal").count(), 1);
  chk("B ve el valor capturado en A", await Bp.inputValue('input[data-kind="term.flores"]'), "20");
  chk("B ve el dato capturado offline", await Bp.inputValue('input[data-kind="term.verdes"]'), "7");
  await Bp.screenshot({ path: SHOT + "/ui-equipoB.png" });

  console.log("== exportación ==");
  await Bp.click("#exportBtn");
  await Bp.waitForSelector("#exp-scrim:not([hidden])");
  const csv = await Bp.inputValue("#exp-out");
  const csvLines = csv.split(/\r?\n/).filter((l) => l.length);
  chk("CSV con encabezado", csvLines[0].includes("muestra_id,fecha,evaluador"), true);
  chk("CSV con fila de datos", csvLines.length >= 2, true);
  chk("CSV trae el cuaje 75", csvLines[1].split(",").pop(), "75");
  chk("CSV trae flores y cuajados", /,20,15,/.test(csvLines[1]), true);
  await Bp.click('#exp-fmt button[data-f="json"]');
  await Bp.waitForTimeout(200);
  const jsonOut = await Bp.inputValue("#exp-out");
  chk("JSON válido", (() => { try { JSON.parse(jsonOut); return true; } catch { return false; } })(), true);
  chk("JSON sin campos internos", /_collapsed|"dirty"/.test(jsonOut), false);

  if (await Bp.locator("#exp-scrim").isVisible()) {
    await Bp.click("#exp-scrim [data-close-exp]");
    await Bp.waitForTimeout(300);
  }
  chk("hoja de exportación cierra", await Bp.locator("#exp-scrim").isVisible(), false);

  console.log("== PWA ==");
  const manifest = await Bp.evaluate(async () => {
    const r = await fetch("/manifest.webmanifest");
    return r.ok ? await r.json() : null;
  });
  chk("manifest servido", manifest && manifest.name, "Cartilla Fenológica de Campo");
  chk("manifest standalone", manifest && manifest.display, "standalone");
  chk("manifest con icono maskable", manifest.icons.some((i) => i.purpose === "maskable"), true);
  const swReady = await Bp.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false));
  chk("service worker activo", swReady, true);

  console.log("== tema oscuro ==");
  await Bp.click("#themeBtn");
  await Bp.waitForTimeout(300);
  chk("tema oscuro aplicado", await Bp.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  await Bp.screenshot({ path: SHOT + "/ui-oscuro.png" });

  console.log("== cuenta ==");
  await Bp.click("#acctBtn");
  await Bp.waitForSelector("#acct-scrim:not([hidden])");
  const acct = await Bp.locator("#acct-body").textContent();
  chk("cuenta muestra usuario", acct.includes("carla"), true);
  chk("cuenta muestra respaldo", acct.includes("todo respaldado"), true);

  console.log("\n== errores de consola ==");
  if (errors.length) { errors.forEach((e) => console.log("  ! " + e)); chk("sin errores JS", errors.length, 0); }
  else chk("sin errores JS", 0, 0);

  await browser.close();
  console.log(`\nRESULTADO UI: ${pass} ok, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR FATAL:", e.message); process.exit(1); });
