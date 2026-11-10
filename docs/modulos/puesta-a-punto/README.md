# Puesta a punto: red sana, errores guardados, código ordenado
- Estado: EN OBRA
- director: sí
- rama: modulo/puesta-a-punto
- Próximo paso: el encargo 02 (errores de red guardados), y después el encargo del release v1.5.3.
- Cierre de tramo: cada 2 encargos
- Tramo: 1 cerrado 2026-11-10

## Qué es
Pedido del 2026-11-10: cortar la tormenta de mDNS que carga la CPU, que todo error de red quede guardado en disco con fecha, que pasar archivos entre PCs deje de ser "un día anda, otro no", y ordenar el código por dentro (lib.rs, main.js, styles.css) con los tests en verde. Lo corre un director con obreros, de noche.

## Fase y próximo paso
Spec en `SPEC.md`. Tramo 1 cerrado (00, 05, 01). Sigue el 02; después el release v1.5.3.

## Tareas
- [x] 00 Gate de CI para el módulo (merge `fcddb2b`)
- [x] 01 Cortar la tormenta de mDNS (merge `da2f623`)
- [ ] 02 Errores de red guardados en disco
- [ ] 03 Envíos más firmes
- [ ] 04 Ordenar el backend (lib.rs)
- [x] 05 Ordenar el frontend (main.js / styles.css) (merge `bbc9eb3`)
- [ ] 06 Tests que faltan

## Decisiones cerradas
(ver `SPEC.md`, Riesgos y decisiones)
- Release v1.5.3 (director, 2026-11-10): sale de una rama armada desde `main` con el 01 (punta `23c884c`, que no trae el 05) más los commits del 02, porque el 05 (orden del frontend) ya está en `modulo/puesta-a-punto` y el spec dice que el orden del código no va en ese release (SPEC.md:101, :129).

## Pendientes y "te espera"
- Guido, de día: medir la red con la app nueva (Monitor de recursos / LatencyMon) y probar un envío entre las 2 PCs.
- Del 01, criterios 2 y 5 en vivo, con lo que dice la sección "Para Guido, de día" de `bitacora/2026-11-10-evidencia-01.md`.
- Del 05, mirar la app real (WebView2 y Android) y los flujos que las capturas no disparan (envío, QR, modal de peer, panel de log), según `bitacora/2026-11-10-evidencia-05.md`.

## Sesiones vivas
- director-puesta-a-punto · local_4e773170-93e4-49dc-952b-2edeff49b0c2 · .claude/worktrees/modulo--puesta-a-punto · modulo/puesta-a-punto · noche
- obrero 02 (de fondo) · — · .claude/worktrees/modulo--puesta-a-punto--02 · modulo/puesta-a-punto--02 · auto
