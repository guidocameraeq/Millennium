//! Encargo 03 de escenas, sub-paso 2: la cola de acciones (`displays/cola.rs`), con un
//! ejecutor y un reloj falsos. Nada de esto toca la PC.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use monarch::ActionV2;

use crate::displays::cola::*;

/// Lo que pasó y cuánto tiempo "falso" corrió: lo comparten el ejecutor y el reloj.
#[derive(Default)]
struct Mundo {
    eventos: Vec<String>,
    reloj: Duration,
}

type Compartido = Arc<Mutex<Mundo>>;

fn anotar(m: &Compartido, texto: impl Into<String>) {
    if let Ok(mut m) = m.lock() {
        m.eventos.push(texto.into());
    }
}

fn eventos(m: &Compartido) -> Vec<String> {
    m.lock().map(|m| m.eventos.clone()).unwrap_or_default()
}

/// El ejecutor falso: anota y, si hace falta, "tarda" `cuesta_cerrar`.
struct EjecutorFalso {
    mundo: Compartido,
    cuesta_cerrar: Duration,
}

impl Ejecutor for EjecutorFalso {
    fn lanzar(&mut self, destino: &str, _args: &[String]) {
        anotar(&self.mundo, format!("lanzar {destino}"));
    }
    fn volumen(&mut self, nivel: u8) {
        anotar(&self.mundo, format!("volumen {nivel}"));
    }
    fn cerrar(&mut self, exe: &str) {
        anotar(&self.mundo, format!("cerrar {exe}"));
        if let Ok(mut m) = self.mundo.lock() {
            m.reloj += self.cuesta_cerrar;
        }
    }
}

/// El reloj falso para `correr_lista`: dormir no duerme, suma.
struct RelojFalso {
    mundo: Compartido,
}

impl Reloj for RelojFalso {
    fn ahora(&self) -> Duration {
        self.mundo.lock().map(|m| m.reloj).unwrap_or_default()
    }
    fn dormir(&self, dur: Duration, _cancelado: &dyn Fn() -> bool) -> bool {
        if let Ok(mut m) = self.mundo.lock() {
            m.reloj += dur;
            m.eventos.push(format!("dormir {}", dur.as_secs()));
        }
        true
    }
}

fn lanzar(destino: &str) -> ActionV2 {
    ActionV2::Lanzar {
        destino: destino.to_string(),
        args: vec![],
        etiqueta: None,
    }
}

fn correr(lista: &[ActionV2], cancelado: bool, cuesta_cerrar: u64) -> (Vec<String>, usize) {
    let mundo: Compartido = Arc::default();
    let mut ejecutor = EjecutorFalso {
        mundo: mundo.clone(),
        cuesta_cerrar: Duration::from_secs(cuesta_cerrar),
    };
    let reloj = RelojFalso {
        mundo: mundo.clone(),
    };
    let salteados = correr_lista(&mut ejecutor, &reloj, lista, &move || cancelado);
    (eventos(&mundo), salteados)
}

#[test]
fn las_acciones_corren_en_el_orden_de_la_lista() {
    let (eventos, salteados) = correr(
        &[
            lanzar("a"),
            ActionV2::Esperar { segundos: 30 },
            ActionV2::Cerrar {
                exe: "steam.exe".to_string(),
            },
            ActionV2::Volumen { nivel: 40 },
        ],
        false,
        5,
    );
    assert_eq!(
        eventos,
        ["lanzar a", "dormir 30", "cerrar steam.exe", "volumen 40"]
    );
    assert_eq!(salteados, 0);
}

#[test]
fn una_escena_nueva_corta_los_esperar_pero_no_los_otros_pasos() {
    let (eventos, _) = correr(
        &[
            ActionV2::Esperar { segundos: 30 },
            lanzar("a"),
            ActionV2::Esperar { segundos: 10 },
            ActionV2::Volumen { nivel: 10 },
        ],
        true,
        0,
    );
    assert_eq!(eventos, ["lanzar a", "volumen 10"], "sin ningún dormir");
}

#[test]
fn pasados_los_60_segundos_lo_que_falta_se_saltea() {
    let espera = ActionV2::Esperar { segundos: 30 };
    let (eventos, salteados) = correr(
        &[espera.clone(), espera.clone(), espera, lanzar("tarde")],
        false,
        0,
    );
    assert_eq!(eventos, ["dormir 30", "dormir 30"]);
    assert_eq!(salteados, 2, "el tercer Esperar y el Lanzar");
}

#[test]
fn un_esperar_no_puede_pasar_el_tope_aunque_antes_se_haya_gastado_tiempo() {
    // Cerrar "tardó" 50 s: a un Esperar 30 le quedan 10, y con eso se llega al tope de 60 s.
    let (eventos, salteados) = correr(
        &[
            ActionV2::Cerrar {
                exe: "a.exe".to_string(),
            },
            ActionV2::Esperar { segundos: 30 },
            lanzar("x"),
        ],
        false,
        50,
    );
    assert_eq!(eventos, ["cerrar a.exe", "dormir 10"]);
    assert_eq!(salteados, 1, "el Lanzar ya no entra en el tope");
}

/// Reloj de la cola: dormir espera a que lo liberen o a que llegue otra lista.
struct RelojQueEspera {
    mundo: Compartido,
    liberar: Arc<AtomicBool>,
}

impl Reloj for RelojQueEspera {
    fn ahora(&self) -> Duration {
        Duration::ZERO
    }
    fn dormir(&self, dur: Duration, cancelado: &dyn Fn() -> bool) -> bool {
        anotar(&self.mundo, format!("empieza a dormir {}", dur.as_secs()));
        let limite = Instant::now() + Duration::from_secs(10);
        while Instant::now() < limite {
            if self.liberar.load(Ordering::SeqCst) {
                anotar(&self.mundo, "terminó de dormir");
                return true;
            }
            if cancelado() {
                anotar(&self.mundo, "durmió cortado");
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }
}

fn cola_de_prueba() -> (Cola, Compartido, Arc<AtomicBool>) {
    let mundo: Compartido = Arc::default();
    let liberar = Arc::new(AtomicBool::new(false));
    let cola = Cola::nueva(
        EjecutorFalso {
            mundo: mundo.clone(),
            cuesta_cerrar: Duration::ZERO,
        },
        RelojQueEspera {
            mundo: mundo.clone(),
            liberar: liberar.clone(),
        },
    );
    (cola, mundo, liberar)
}

fn esperar_a(mundo: &Compartido, cuantos: usize) -> Vec<String> {
    let limite = Instant::now() + Duration::from_secs(10);
    while Instant::now() < limite {
        let e = eventos(mundo);
        if e.len() >= cuantos {
            return e;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    eventos(mundo)
}

#[test]
fn encolar_vuelve_al_toque_aunque_haya_un_esperar_30() {
    let (cola, mundo, liberar) = cola_de_prueba();
    let antes = Instant::now();
    cola.encolar(vec![ActionV2::Esperar { segundos: 30 }, lanzar("despues")]);
    assert!(
        antes.elapsed() < Duration::from_secs(2),
        "el aviso de confirmado no puede esperar a la cola"
    );
    // La cola sigue en el Esperar: lo que va después todavía no corrió.
    assert_eq!(esperar_a(&mundo, 1), ["empieza a dormir 30"]);
    assert!(!eventos(&mundo).iter().any(|e| e == "lanzar despues"));
    liberar.store(true, Ordering::SeqCst);
    assert_eq!(
        esperar_a(&mundo, 3),
        ["empieza a dormir 30", "terminó de dormir", "lanzar despues"]
    );
}

#[test]
fn una_lista_nueva_corta_el_esperar_de_la_anterior_y_corre_despues() {
    let (cola, mundo, _liberar) = cola_de_prueba();
    cola.encolar(vec![ActionV2::Esperar { segundos: 30 }, lanzar("vieja")]);
    assert_eq!(esperar_a(&mundo, 1), ["empieza a dormir 30"]);
    cola.encolar(vec![lanzar("nueva")]);
    assert_eq!(
        esperar_a(&mundo, 4),
        [
            "empieza a dormir 30",
            "durmió cortado",
            "lanzar vieja",
            "lanzar nueva"
        ],
        "la fila respeta el orden: lo que quedaba de la vieja y recién ahí la nueva"
    );
}

#[test]
fn una_lista_vacia_no_cancela_nada() {
    let (cola, mundo, liberar) = cola_de_prueba();
    cola.encolar(vec![ActionV2::Esperar { segundos: 30 }, lanzar("vieja")]);
    assert_eq!(esperar_a(&mundo, 1), ["empieza a dormir 30"]);
    cola.encolar(vec![]);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(eventos(&mundo), ["empieza a dormir 30"], "sigue esperando");
    liberar.store(true, Ordering::SeqCst);
    assert_eq!(esperar_a(&mundo, 3).len(), 3);
}
