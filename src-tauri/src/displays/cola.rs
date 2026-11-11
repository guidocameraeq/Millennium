// Cola de acciones de las escenas (módulo escenas, encargo 03).
//
// Las acciones de una escena corren en UN hilo propio, en fila: así `confirm` avisa
// "confirmed" al toque aunque haya un Esperar 30, y dos escenas seguidas no pisan sus acciones.
//
// Este archivo es PURO: no nombra a `windows` ni a `tauri`. Lo que de verdad toca la PC
// (lanzar, volumen, cerrar ventanas, dormir) entra por los traits `Ejecutor` y `Reloj`; en el
// programa los implementa `acciones.rs`, y en las pruebas (`displays-tests`) unos falsos.
//
// Reglas (spec, "Cola de acciones"):
// - Una lista nueva cancela los Esperar que quedan de las anteriores (los otros pasos siguen).
// - Tope total de 60 s por lista: pasado el tope, lo que falta se saltea y queda en el log.
// - Un paso que falla no frena a los demás (el ejecutor loguea y vuelve).
//
// panic="abort": nada de `unwrap`/`expect` acá; un lock envenenado se trata como "sin cancelar".
#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use monarch::ActionV2;

/// Tope de tiempo de una lista entera (esperas y cierres incluidos).
pub const TOPE_TOTAL: Duration = Duration::from_secs(60);

/// Lo que de verdad hace cada paso. Nunca entra por acá un `Esperar`: lo maneja la cola.
pub trait Ejecutor: Send + 'static {
    fn lanzar(&mut self, destino: &str, args: &[String]);
    fn volumen(&mut self, nivel: u8);
    fn cerrar(&mut self, exe: &str);
}

/// El tiempo. `dormir` espera `dur` o se corta antes si `cancelado()` da `true`; devuelve
/// `true` si esperó todo. `ahora` es un reloj que solo avanza (desde un origen cualquiera).
pub trait Reloj: Send + 'static {
    fn ahora(&self) -> Duration;
    fn dormir(&self, dur: Duration, cancelado: &dyn Fn() -> bool) -> bool;
}

/// Corre una lista en orden. `cancelado()` = "llegó una escena más nueva": se saltea el resto
/// de los Esperar, pero no los demás pasos. Devuelve cuántos pasos se saltearon por el tope.
pub fn correr_lista(
    ejecutor: &mut dyn Ejecutor,
    reloj: &dyn Reloj,
    lista: &[ActionV2],
    cancelado: &dyn Fn() -> bool,
) -> usize {
    let inicio = reloj.ahora();
    for (i, accion) in lista.iter().enumerate() {
        let gastado = reloj.ahora().saturating_sub(inicio);
        if gastado >= TOPE_TOTAL {
            let salteados = lista.len() - i;
            crate::runtime_log::warn(format!(
                "[displays] la lista de acciones pasó el tope de {} s: se saltean {salteados} paso/s",
                TOPE_TOTAL.as_secs()
            ));
            return salteados;
        }
        match accion {
            ActionV2::Lanzar { destino, args, .. } => ejecutor.lanzar(destino, args),
            ActionV2::Volumen { nivel } => ejecutor.volumen(*nivel),
            ActionV2::Cerrar { exe } => ejecutor.cerrar(exe),
            ActionV2::Esperar { segundos } => {
                if cancelado() {
                    crate::runtime_log::info(format!(
                        "[displays] esperar {segundos} s cancelado: llegó otra escena"
                    ));
                    continue;
                }
                // Lo que queda del tope: un Esperar no lo puede pasar.
                let resto = TOPE_TOTAL - gastado;
                let dur = Duration::from_secs(u64::from(*segundos)).min(resto);
                if !reloj.dormir(dur, cancelado) {
                    crate::runtime_log::info(
                        "[displays] la espera se cortó: llegó otra escena".to_string(),
                    );
                }
            }
            // Una acción de una versión más nueva (o HDR hasta el encargo 03b): no se corre.
            ActionV2::Desconocida => {
                crate::runtime_log::warn("[displays] acción desconocida; se saltea".to_string());
            }
        }
    }
    0
}

struct Trabajo {
    lista: Vec<ActionV2>,
    generacion: u64,
}

/// El hilo de acciones. `encolar` vuelve al toque; la lista corre en el hilo propio.
pub struct Cola {
    tx: Mutex<Sender<Trabajo>>,
    generacion: Arc<AtomicU64>,
}

impl Cola {
    /// Levanta el hilo con su ejecutor y su reloj. Si el SO no deja crear el hilo, la cola
    /// queda sin hilo y `encolar` loguea en vez de correr (nunca se cae la app por esto).
    pub fn nueva<E: Ejecutor, R: Reloj>(mut ejecutor: E, reloj: R) -> Self {
        let (tx, rx) = channel::<Trabajo>();
        let generacion = Arc::new(AtomicU64::new(0));
        let g = Arc::clone(&generacion);
        let hilo = std::thread::Builder::new()
            .name("displays-acciones".to_string())
            .spawn(move || {
                while let Ok(trabajo) = rx.recv() {
                    let g = Arc::clone(&g);
                    let mia = trabajo.generacion;
                    let cancelado = move || g.load(Ordering::SeqCst) != mia;
                    correr_lista(&mut ejecutor, &reloj, &trabajo.lista, &cancelado);
                }
            });
        if let Err(e) = hilo {
            crate::runtime_log::warn(format!(
                "[displays] no se pudo crear el hilo de acciones: {e}"
            ));
        }
        Self {
            tx: Mutex::new(tx),
            generacion,
        }
    }

    /// Pone una lista en la fila y vuelve al toque. Cancela los Esperar que quedan de las
    /// listas anteriores. Una lista vacía no hace nada (ni cancela).
    pub fn encolar(&self, lista: Vec<ActionV2>) {
        if lista.is_empty() {
            return;
        }
        let generacion = self.generacion.fetch_add(1, Ordering::SeqCst) + 1;
        let enviado = match self.tx.lock() {
            Ok(tx) => tx.send(Trabajo { lista, generacion }).is_ok(),
            Err(_) => false,
        };
        if !enviado {
            crate::runtime_log::warn(
                "[displays] las acciones de la escena no se pudieron encolar".to_string(),
            );
        }
    }
}

/// El reloj de verdad: duerme en tajadas de 100 ms para poder cortarse.
pub struct RelojReal {
    origen: std::time::Instant,
}

impl RelojReal {
    pub fn nuevo() -> Self {
        Self {
            origen: std::time::Instant::now(),
        }
    }
}

impl Reloj for RelojReal {
    fn ahora(&self) -> Duration {
        self.origen.elapsed()
    }

    fn dormir(&self, dur: Duration, cancelado: &dyn Fn() -> bool) -> bool {
        let tajada = Duration::from_millis(100);
        let fin = std::time::Instant::now() + dur;
        loop {
            if cancelado() {
                return false;
            }
            let ahora = std::time::Instant::now();
            if ahora >= fin {
                return true;
            }
            std::thread::sleep(tajada.min(fin - ahora));
        }
    }
}
