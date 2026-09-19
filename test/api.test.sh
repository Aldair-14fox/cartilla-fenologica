#!/usr/bin/env bash
# Prueba end-to-end de la API contra el dev server local.
set -u
B=http://127.0.0.1:8788
J=$(mktemp -d)
C1=$J/c1.txt   # cookies del dispositivo A
C2=$J/c2.txt   # cookies del dispositivo B (mismo usuario)
C3=$J/c3.txt   # cookies de otro usuario
rm -f "$C1" "$C2" "$C3"
pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1 — esperado [$3] obtuve [$2]"; fail=$((fail+1)); fi; }
code(){ echo "$1" | tail -1; }

echo "== estáticos =="
chk "GET / sirve HTML" "$(curl -s -o /dev/null -w '%{http_code}' $B/)" "200"
chk "manifest" "$(curl -s -o /dev/null -w '%{http_code}' $B/manifest.webmanifest)" "200"
chk "sw.js" "$(curl -s -o /dev/null -w '%{http_code}' $B/sw.js)" "200"
chk "icono png" "$(curl -s -o /dev/null -w '%{http_code}' $B/icons/icon-192.png)" "200"
chk "ruta desconocida cae en SPA" "$(curl -s -o /dev/null -w '%{http_code}' $B/cualquier-cosa)" "200"

echo "== auth =="
chk "me sin sesión" "$(curl -s $B/api/me | tr -d ' ')" '{"user":null}'
chk "sync sin sesión = 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/sync -H 'content-type: application/json' -d '{}')" "401"

r=$(curl -s -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"ana","password":"clave12345","nombre":"Ana Quispe","code":"mala"}')
chk "registro con código malo" "$(echo "$r" | grep -c 'Codigo de registro')" "1"

r=$(curl -s -c "$C1" -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"ana","password":"clave12345","nombre":"Ana Quispe","code":"prueba-local"}')
chk "registro ok" "$(echo "$r" | grep -c '"ok":true')" "1"
chk "primer usuario es admin" "$(echo "$r" | grep -c '"role":"admin"')" "1"
chk "cookie httponly" "$(grep -c HttpOnly "$C1")" "1"

chk "usuario corto rechazado" "$(curl -s -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"ab","password":"clave12345","code":"prueba-local"}' | grep -c 'Usuario:')" "1"
chk "clave corta rechazada" "$(curl -s -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"pepe","password":"corta","code":"prueba-local"}' | grep -c 'al menos 8')" "1"
chk "usuario duplicado" "$(curl -s -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"ana","password":"clave12345","code":"prueba-local"}' | grep -c 'ya existe')" "1"

chk "me con sesión" "$(curl -s -b "$C1" $B/api/me | grep -c '"username":"ana"')" "1"
chk "login clave mala" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"ana","password":"incorrecta"}')" "401"
chk "login usuario inexistente" "$(curl -s -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"nadie","password":"clave12345"}' | grep -c 'Usuario o contrasena incorrectos')" "1"
chk "login ok (2do equipo)" "$(curl -s -c "$C2" -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"ana","password":"clave12345"}' | grep -c '"ok":true')" "1"
chk "login normaliza mayúsculas" "$(curl -s -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"ANA","password":"clave12345"}' | grep -c '"ok":true')" "1"

echo "== sync: subir =="
PUSH='{"since":0,"samples":[{"id":"s1","fundo":"Fundo Norte","modulo":"M1","lote":"L-12","valvula":"V3","variedad":"Ventura","evaluador":"Ana Quispe","fecha":"2026-09-19","codigo":"P-014","createdAt":1000,"updatedAt":2000,"deleted":0,"ramas":[{"id":"r1","altura":"120.5","diametro":"14","flujo":"2","brotes":[{"id":"b1","altura":"35","diametro":"6","axilas":"12","terminales":[{"id":"t1","altura":"18","diametro":"4","axilas":"7","flores":"20","cuajados":"15","verdes":"3","envero":"1","peduncular":"22"},{"id":"t2","altura":"16","diametro":"3.5","axilas":"6","flores":"10","cuajados":"5","verdes":"2","envero":"0","peduncular":"11"}]}]}]}]}'
r=$(curl -s -b "$C1" -X POST $B/api/sync -H 'content-type: application/json' -d "$PUSH")
chk "acepta muestra nueva" "$(echo "$r" | grep -c '"accepted":\["s1"\]')" "1"
S_NOW=$(echo "$r" | python3 -c 'import sys,json; print(json.load(sys.stdin)["now"])')

echo "== sync: bajar en otro equipo =="
r=$(curl -s -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[]}')
chk "2do equipo recibe la muestra" "$(echo "$r" | grep -c '"id":"s1"')" "1"
chk "árbol completo (terminal t2)" "$(echo "$r" | grep -c '"id":"t2"')" "1"
chk "valor anidado correcto" "$(echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["samples"][0]["ramas"][0]["brotes"][0]["terminales"][0]["flores"])')" "20"
chk "orden de terminales preservado" "$(echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(",".join(t["id"] for t in d["samples"][0]["ramas"][0]["brotes"][0]["terminales"]))')" "t1,t2"

echo "== last-write-wins =="
OLD='{"since":0,"samples":[{"id":"s1","fundo":"VIEJO","updatedAt":1500,"createdAt":1000,"ramas":[]}]}'
r=$(curl -s -b "$C1" -X POST $B/api/sync -H 'content-type: application/json' -d "$OLD")
chk "rechaza versión vieja" "$(echo "$r" | grep -c 'desactualizada')" "1"
chk "y devuelve la buena" "$(echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["samples"][0]["fundo"] if d["samples"] else "SIN")')" "Fundo Norte"

NEW='{"since":0,"samples":[{"id":"s1","fundo":"Fundo Sur","modulo":"M1","lote":"L-12","valvula":"V3","variedad":"Ventura","evaluador":"Ana","fecha":"2026-09-19","codigo":"P-014","createdAt":1000,"updatedAt":9000,"deleted":0,"ramas":[{"id":"r1","altura":"999","diametro":"14","flujo":"2","brotes":[]}]}]}'
r=$(curl -s -b "$C1" -X POST $B/api/sync -H 'content-type: application/json' -d "$NEW")
chk "acepta versión nueva" "$(echo "$r" | grep -c '"accepted":\["s1"\]')" "1"
r=$(curl -s -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[]}')
chk "árbol reemplazado (sin brotes)" "$(echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["samples"][0]["ramas"][0]["brotes"]))')" "0"
chk "huérfanos limpiados (t1 se fue)" "$(echo "$r" | grep -c '"id":"t1"')" "0"

echo "== aislamiento entre usuarios =="
curl -s -c "$C3" -X POST $B/api/register -H 'content-type: application/json' -d '{"username":"beto","password":"clave12345","nombre":"Beto","code":"prueba-local"}' > /dev/null
chk "2do usuario NO es admin" "$(curl -s -b "$C3" $B/api/me | grep -c '"role":"evaluador"')" "1"
r=$(curl -s -b "$C3" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[]}')
chk "beto no ve muestras de ana" "$(echo "$r" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["samples"]))')" "0"
r=$(curl -s -b "$C3" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[{"id":"s1","fundo":"SECUESTRO","updatedAt":99999,"createdAt":1,"ramas":[]}]}')
chk "no puede sobreescribir muestra ajena" "$(echo "$r" | grep -c 'ajena')" "1"
chk "la muestra de ana sigue intacta" "$(curl -s -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[]}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["samples"][0]["fundo"])')" "Fundo Sur"

echo "== borrado lógico =="
DEL='{"since":0,"samples":[{"id":"s1","fundo":"Fundo Sur","updatedAt":12000,"createdAt":1000,"deleted":1,"ramas":[]}]}'
curl -s -b "$C1" -X POST $B/api/sync -H 'content-type: application/json' -d "$DEL" > /dev/null
chk "borrado se propaga" "$(curl -s -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[]}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["samples"][0]["deleted"])')" "1"

echo "== CSV del servidor =="
# Revive s1 con updatedAt mayor al del borrado (12000), si no LWW lo rechaza.
REVIVE=$(echo "$PUSH" | sed 's/"updatedAt":2000/"updatedAt":20000/')
curl -s -b "$C1" -X POST $B/api/sync -H 'content-type: application/json' -d "$REVIVE" > /dev/null
CSV=$(curl -s -b "$C1" "$B/api/export.csv")
chk "csv tiene encabezado" "$(echo "$CSV" | head -1 | grep -c 'muestra_id,fecha,evaluador')" "1"
chk "csv una fila por terminal" "$(echo "$CSV" | grep -c '^s1,')" "2"
chk "csv calcula cuaje 15/20=75" "$(echo "$CSV" | grep '^s1,' | head -1 | tr -d '\r' | awk -F, '{print $NF}')" "75"
chk "csv usa CRLF (Excel)" "$(echo "$CSV" | head -1 | grep -c $'\r$')" "1"

echo "== cambio de contraseña =="
chk "clave actual mala" "$(curl -s -o /dev/null -w '%{http_code}' -b "$C1" -X POST $B/api/password -H 'content-type: application/json' -d '{"actual":"nope","nueva":"nuevaclave1"}')" "403"
chk "cambio ok" "$(curl -s -b "$C1" -X POST $B/api/password -H 'content-type: application/json' -d '{"actual":"clave12345","nueva":"nuevaclave1"}' | grep -c '"ok":true')" "1"
chk "login con clave nueva" "$(curl -s -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"ana","password":"nuevaclave1"}' | grep -c '"ok":true')" "1"
chk "clave vieja ya no sirve" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/login -H 'content-type: application/json' -d '{"username":"ana","password":"clave12345"}')" "401"

echo "== logout =="
chk "logout" "$(curl -s -b "$C1" -c "$C1" -X POST $B/api/logout | grep -c '"ok":true')" "1"
chk "sesión invalidada" "$(curl -s -b "$C1" $B/api/me | tr -d ' ')" '{"user":null}'
chk "el otro equipo sigue con sesión" "$(curl -s -b "$C2" $B/api/me | grep -c '"username":"ana"')" "1"

echo "== robustez =="
chk "json basura = 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d 'no-es-json')" "400"
chk "ruta api inexistente = 404" "$(curl -s -o /dev/null -w '%{http_code}' -b "$C2" $B/api/nada)" "404"
chk "muestra sin id se ignora" "$(curl -s -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[{"fundo":"sin id","updatedAt":5}]}' | grep -c '"accepted":\[\]')" "1"
chk "campos no-array tolerados" "$(curl -s -o /dev/null -w '%{http_code}' -b "$C2" -X POST $B/api/sync -H 'content-type: application/json' -d '{"since":0,"samples":[{"id":"s9","updatedAt":5,"ramas":"texto"}]}')" "200"

echo
echo "RESULTADO: $pass ok, $fail fallas"
[ "$fail" -eq 0 ] || exit 1
