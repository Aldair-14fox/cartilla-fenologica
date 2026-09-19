# Cartilla Fenológica de Campo

PWA para registrar fenología de arándano en campo, por niveles anidados
**rama → brote → terminal**. Funciona sin señal y sincroniza a una base de datos
cuando vuelve la conexión.

- **Captura offline real**: todo se guarda en IndexedDB al instante. El operario
  nunca se queda esperando a la red.
- **Sincronización con cuentas**: cada evaluador entra con usuario y contraseña;
  sus muestras se respaldan y aparecen en cualquier otro equipo donde entre.
- **Instalable**: se agrega a la pantalla de inicio y abre como app.
- **Exporta CSV largo** (una fila por terminal) y JSON, desde el equipo o desde
  el servidor.

## Arquitectura

```
public/           PWA (se sirve como estático desde Cloudflare)
  index.html      pantallas: acceso · registro de muestra · cartilla por niveles
  app.js          estado, IndexedDB, motor de sincronización, exportación
  styles.css      tema claro/oscuro
  sw.js           service worker: shell cacheado, /api nunca se cachea
  manifest.webmanifest
src/              Cloudflare Worker (solo responde /api/*)
  index.js        rutas
  auth.js         PBKDF2-SHA256 + sesiones en D1
  sync.js         sincronización last-write-wins
  csv.js          exportación CSV del servidor
migrations/       esquema de D1
test/             pruebas end-to-end (API y navegador)
```

### Cómo sincroniza

El cliente manda las muestras marcadas como `dirty` junto con el `since` del
último pull. El servidor resuelve **last-write-wins por muestra completa**: si la
versión del cliente es más nueva, reemplaza el árbol entero; si es más vieja, se
rechaza y el cliente recibe la buena. Reemplazar el árbol completo en vez de
hacer diff por nodo evita toda una clase de errores de merge parcial, y una
muestra es lo bastante pequeña para que salga barato.

Los ids los genera el dispositivo, así que la captura offline no depende del
servidor y reenviar el mismo lote es idempotente. El borrado es lógico
(`deleted=1`) para que se propague a los demás equipos.

## Puesta en marcha

Requiere Node 18+ y una cuenta de Cloudflare.

```bash
npm install
npx wrangler login     # abre el navegador
./deploy.sh            # crea la D1, migra y despliega
```

`deploy.sh` es idempotente: si la base ya existe la reutiliza y si el
`database_id` ya está en `wrangler.toml` no lo vuelve a tocar. Al terminar,
cierra el registro de cuentas:

```bash
npx wrangler secret put REGISTRATION_CODE
```

Paso a paso, si lo prefieres a mano:

```bash
npx wrangler d1 create cartilla-fenologica  # pega el id en wrangler.toml
npm run db:migrate
npm run deploy
```

Para desarrollo local: copia `.dev.vars.example` a `.dev.vars`, corre
`npm run db:migrate:local` y luego `npm run dev`.

> La primera cuenta que se registra queda con rol `admin`; las demás entran como
> `evaluador`.

## Pruebas

Con `npm run dev` levantado en el puerto 8788:

```bash
npm run test:api   # 49 pruebas: auth, aislamiento entre usuarios, sync, CSV
npm run test:ui    # 53 pruebas en navegador real: captura, offline, 2 equipos
```

`test:ui` necesita `npm i playwright` y cubre el recorrido completo: registrarse,
capturar con la señal cortada, recargar sin red (service worker), recuperar la
conexión y comprobar que un segundo equipo ve los mismos datos.

## API

| Ruta | Método | Descripción |
|---|---|---|
| `/api/register` | POST | Crea cuenta (exige `REGISTRATION_CODE` si está configurado) |
| `/api/login` | POST | Inicia sesión, devuelve cookie `HttpOnly` |
| `/api/logout` | POST | Cierra la sesión |
| `/api/me` | GET | Usuario actual o `null` |
| `/api/sync` | POST | Empuja y trae cambios |
| `/api/export.csv` | GET | CSV de todas las muestras del usuario |
| `/api/password` | POST | Cambia la contraseña |

## Notas de seguridad

- Contraseñas con PBKDF2-SHA256, 100 000 iteraciones y sal por usuario.
- En la tabla `sessions` se guarda el **hash** del token, no el token.
- Cookie `HttpOnly; Secure; SameSite=Lax`.
- Una muestra ajena nunca se sobreescribe, aunque el cliente mande su id.
- Límite de intentos de login por IP y usuario.

## Formato del CSV

Formato largo, una fila por terminal, repitiendo los datos de muestra, rama y
brote — listo para Excel, R o Python. `term_cuaje_pct` se calcula como
`cuajados / flores * 100`. Sale con BOM y CRLF para que Excel lo abra bien.
