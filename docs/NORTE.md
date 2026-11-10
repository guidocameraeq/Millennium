# NORTE — Millennium

> El plano de la app en una pantalla: lo lee quien llega de afuera y todo agente antes de tocar nada. Sin lista de módulos (la derivan las fichas) y sin "quién lo opera".

## Qué es
Una app de escritorio para Windows (con versión Android) que junta dos herramientas detrás de un mismo switch: **Clipboard**, que comparte texto, archivos y portapapeles entre tus dispositivos de la misma Wi-Fi, y **Displays**, que maneja los monitores (perfiles de un clic, prender y apagar la TV con vuelta atrás automática, audio por perfil).

## Para qué y para quién
- Para qué: pasar cosas entre la PC y el celular u otra PC sin nube ni cuentas, y cambiar el setup de pantallas (trabajo, jugar en la TV, películas) en un clic sin quedarse sin imagen.
- Quién lo usa: Guido, a diario, en su escritorio de 3 pantallas. Es público en GitHub (`guidocameraeq/Millennium`) y se actualiza solo con el updater de la app.

## Qué NO hace
- No usa nube, servidor ni cuentas: todo viaja por la red local.
- Displays no existe fuera de Windows (en Android solo está Clipboard).
- No es el clipboard solo: ese producto vive aparte, en el repo `guidocameraeq/MillenniumClipboard`.
- Android hoy no anda bien: su arreglo está planeado (`docs/remediation/android/`) pero no ejecutado.

## Lo que solo sabe el dueño
> Los hechos que no están en el código: cómo se usa de verdad, qué pasa si se cae. Puede nacer vacía y llenarse cuando aparezcan.

- El `.exe` sale del CI de GitHub: en esta PC no se compila (no hay Rust; el build local estaba roto por `dlltool`).
