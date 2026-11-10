# Puesta a punto: red sana, errores guardados, código ordenado
- Estado: COMPLETO 2026-11-10
- director: sí
- rama: modulo/puesta-a-punto
- Próximo paso: integrar el módulo a `main` (el director, con `worktree.cjs integrar`), para que el CI de `main` arme el `.exe` con el código ordenado (`build.yml` solo corre en `main`), sin release.
- Cierre de tramo: cada 2 encargos
- Tramo: 3 cerrado 2026-11-10

## Qué es
Pedido del 2026-11-10: cortar la tormenta de mDNS que carga la CPU, que todo error de red quede guardado en disco con fecha, que pasar archivos entre PCs deje de ser "un día anda, otro no", y ordenar el código por dentro (lib.rs, main.js, styles.css) con los tests en verde. Lo corre un director con obreros, de noche.

## Fase y próximo paso
Spec en `SPEC.md`. Tramos 1 (00, 05, 01), 2 (02, 03) y 3 (04, 06) cerrados; las 7 tareas están tildadas. Sigue integrar el módulo a `main`.

## Tareas
- [x] 00 Gate de CI para el módulo (merge `fcddb2b`)
- [x] 01 Cortar la tormenta de mDNS (merge `da2f623`)
- [x] 02 Errores de red guardados en disco (merge `9ea58db`)
- [x] 03 Envíos más firmes (merge `4a3cb17`)
- [x] 04 Ordenar el backend (lib.rs) (merge `c6ce265`)
- [x] 05 Ordenar el frontend (main.js / styles.css) (merge `bbc9eb3`)
- [x] 06 Tests que faltan (merge `62e4e63`)

## Decisiones cerradas
(ver `SPEC.md`, Riesgos y decisiones)
- Encargos sin tarea propia: 94 sync sin favoritos offline (merge `e650ea3`).
- Encargos sin tarea propia del tramo 2: 93 correcciones del log (merge `d8041b9`); 92 rama del release (no se mergea, ver abajo).
- El release v1.5.3 sale de `modulo/puesta-a-punto--92`: la punta del módulo + revert del merge del 05 (`1e51a65`) + versión 1.5.3 (`3062d07`, CI verde, `src/` idéntico a `main`). Esa rama NO se mergea al módulo (volvería a borrar el 05) y vive en el tag; `main` recibe todo con la integración del módulo, y la próxima versión desde `main` tiene que ser ≥ 1.5.4. Motivo: el portero `git-seguro` solo deja pushear la rama del encargo.
- La mutación en Rust del 93 quedó NO VERIFICADO (el portero niega el push a `ci/**`); el director aceptó el 93 porque hoy ninguna línea escribe contenido (revisor) y un espejo en Node del detector mató 4 mutantes.
- La consulta del 03 sobre el sync a favoritos offline se resolvió con el encargo 94.
- cancelado 92 @8ded8aa: rama del release, no se mergea al módulo (borraría el 05); su commit de versión `3062d07` vive en el tag `v1.5.3`.
- La v1.5.3 quedó publicada el 2026-11-10 como release final (tag `v1.5.3` sobre `3062d07`, `millennium-clipboard.exe` sha256 `531f5998…442d5`, CI 4 checks verde); el push del tag lo frenó el permiso automático y se destrabó con una regla de Guido en `~/.claude/settings.json`.

## Pendientes y "te espera"
- Instalar la v1.5.3 por el updater (Settings → APP UPDATES → CHECK) y borrar de `~/.claude/settings.json` la regla `Bash(git push origin v1.5.3)` (copia en `settings.json.bak-v153`).
- Después de integrar a `main`: bajar el `.exe` del CI de `main` (no es release) y probar que CLIP y DISP funcionan igual con el código ordenado (04 partió `lib.rs`, 05 el frontend): mandar texto y archivo, abrir el log, cambiar un perfil de Displays.
- Del 94: apagar un favorito, cambiar el portapapeles y ver que el log no se llena de fallos.
- Del 02, criterio 3 en vivo según `bitacora/2026-11-10-evidencia-02.md`: buscar `FAILED` en `runtime.log` con el peer apagado.
- Del 03, criterios 4 y 5 en vivo según `bitacora/2026-11-10-evidencia-03.md`; mirar con `ipconfig` que la máscara sea 255.255.255.0, porque el 03 asume /24.
- Decidir si se permiten ramas `ci/**` para mutación (es un freno: lo decide Guido).
- Guido, de día: medir la red con la app nueva (Monitor de recursos / LatencyMon) y probar un envío entre las 2 PCs.
- Del 01, criterios 2 y 5 en vivo, con lo que dice la sección "Para Guido, de día" de `bitacora/2026-11-10-evidencia-01.md`.
- Del 05, mirar la app real (WebView2 y Android) y los flujos que las capturas no disparan (envío, QR, modal de peer, panel de log), según `bitacora/2026-11-10-evidencia-05.md`.

## Sesiones vivas
- director-puesta-a-punto · local_4e773170-93e4-49dc-952b-2edeff49b0c2 · .claude/worktrees/modulo--puesta-a-punto · modulo/puesta-a-punto · noche
