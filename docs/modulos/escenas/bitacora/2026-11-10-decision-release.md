# Decisión del dueño · release y mudanza · 2026-11-10 ~22:30

Clase 3, contestada por Guido en el chat del director:

- Pedido textual: "vos no te vas a mudar hoy, ¿eh? Vas a terminar todo este desarrollo punta a punta. Y después, inclusive, sacar el nuevo release. En GitHub de la app entera. Así ya queda todo resuelto."
- Pregunta del director: ¿beta que instala él, final sin HDR, o final con todo? (el director recomendó beta; marcó una vez el riesgo de que el updater instale en la app diaria lo no probado en hardware).
- Respuesta: **"Final, con todo"**.

Qué cambia respecto del SPEC (SPEC.md:106, :143): el módulo va a `main` y sale como **release final** sin la prueba de hardware de Guido (incluido el HDR del 03b). La prueba de hardware pasa a ser **después** del release; lo que falle se arregla con otra versión.
Lo que no cambia: el gate verde del CI para cada merge, el checkpoint `displays.pre-escenas.json`, la vuelta atrás automática.
Versión: ≥ 1.5.4 (v1.5.3 ya publicada); por ser funciones nuevas, **v1.6.0**.
Mudanza: el director no se muda hoy (pedido de Guido); se mide igual el contexto y se anota.
