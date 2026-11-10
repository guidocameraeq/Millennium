# SPEC: Puesta a punto — Millennium
Cortar la tormenta de mDNS, dejar todo error de red guardado en disco con fecha, hacer más firmes los envíos entre PCs y ordenar el código por dentro con los tests en verde.
- Estado: COMPLETO 2026-11-10
- Fecha: 2026-11-10
- Sello del Arquitecto: `arquitecto: 2026-11-10 · kit 3.0.0-rc.6 · chequeos: tamaño ✅ · entorno ✅ · tope ✅ · hash f23baa203c8b`

## Pedido original, textual
> "Encontré la causa: millennium-clipboard.exe (tu app, v1.5.2) inunda la red con ~3.500 paquetes mDNS/seg a 224.0.0.251:5353, lo que carga la CPU 0 con 23–44% de DPC en ndis.sys. Lo cerré; ahora el tráfico es normal. Falta confirmar con LatencyMon y arreglar el bucle en tu código."
>
> "Después, por otro lado, a lo largo del tiempo, cuando uso la app, hay errores que no se pueden comunicar, no se pueden mandar archivos y ese log no se guarda en ningún lado. Se debería guardar en algún lugar, aunque sea, no sé, para que eventualmente los podamos ir corrigiendo. La app es muy inconsistente. Sobre todo el tema del... Lo que es inconsistente es pasar archivos y comunicarse entre las PCs. Algo pasa ahí. Y no lo sé. No, nunca me senté a arreglarlo. A veces algún día funciona la app, otro día no. Es muy inconsistente. También el arquitecto en otra sesión había visto que había que arreglar algo del código. Que iba a tardar, pero bueno. Quiero dejar el repo, la verdad que usable, porque a mí me gusta y yo lo uso bastante."
>
> "...Una, la del director para leer el código que va a correr en loop, tratando de organizar todo con sus agentes en modo noche, que los tests pasen en verde, dejar todo ordenado, corregir el tema de los errores, ver que esos logs se guardan en un lado."

## Por qué (el dolor)
La v1.5.2 manda miles de paquetes por segundo a la red y le come la CPU a la PC: Guido tuvo que cerrarla, así que hoy no puede usar su app diaria. Además, pasar archivos entre PCs falla un día sí y otro no, y cuando falla no queda rastro: el error se ve un segundo en pantalla y desaparece. Y el código está mezclado (Clipboard y Displays en los mismos archivos gigantes), lo que hace que cada arreglo sea más caro y riesgoso.

## Contexto del código (de la exploración — nombres REALES, con archivo:línea)
**mDNS (la tormenta)** — crate `mdns-sd` 0.13.11 (`src-tauri/Cargo.toml:22`, `Cargo.lock:2605`). Todo en `src-tauri/src/discovery.rs`:
- Un solo `ServiceDaemon::new()` (`discovery.rs:261`), creado una vez desde el setup (`lib.rs:2155`).
- `discovery.rs:263-280`: **escucha en TODAS las interfaces IPv4** (WSL, Hyper-V, Docker, VPN) y suma la IP elegida. El comentario dice que antes era `disable_interface(All)` + `enable(local_ip)` y se cambió porque elegía mal la placa. Es el sospechoso #1.
- `register_self` (`discovery.rs:785-808`) anuncia **una sola IP** (`id.local_ip`) con hostname sacado del alias (`:798`). Hipótesis #1: en cada interfaz virtual la respuesta sale sin dirección A de esa subred → quien escucha re-pregunta sin parar (incluida la propia app por loopback del multicast). Hipótesis #2: el watcher de red (`:660-700`, cada 30 s) re-registra sin `unregister` y deja habilitadas las placas viejas; `rebrowse()` (`:717-718`, botón refresh, `main.js:1091`) abre otro browse y tira el receiver.
- En ninguna parte se llama a `unregister` ni a `shutdown`. El UDP hello (`udp_discovery.rs`, puerto 53318, cada 5 s) no toca el 5353.

**Errores que no se guardan** — `src-tauri/src/runtime_log.rs`:
- Sí escribe a disco: `%APPDATA%\com.guidocameraeq.millennium\runtime.log` (abierto en `lib.rs:1802-1804`, append en `runtime_log.rs:58-88`), rota solo al arrancar si pasa 5 MB (`:60-66`), un único backup. **La hora es UTC y sin fecha** (`:90-103`). Si escribir falla, se calla (`:122`).
- El camino de red casi no lo usa: `send_text`/`send_files` (`lib.rs:153-300`) usan `println!` (`:153`, `:247`) y devuelven el error a la UI sin loguearlo (`:176`, `:271`, `:288`); la UI solo muestra `ERR transmit` (`main.js:1014-1018`, `:1066-1070`). `http_client.rs` no tiene ni un `runtime_log` (reintentos con `eprintln`, `:387`). `http_server.rs` tiene uno solo (`:169`); el resto es `eprintln!`/`println!` (`:558-667`, `:702-711`), que en release se pierde. `docs/DECISIONS.md:62` dice "nunca `println!`": hoy es falso en la red.

**Por qué "un día anda, otro no"** (candidatos, sin confirmar en vivo):
- Cliente HTTPS cacheado para siempre por huella (`http_client.rs:141-152`), **sin `connect_timeout`** y con 300 s de timeout total (`:129-133`): a una IP vieja, el envío se cuelga minutos.
- El hello UDP va a `255.255.255.255` (`udp_discovery.rs:125-128`): Windows lo saca por UNA sola placa (la de mejor métrica, a veces la virtual).
- mDNS toma la primera dirección que venga (`discovery.rs:853-858`), puede ser la virtual. `pick_local_ipv4` elige la primera privada no virtual en el orden del sistema, con un filtro por nombre (`identity.rs:114-153`).
- `PEER_TTL` = 15 s (`discovery.rs:363-365`): si se pierden 3 hellos por Wi-Fi, el peer desaparece y el envío da "peer not on the grid" (`lib.rs:151`) aunque esté vivo.
- Si el puerto 53319 está ocupado, el server se corre a 53320-53328 (`lib.rs:2078-2099`); favoritos y manuales guardan el puerto viejo.
- Ninguna regla de firewall en el repo: depende del cartel de Windows (perfil Público/Privado).

**El código mezclado**:
- `src-tauri/src/lib.rs` (2.432 líneas): comandos de clipboard (1-648), updater (650-706), poller del clipboard (708-1012, dos `spawn_clipboard_poller` por cfg en `:719` y `:853`), runtime log (1014-1122), comandos `displays_*` (1153-1689), `run()` con los dos temas juntos (1704-2342), `build_tray` (2343-fin).
- `src/main.js` (4.051 líneas, un solo archivo con secciones `// ----`): Clipboard 88-1634, Displays 1635-3327, Clipboard otra vez 3328-3722, arranque 3723-fin. `src/styles.css` 3.764 líneas. Sin bundler (`package.json` solo tiene el script `tauri`).

**Tests y CI**:
- `src-tauri/displays-tests/` (crate sin Tauri) incluye por `#[path]` `json_store`, `ids`, `store`, `watchdog` (`displays-tests/src/lib.rs:34-52`). `cargo test` sobre la app muere en Windows (`STATUS_ENTRYPOINT_NOT_FOUND`, ADR-011). Los tests de `discovery.rs:959`, `identity.rs:167` y `displays/mod.rs` no corren en ningún lado.
- Workflows: `displays-tests.yml` (push a `main`, `feat/displays`, `ci/**`; exige ≥10 tests, `:70-80`), `android-cfg-gate.yml` (mismas ramas, `cargo check` Android), `build.yml` (push a `main` y `feat/displays`, `npm run tauri build`), `release.yml` (tag `v*`, publica; con guion en el tag es prerelease, `:150`). Sin clippy. **Las ramas `modulo/**` no disparan ningún CI.**
- **Esta PC no tiene Rust** (ni `cargo` ni `~/.rustup`): todo `cargo` corre en GitHub. `vars.comando-test` de `.claude/kit.md` es `node .claude/scripts/estructura.cjs` (chequea la estructura del repo, no el código).
- No hay `gh`: la API de GitHub se usa con la credencial de git (así se hizo en la sesión de partición de repos).
- Versión: `src-tauri/tauri.conf.json:4` y `src-tauri/Cargo.toml:3` dicen `1.5.2` (`package.json` dice `1.0.0` y no se toca).

## AGREGA (lo nuevo)
- **Gate de CI** (encargo 00): los workflows de test (`displays-tests.yml`, `android-cfg-gate.yml`, y un `cargo check` + `cargo clippy` de Windows sobre la app) también corren en `modulo/**`. Un script `.claude/scripts/ci-verde.cjs <sha>` que consulta la API de GitHub (credencial de git, nunca impresa) y sale 0 si todos los checks de ese commit pasaron, 1 si alguno falló (diciendo cuál), 2 si siguen corriendo; con `--esperar` espera hasta 25 min. Lo usan el director y los obreros como gate de compilación.
- **Medidor de mDNS**: cada 60 s el log anota cuántos paquetes mandó y recibió el daemon en ese minuto (mdns-sd tiene métricas del daemon; si no, un contador propio). Una línea, solo si hubo tráfico.
- **Log de errores útil**: cada línea con **fecha y hora local** (`2026-11-10 23:14:05`); rotación también en caliente (al pasar 5 MB), con 3 archivos de respaldo (`runtime.log.1..3`). Cada error de envío, recepción, handshake, pin de certificado, reintento y descubrimiento queda escrito en las dos PCs (la que manda y la que recibe), con el peer (alias + IP:puerto) y la causa.
- **Una línea de diagnóstico al arrancar**: versión, placas de red vistas (nombre, IP, si se descartó por virtual), IP elegida, puerto del server. Es lo primero que se mira cuando "hoy no anda".
- Tests nuevos en un crate sin Tauri (como `displays-tests/`, o sumándolos ahí) para: el formato de la línea del log, la elección de placa de red y la elección de dirección del peer.

## MODIFICA (lo existente que se toca)
- `discovery.rs:263-280` y `register_self`: el daemon escucha y anuncia **solo en placas reales** (las que pasan el filtro de `identity.rs`), y anuncia la dirección que corresponde a cada placa (en mdns-sd, `enable_addr_auto` o registrar las IPs de las placas habilitadas). Antes de re-registrar, `unregister` del registro viejo y deshabilitar la placa vieja. `rebrowse` deja de apilar browses (`stop_browse` antes, o reusar el receiver). **Efecto a cuidar**: el comentario de `:263-269` existe porque en PCs con WSL/Hyper-V la versión de una sola placa elegía mal y nadie veía a nadie; el arreglo tiene que seguir descubriendo a la otra PC por la placa buena. El obrero primero confirma la causa con un investigador sobre la doc y el código de mdns-sd 0.13.
- `runtime_log.rs`: formato de hora, rotación en caliente, avisar (una vez, por stderr y al ring) si no puede escribir. **Efecto a cuidar**: la API `runtime_log::info/warn/error` no cambia (CLAUDE.md, regla operativa 4); el panel de log de la app (`main.js:1314`) sigue mostrando lo mismo.
- `lib.rs` (send), `http_client.rs`, `http_server.rs`: todo `println!`/`eprintln!` del camino de red pasa a `runtime_log`. **Efecto a cuidar**: nunca loguear el contenido del texto enviado ni del portapapeles (solo tamaño y nombre de archivo).
- `http_client.rs:129-133`: `connect_timeout` de 5 s y keepalive TCP; si un envío falla por conexión, se descarta el cliente cacheado de esa huella para que el próximo arme uno nuevo. **Efecto a cuidar**: el pin del certificado (`:73-81`) y el resume (`:358-396`) quedan iguales.
- `udp_discovery.rs`: el hello sale **por cada placa real**, a la broadcast de su subred (además del `255.255.255.255` de hoy, para los peers viejos). **Efecto a cuidar**: el formato del hello no cambia (regla operativa 5).
- `discovery.rs:853-858`: de las direcciones que trae mDNS se prefiere la que está en la misma subred que una placa propia.
- `discovery.rs:363-381`: un favorito no se borra del mapa por TTL, se marca offline (sigue siendo destino de envío con su última IP:puerto conocida). **Efecto a cuidar**: los no favoritos siguen desapareciendo a los 15 s (TARGET LOST del TODO 🔴 depende de eso).
- `lib.rs` → se parte en módulos sin cambiar comportamiento: comandos de clipboard, comandos de displays, poller del clipboard, updater/log, tray, y `run()` queda como el armado. **Efecto a cuidar**: los nombres de los comandos `#[tauri::command]` y su `invoke_handler` no cambian (el frontend los llama por nombre); los `#[cfg(target_os = ...)]` se mantienen idénticos.
- `src/main.js` → varios archivos (`src/js/…`: comunes, clipboard, displays, arranque), cargados en el mismo orden desde `index.html`; un solo `state` global (regla operativa 6). `src/styles.css` → partido igual (comunes, clipboard, displays). Mover, no reescribir. **Efecto a cuidar**: la CSP de Tauri tiene que permitir los archivos nuevos (`tauri.conf.json`); la pantalla se ve igual (captura antes/después).
- Los 4 tests de `displays/mod.rs` (`DisplayView`, `mark_can_detach`, `sort_for_display`) pasan a un archivo sin Windows y se suman a `displays-tests` (TODO 🟡).
- `.github/workflows/build.yml`: `paths-ignore` de `docs/**` y `**.md`, y sale `feat/displays` de los triggers (TODO 🟡). `displays-tests.yml` sube el mínimo de tests al número nuevo.
- `.claude/kit.md`: `vars.comando-test` pasa a `node .claude/scripts/ci-verde.cjs --esperar HEAD` (+ el chequeo de estructura), en `modulo/puesta-a-punto`.
- `docs/DECISIONS.md`: un ADR nuevo sobre placas de red (cuáles se usan para mDNS y UDP, y por qué) y otro sobre el log (dónde vive, formato, qué nunca se loguea).
- Versión `1.5.3` en `tauri.conf.json` y `Cargo.toml` para el release del arreglo de red.

## NO SE TOCA (obligatoria — el seguro de no romper)
- El formato del hello UDP y el JSON de `/info`: si se extienden, campos opcionales (hay peers viejos y el repo `MillenniumClipboard` habla el mismo protocolo).
- La identidad y los datos del usuario en `%APPDATA%\com.guidocameraeq.millennium\`: `identity.json`, favoritos, alias, iconos, peers manuales, ajustes, perfiles de Displays. Ni se migran ni se renombran.
- El motor de transferencia: streaming, resume y pin del certificado se tocan solo donde dice MODIFICA.
- El motor de Displays (`src-tauri/src/displays/`, `vendor/monarch`): solo se mueven los tests de `mod.rs`; la lógica CCD, el watchdog y el auto-revert no se tocan (doctrina "PROHIBIDO simplificar", `docs/DECISIONS.md`).
- Android: `src-tauri/gen/android/` y el Rust bajo `#[cfg(target_os = "android")]` solo se mueven de archivo, idénticos; nunca `tauri android init`. El `android-cfg-gate` tiene que seguir verde.
- El nombre del binario `millennium-clipboard.exe`, el identifier `com.guidocameraeq.millennium`, el `name` de `package.json` y la constante del updater (`updater.rs:15`).
- `docs/remediation/` (spec de Android): no se edita.
- `docs/modulos/escenas/` (lo diseña otra sesión).
- El updater, el tray, los atajos globales y el autostart: se mudan de archivo pero hacen lo mismo.

## Criterios de aceptación (3-8, verificables)
1. Todo lo de NO SE TOCA sigue igual: `git diff main...modulo/puesta-a-punto` no toca ninguna ruta de esa lista salvo los movimientos de archivo que dice MODIFICA, y en las 2 PCs se manda texto y un archivo en las dos direcciones con la versión nueva (**necesita a Guido de día**).
2. CUANDO la app nueva está abierta 10 minutos en reposo en la PC de Guido, el medidor del log DEBE mostrar menos de 120 paquetes mDNS mandados por minuto, y el Monitor de recursos de Windows (o LatencyMon) DEBE mostrar el DPC de `ndis.sys` en valores normales (**necesita a Guido de día**; lo mecánico —el medidor existe y un test cubre la elección de placas— lo verifica el director).
3. CUANDO un envío o una recepción falla (peer apagado, pin que no coincide, disco lleno, corte a mitad), el `runtime.log` de la PC donde pasó DEBE tener una línea con fecha y hora local, el peer y la causa; y SI el texto mandado era un secreto, ENTONCES el log NO DEBE contenerlo (test del formato + prueba a mano de Guido).
4. CUANDO se manda a un peer cuya IP ya no responde, el envío DEBE fallar en 10 s o menos con un mensaje claro, no colgarse minutos.
5. CUANDO la PC tiene placas virtuales (WSL/Hyper-V/VPN) además de la real, la otra PC DEBE descubrirla por la placa real (por UDP o mDNS) sin tocar REFRESH; la línea de diagnóstico del arranque DEBE listar qué placas descartó y por qué.
6. `src-tauri/src/lib.rs` queda en menos de 800 líneas, ningún archivo de `src/js/` pasa de 1.500, y la app se ve y se comporta igual (capturas antes/después de CLIP y DISP).
7. En `modulo/**` y en `main`, el CI corre `cargo check` + `clippy` de Windows, `displays-tests` (con los tests nuevos y los 4 de `mod.rs` sumados) y el `android-cfg-gate`, y todos dan verde en el último commit del módulo; `ci-verde.cjs` lo confirma.

## Ejecución
Tamaño: módulo con director
- Sesiones: director con sus obreros, en modo noche (Guido no está). Un encargo por tarea.
- Rama y worktree: `modulo/puesta-a-punto` en `.claude/worktrees/modulo--puesta-a-punto`, los crea `worktree.cjs crear puesta-a-punto`.
- Para abrir: lo que imprime `worktree.cjs` (`primer mensaje: /director puesta-a-punto`).
- Cómo se prueba: ver "Entorno de prueba".
- **Orden y carriles** (los encargos de un carril van uno detrás del otro; los dos carriles pueden ir a la vez porque tocan archivos distintos):
  - **00 Gate de CI** (primero y solo): triggers en `modulo/**`, job `cargo check` + `clippy` (clippy en modo aviso, no rompe el gate todavía), `paths-ignore` de docs, `ci-verde.cjs`, `comando-test` nuevo. Hasta que no esté verde, no se reparte otro encargo.
  - **Carril backend**: **01 mDNS** → **02 Log** → **03 Envíos firmes** → **04 Ordenar `lib.rs`** → **06 Tests que faltan**.
    - 01: confirmar la causa (investigador sobre mdns-sd 0.13 + leer el código), arreglarla, sumar el medidor. Lo más urgente.
    - 02: todo lo del log de AGREGA/MODIFICA.
    - **Release `v1.5.3`** = 00 + 01 + 02 mergeados a `main` con CI verde: subir la versión, tag `v1.5.3` (sin guion: release final, llega por el updater, lo eligió Guido), y anotar en la ficha "te espera: medir la red y probar un envío". El orden del código **no** entra en ese release.
    - 03 a 06: van a `main` con gate verde pero **sin release**; el próximo release (con el código ordenado) lo decide Guido de día.
  - **Carril frontend**: **05 Ordenar `main.js`/`styles.css`**, en paralelo con 01-03 (no comparten archivos). Captura antes/después de CLIP y DISP con mock de `__TAURI__` + Playwright (como se hizo para la landing).
- **04 va después de 03**: parte `lib.rs`, que 01-03 también tocan; arrancarlo antes es pisarse.
- Cada obrero, al terminar, empuja su rama y espera `ci-verde.cjs --esperar`: sin verde no hay merge.
- Cierre de tramo: cada 2 encargos.

## Entorno de prueba
- Cómo se levanta: no se levanta local (no hay Rust en la PC). Compila y testea el CI de GitHub sobre la rama pusheada; `node .claude/scripts/ci-verde.cjs --esperar <sha>` da el resultado.
- Datos semilla: no hay base de datos. Los tests usan archivos temporales (como hoy `displays-tests`). Nunca se toca el `%APPDATA%` real de Guido.
- Chequeo base (verde antes de tocar código): el último commit de `main` tiene verde `displays-tests` y `android-cfg-gate` en GitHub (se mira con `ci-verde.cjs` una vez hecho el 00; antes, por la API a mano), y `node .claude/scripts/estructura.cjs` sale 0.
- Compartido entre carriles o por worktree: el CI de GitHub es compartido (cola de Actions). Cada obrero en su worktree y su rama; nadie pushea a la rama de otro.
- Herramientas, cada una con su chequeo de una línea:
  - git con credencial de GitHub: `git ls-remote origin HEAD` responde.
  - Node: `node --version` ≥ 18.
  - Playwright (solo encargo 05): `npx playwright --version`.
  - Las 2 PCs, el Monitor de recursos y LatencyMon: **necesita a Guido de día** (criterios 1, 2 y 3 en vivo).

## Supuestos
- [ALTO] [SIN CONTRASTAR] La tormenta sale de escuchar en todas las placas y anunciar una sola IP (hipótesis #1). Si la causa es otra (re-registro o browses apilados), el encargo 01 lo arregla igual: el obrero confirma la causa antes de tocar, y los dos frentes están en MODIFICA.
- [ALTO] [SIN CONTRASTAR] La inconsistencia de los envíos sale de la mezcla de candidatos de arriba (placa equivocada, cliente colgado, TTL corto, puerto corrido, firewall). No se reprodujo en vivo. Por eso el log va antes que los arreglos de envío: si con 03 no alcanza, el log de las próximas semanas dice qué falta.
- [BAJO] mdns-sd 0.13 alcanza para el arreglo. Si hace falta subir de versión, el obrero lo propone en su evidencia y el director decide (un bump menor del mismo crate no cambia el protocolo mDNS).
- [BAJO] Partir `main.js` en scripts comunes (no ES modules) mantiene el `state` global y el orden de carga sin bundler. Si la CSP o Tauri complican, ES modules con `type="module"` es la alternativa.
- [BAJO] El rediseño de escenas de Displays (`docs/modulos/escenas/`, otra sesión) se ejecuta DESPUÉS de que este módulo mergee el orden del código.

## Riesgos y decisiones ⚠️
- ⚠️ **Gate de compilación = CI de GitHub, sin Rust en la PC** (Guido, 2026-11-10). Consecuencia: cada vuelta del obrero tarda ~6-10 min de espera; de noche alcanza. Si un día se instala Rust + VS Build Tools, `comando-test` pasa a local.
- ⚠️ **El arreglo de red sale como release final `v1.5.3` por el updater** (Guido, 2026-11-10). Consecuencia: llega a las 2 PCs sin que nadie la haya probado en vivo antes. Para achicarlo: el release lleva **solo** 00 + 01 + 02 (no el orden del código), con CI verde. Si algo sale mal, el log nuevo lo dice y se vuelve atrás bajando el `.exe` de `v1.5.2` de GitHub Releases.
- ⚠️ **El orden del código no sale en release sin Guido.** Consecuencia: 03-06 quedan en `main` y en el `.exe` del CI, no en el updater, hasta su OK.
- ⚠️ **Las reglas de firewall de Windows NO las crea la app** (piden admin y es tocar la seguridad del sistema). Consecuencia: si el firewall es la causa, el log y la línea de diagnóstico lo van a mostrar y se decide aparte.
- ⚠️ **Mover código, no reescribir** (CLAUDE.md, regla operativa 1). Consecuencia: el orden de `lib.rs`/`main.js` es mecánico; un obrero que quiera "mejorar" lógica de paso lo deja anotado y no lo hace.
- ⚠️ **No se loguea contenido** (texto, portapapeles), solo metadatos. Consecuencia: para depurar un envío de texto puntual no alcanza el log; es a propósito, porque el log se pega en chats.

### Alternativas evaluadas y descartadas
- Instalar Rust en la PC para compilar local: descartado por ahora (Guido): varios GB y necesita estar él; retrasaba arrancar esta noche.
- Mandar el arreglo como `.exe` suelto para probar antes: descartado (Guido): prefiere que le llegue por el updater.
- Volver a `disable_interface(All)` + una sola placa (como era antes): descartado tal cual, porque fue lo que hacía que nadie viera a nadie con WSL/Hyper-V (`discovery.rs:263-269`); el arreglo va por "solo placas reales, cada una con su dirección".
- Un bundler para el frontend (Vite, etc.): descartado: cambia cómo se arma la app y no hace falta para partir archivos.
- Reescribir el motor de red: descartado: el audit 2026-07-06 dice que el núcleo es bueno (CLAUDE.md, regla operativa 1).
