# Versión original

`cartilla-fenologica-campo.html` es la cartilla de un solo archivo que dio origen
al proyecto: guardaba en `localStorage` y no tenía cuentas ni respaldo.

Se conserva como referencia. La app actual la reemplaza y **migra sola** los
datos: al abrir la PWA en el mismo navegador donde se usó este archivo, las
muestras de `localStorage` se importan a IndexedDB y se suben al iniciar sesión.

Nota: este archivo tiene un error de CSS corregido en la versión nueva — la regla
`.node.rama .num` pintaba también los campos numéricos (que usan `class="num"`),
volviendo ilegible lo escrito. En la versión actual está acotada al encabezado.
