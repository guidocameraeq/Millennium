# Plan de remediación — Millennium Clipboard

Esta carpeta contiene **dos specs ejecutables** para llevar Millennium Clipboard de "anda pero consume una barbaridad y Android nunca funcionó" a una app optimizada y sólida. Están escritos para que un agente de código (**Opus 4.8**) los ejecute con toda la información necesaria, sin depender de la conversación que los originó.

**No hay que reescribir la app.** El núcleo es bueno; el trabajo es cirugía dirigida sobre módulos concretos, ordenada por fases de mayor impacto/menor riesgo a mayor esfuerzo.

## Estructura

```
docs/remediation/
├── README.md                     ← estás acá
├── 00-SHARED-CONTEXT.md          ← LEER PRIMERO: arquitectura, build, convenciones
└── android/
    ├── SPEC.md                   ← decisión estratégica + índice del spec Android
    ├── phase-A-lifecycle-and-approval.md   ← servicio + aprobación nativa (mayor impacto)
    ├── phase-B-discovery-and-storage.md    ← binding WiFi + streaming a MediaStore
    └── phase-C-clipboard-qr-mobile.md      ← portapapeles, QR, UI móvil
```

## Cómo usarlo

1. Abrí Claude Code en la raíz del proyecto (hoy `C:\Users\guido\Desktop\(1) Claude\Millennium`).
2. Pedile que **lea `docs/remediation/00-SHARED-CONTEXT.md`** y el `SPEC.md` de la plataforma que quieras arreglar.
3. Que ejecute **una fase por vez, en orden**, verificando el criterio de aceptación de cada una antes de seguir.

### Prompt sugerido para arrancar (Windows) — histórico, ya ejecutado

> Vas a ejecutar un plan de remediación. Primero leé `docs/remediation/00-SHARED-CONTEXT.md` completo, después `docs/archive/remediation-windows-SPEC.md`. Empezá por `docs/archive/phase-0-stop-the-bleed.md`: implementá todas sus Tareas en orden, compilá, corré la sección "Cómo verificar", commiteá, y reportame qué hiciste y qué verificaste. No sigas a la Fase 1 hasta que la Fase 0 esté verificada y yo confirme.

### Prompt sugerido para arrancar (Android)

> Vas a ejecutar el plan de remediación de Android. Leé `docs/remediation/00-SHARED-CONTEXT.md` y `docs/remediation/android/SPEC.md` (incluida la decisión estratégica del inicio). Confirmá conmigo la decisión "núcleo headless vs foreground-only" antes de tocar código. Después ejecutá `docs/remediation/android/phase-A-lifecycle-and-approval.md`, verificá en un teléfono real, y reportá.

## Recomendación de secuencia

La **Fase 0 de Windows** es el mayor retorno por el menor esfuerzo: ataca las tres causas verificadas del consumo en ~1-2 días de trabajo y bajo riesgo. Hacela primero aunque no hagas nada más. Android requiere una decisión estratégica previa (ver `android/SPEC.md`): invertir en hacerlo un objetivo de primera clase, o declararlo "solo primer plano" y concentrar el esfuerzo en un desktop 1.0 pulido.

Cada `phase-*.md` es autocontenido: problema, archivo y línea, estado actual del código, el cambio exacto, por qué, qué cuidar, cómo verificar, y rollback.
