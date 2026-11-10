# Puesta a punto: red sana, errores guardados, código ordenado
- Estado: EN OBRA
- director: sí
- rama: modulo/puesta-a-punto
- Próximo paso: el director arma el encargo 00 (gate de CI)
- Cierre de tramo: cada 2 encargos

## Qué es
Pedido del 2026-11-10: cortar la tormenta de mDNS que carga la CPU, que todo error de red quede guardado en disco con fecha, que pasar archivos entre PCs deje de ser "un día anda, otro no", y ordenar el código por dentro (lib.rs, main.js, styles.css) con los tests en verde. Lo corre un director con obreros, de noche.

## Fase y próximo paso
Spec en `SPEC.md`. Arranca por el gate de CI (sin Rust en la PC, el CI es el único que compila).

## Tareas
- [ ] 00 Gate de CI para el módulo
- [ ] 01 Cortar la tormenta de mDNS
- [ ] 02 Errores de red guardados en disco
- [ ] 03 Envíos más firmes
- [ ] 04 Ordenar el backend (lib.rs)
- [ ] 05 Ordenar el frontend (main.js / styles.css)
- [ ] 06 Tests que faltan

## Decisiones cerradas
(ver `SPEC.md`, Riesgos y decisiones)

## Pendientes y "te espera"
- Guido, de día: medir la red con la app nueva (Monitor de recursos / LatencyMon) y probar un envío entre las 2 PCs.

## Sesiones vivas
