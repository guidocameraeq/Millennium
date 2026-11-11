use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::backend::DisplayBackend;
use crate::model::{
    ActionV2, AppConfig, AppSettings, AudioTarget, DisplayId, DisplayInfo, Layout, PerfilAcciones,
    Profile, DEFAULT_DISPLAY_TOGGLE_SHORTCUT_BASE, DEFAULT_PROFILE_SHORTCUT_BASE,
};
use crate::store::ConfigStore;
use crate::ManagerError;

#[derive(Clone, Debug)]
struct PendingConfirmation {
    previous_layout: Layout,
    applied_at: Instant,
    timeout: Duration,
    /// `true` si la confirmación es de una PRUEBA de borrador (`apply_draft`).
    is_test: bool,
}

impl PendingConfirmation {
    fn new(previous_layout: Layout, timeout: Duration) -> Self {
        Self {
            previous_layout,
            applied_at: Instant::now(),
            timeout,
            is_test: false,
        }
    }

    fn expired(&self) -> bool {
        self.applied_at.elapsed() >= self.timeout
    }

    fn remaining(&self) -> Duration {
        self.timeout
            .checked_sub(self.applied_at.elapsed())
            .unwrap_or(Duration::ZERO)
    }
}

/// Texto exacto que ve Guido cuando una prueba de borrador espera su confirmación.
pub const PRUEBA_PENDIENTE: &str = "esperando que confirmes la prueba";

/// Una escena completa tal como la guarda `upsert_scene` (módulo escenas, encargo 01):
/// el layout más todo lo que vive en `AppSettings` por nombre.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneData {
    pub name: String,
    pub layout: Layout,
    pub emoji: Option<String>,
    pub audio: Option<AudioTarget>,
    pub entrada: Vec<ActionV2>,
    pub salida: Vec<ActionV2>,
    pub shortcut: Option<String>,
    /// Es la escena de arranque (`startup_profile_name`).
    pub startup: bool,
}

#[derive(Debug)]
pub struct MonarchDisplayManager<B, S> {
    backend: B,
    store: S,
    config: AppConfig,
    pending_confirmation: Option<PendingConfirmation>,
    confirmation_timeout: Duration,
}

impl<B, S> MonarchDisplayManager<B, S>
where
    B: DisplayBackend,
    S: ConfigStore,
{
    pub fn new(backend: B, store: S) -> Result<Self, ManagerError> {
        let mut config = store.load()?;
        let current_layout = backend.get_layout()?;
        let current_displays = backend.list_displays().unwrap_or_default();
        let mut should_persist = false;
        if config
            .settings
            .profile_shortcut_base
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            config.settings.profile_shortcut_base = Some(DEFAULT_PROFILE_SHORTCUT_BASE.to_string());
            should_persist = true;
        }
        if config
            .settings
            .display_toggle_shortcut_base
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            config.settings.display_toggle_shortcut_base =
                Some(DEFAULT_DISPLAY_TOGGLE_SHORTCUT_BASE.to_string());
            should_persist = true;
        }
        let confirmation_timeout = Duration::from_secs(config.settings.revert_timeout_secs.max(1));

        if config.last_known_good_layout.is_none() || config.last_restorable_layout.is_none() {
            if config.last_known_good_layout.is_none() {
                config.last_known_good_layout = Some(current_layout.clone());
            }
            if config.last_restorable_layout.is_none() {
                config.last_restorable_layout = Some(current_layout.clone());
            }
            should_persist = true;
        }
        if sync_display_fingerprints(&mut config, &current_displays) {
            should_persist = true;
        }
        if migrate_saved_layout_ids_with_fingerprints(
            &mut config,
            &current_layout,
            &current_displays,
        ) {
            should_persist = true;
        }
        if should_persist {
            store.save(&config)?;
        }

        Ok(Self {
            backend,
            store,
            config,
            pending_confirmation: None,
            confirmation_timeout,
        })
    }

    pub fn set_confirmation_timeout(&mut self, timeout: Duration) {
        self.confirmation_timeout = timeout;
    }

    pub fn list_displays(&self) -> Result<Vec<DisplayInfo>, ManagerError> {
        self.backend.list_displays()
    }

    pub fn get_layout(&self) -> Result<Layout, ManagerError> {
        self.backend.get_layout()
    }

    pub fn color_state_signature(&self) -> Result<Option<String>, ManagerError> {
        self.backend.color_state_signature()
    }

    pub fn reapply_color_calibration(&self) -> Result<(), ManagerError> {
        self.backend.reapply_color_calibration()
    }

    pub fn invalidate_backend_cache(&self) -> Result<(), ManagerError> {
        self.backend.invalidate_cache()
    }

    pub fn has_pending_confirmation(&self) -> bool {
        self.pending_confirmation.is_some()
    }

    pub fn pending_confirmation_remaining(&self) -> Option<Duration> {
        self.pending_confirmation
            .as_ref()
            .map(PendingConfirmation::remaining)
    }

    /// `true` si lo que espera confirmación es una PRUEBA de borrador.
    pub fn pending_is_test(&self) -> bool {
        self.pending_confirmation
            .as_ref()
            .map_or(false, |pending| pending.is_test)
    }

    pub fn apply_layout(&mut self, layout: Layout) -> Result<(), ManagerError> {
        self.ensure_no_pending_confirmation()?;
        let mut layout = layout;
        layout.ensure_valid()?;
        normalize_primary(&mut layout);

        let current_layout = self.backend.get_layout()?;
        self.config.last_known_good_layout = Some(current_layout.clone());
        self.config.last_restorable_layout = Some(current_layout.clone());
        self.persist_config()?;

        self.backend.apply_layout(layout)?;
        self.pending_confirmation = Some(PendingConfirmation::new(
            current_layout,
            self.confirmation_timeout,
        ));
        Ok(())
    }

    pub fn confirm_current_layout(&mut self) -> Result<(), ManagerError> {
        if self.pending_confirmation.is_none() {
            return Err(ManagerError::NoPendingConfirmation);
        }

        let current_layout = self.backend.get_layout()?;
        self.pending_confirmation = None;
        self.config.last_known_good_layout = Some(current_layout);
        self.persist_config()
    }

    pub fn rollback_pending(&mut self) -> Result<(), ManagerError> {
        let pending = self
            .pending_confirmation
            .take()
            .ok_or(ManagerError::NoPendingConfirmation)?;

        if let Err(error) = self.backend.apply_layout(pending.previous_layout.clone()) {
            // Keep the pending confirmation when the rollback apply fails, so the state is not
            // silently dropped: the caller can retry the rollback or confirm the current layout.
            self.pending_confirmation = Some(pending);
            return Err(error);
        }
        self.config.last_known_good_layout = Some(pending.previous_layout);
        self.persist_config()
    }

    pub fn rollback_if_confirmation_expired(&mut self) -> Result<bool, ManagerError> {
        let expired = self
            .pending_confirmation
            .as_ref()
            .map(PendingConfirmation::expired)
            .unwrap_or(false);

        if expired {
            self.rollback_pending()?;
            return Ok(true);
        }

        Ok(false)
    }

    pub fn toggle_display(&mut self, display_id: &DisplayId) -> Result<(), ManagerError> {
        let mut layout = self.backend.get_layout()?;
        let resolved_display_id = resolve_display_id_for_layout_action(display_id, &layout)
            .unwrap_or_else(|| display_id.clone());
        let index = layout
            .find_output_index(&resolved_display_id)
            .ok_or_else(|| {
                ManagerError::NotFound(format!(
                    "display ({}, {})",
                    display_id.adapter_luid, display_id.target_id
                ))
            })?;

        let currently_enabled = layout.outputs[index].enabled;
        if currently_enabled && layout.enabled_output_count() == 1 {
            return Err(ManagerError::Validation(
                "cannot disable the last active display".to_string(),
            ));
        }

        layout.outputs[index].enabled = !currently_enabled;
        if !layout.outputs[index].enabled {
            layout.outputs[index].primary = false;
        }

        normalize_primary(&mut layout);
        self.apply_layout(layout)
    }

    /// Guarda el layout de ahora con un nombre. Lo nuevo va AL FINAL (el orden es el que
    /// eligió Guido). Un nombre que ya existe es un error, salvo con `replace` (el "↻
    /// actualizar con lo puesto"), que pisa solo el layout de esa escena.
    pub fn save_profile(
        &mut self,
        name: impl Into<String>,
        replace: bool,
    ) -> Result<(), ManagerError> {
        self.ensure_scenes_writable()?;

        let name = name.into();
        let name = name.trim();
        if name.is_empty() {
            return Err(nombre_vacio());
        }

        let layout = self.backend.get_layout()?;
        let profile = Profile {
            name: name.to_string(),
            layout,
        };

        let mut config = self.config.clone();
        if let Some(existing) = config
            .profiles
            .iter_mut()
            .find(|candidate| candidate.name == profile.name)
        {
            if !replace {
                return Err(nombre_repetido(&profile.name));
            }
            *existing = profile;
        } else {
            config.profiles.push(profile);
        }

        self.commit_config(config)
    }

    /// Crea o edita una escena COMPLETA (layout + sonido + acciones + atajo + emoji +
    /// arranque) en UN solo guardado, sin tocar ninguna pantalla. `original_name` `None` =
    /// escena nueva (va al final); `Some` = editar esa (queda en su lugar), y si el nombre
    /// cambió es además un renombre con todas sus reglas. Devuelve el nombre final.
    /// Todo o nada: si algo falla no se guarda nada, ni en disco ni en memoria.
    pub fn upsert_scene(
        &mut self,
        original_name: Option<&str>,
        scene: SceneData,
    ) -> Result<String, ManagerError> {
        self.ensure_scenes_writable()?;

        let name = scene.name.trim().to_string();
        if name.is_empty() {
            return Err(nombre_vacio());
        }
        validate_scene_layout(&scene.layout)?;

        let mut config = self.config.clone();
        match original_name {
            Some(original) => {
                if !config.profiles.iter().any(|p| p.name == original) {
                    return Err(no_existe(original));
                }
                if original != name {
                    if config.profiles.iter().any(|p| p.name == name) {
                        return Err(nombre_repetido(&name));
                    }
                    rename_in_config(&mut config, original, &name);
                }
            }
            None => {
                if config.profiles.iter().any(|p| p.name == name) {
                    return Err(nombre_repetido(&name));
                }
            }
        }

        let shortcut = scene
            .shortcut
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(accel) = &shortcut {
            if let Some(otra) = config
                .settings
                .profile_shortcuts
                .iter()
                .find(|(n, a)| n.as_str() != name && a.trim().eq_ignore_ascii_case(accel))
                .map(|(n, _)| n.clone())
            {
                return Err(ManagerError::Validation(format!(
                    "ese atajo ya lo usa la escena \"{otra}\""
                )));
            }
        }

        let mut layout = scene.layout;
        normalize_primary(&mut layout);
        match config.profiles.iter_mut().find(|p| p.name == name) {
            Some(existing) => existing.layout = layout,
            None => config.profiles.push(Profile {
                name: name.clone(),
                layout,
            }),
        }

        let settings = &mut config.settings;
        match shortcut {
            Some(accel) => {
                settings.profile_shortcuts.insert(name.clone(), accel);
            }
            None => {
                settings.profile_shortcuts.remove(&name);
            }
        }
        match scene.audio {
            Some(audio) => {
                settings.profile_audio.insert(name.clone(), audio);
            }
            None => {
                settings.profile_audio.remove(&name);
            }
        }
        // Una acción de una versión más nueva (`Desconocida`) no se puede guardar: se descarta.
        let sin_desconocidas = |lista: Vec<ActionV2>| -> Vec<ActionV2> {
            lista
                .into_iter()
                .filter(|accion| !matches!(accion, ActionV2::Desconocida))
                .collect()
        };
        let acciones = PerfilAcciones::desde_v2(
            sin_desconocidas(scene.entrada),
            sin_desconocidas(scene.salida),
        );
        if acciones.esta_vacia() {
            settings.profile_actions.remove(&name);
        } else {
            settings.profile_actions.insert(name.clone(), acciones);
        }
        match scene
            .emoji
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(emoji) => {
                settings.profile_icons.insert(name.clone(), emoji.to_string());
            }
            None => {
                settings.profile_icons.remove(&name);
            }
        }
        if scene.startup {
            settings.startup_profile_name = Some(name.clone());
        } else if settings.startup_profile_name.as_deref() == Some(name.as_str()) {
            settings.startup_profile_name = None;
        }

        self.commit_config(config)?;
        Ok(name)
    }

    /// Renombra una escena moviendo, en UN solo guardado, su atajo, sonido, acciones, emoji y
    /// arranque al nombre nuevo. Mismo lugar en el orden. Renombrar al mismo nombre no
    /// escribe nada. Devuelve el nombre nuevo (sin espacios de los costados).
    pub fn rename_scene(&mut self, name: &str, new_name: &str) -> Result<String, ManagerError> {
        self.ensure_scenes_writable()?;

        let new_name = new_name.trim().to_string();
        if new_name.is_empty() {
            return Err(nombre_vacio());
        }
        if !self.config.profiles.iter().any(|p| p.name == name) {
            return Err(no_existe(name));
        }
        if new_name == name {
            return Ok(new_name);
        }
        if self.config.profiles.iter().any(|p| p.name == new_name) {
            return Err(nombre_repetido(&new_name));
        }

        let mut config = self.config.clone();
        rename_in_config(&mut config, name, &new_name);
        self.commit_config(config)?;
        Ok(new_name)
    }

    /// Copia completa e independiente: pantallas, sonido, acciones y emoji; NO el atajo ni el
    /// arranque (un atajo no puede repetirse). Va al final, llamada "X (copia)" o "X (copia
    /// N)". Un solo guardado. Devuelve el nombre de la copia.
    pub fn duplicate_scene(&mut self, name: &str) -> Result<String, ManagerError> {
        self.ensure_scenes_writable()?;

        let original = self
            .config
            .profiles
            .iter()
            .find(|p| p.name == name)
            .cloned()
            .ok_or_else(|| no_existe(name))?;
        let copia = copy_name(name, &self.config.profiles);

        let mut config = self.config.clone();
        // Sobras de una escena borrada con ese nombre: la copia no hereda atajo ni arranque.
        quitar_claves(&mut config, &copia);
        config.profiles.push(Profile {
            name: copia.clone(),
            layout: original.layout,
        });
        let settings = &mut config.settings;
        if let Some(audio) = settings.profile_audio.get(name).cloned() {
            settings.profile_audio.insert(copia.clone(), audio);
        }
        if let Some(acciones) = settings.profile_actions.get(name).cloned() {
            settings.profile_actions.insert(copia.clone(), acciones);
        }
        if let Some(emoji) = settings.profile_icons.get(name).cloned() {
            settings.profile_icons.insert(copia.clone(), emoji);
        }
        self.commit_config(config)?;
        Ok(copia)
    }

    /// Fija el orden de las escenas. `names` tiene que ser EXACTAMENTE el conjunto de hoy
    /// (ni falta, ni sobra, ni se repite una): si la lista cambió mientras se ordenaba, error
    /// y no se guarda nada.
    pub fn reorder_scenes(&mut self, names: &[String]) -> Result<(), ManagerError> {
        self.ensure_scenes_writable()?;

        let mut pedidos: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut actuales: Vec<&str> = self
            .config
            .profiles
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        pedidos.sort_unstable();
        actuales.sort_unstable();
        if pedidos != actuales {
            return Err(ManagerError::Validation(
                "la lista de escenas cambió mientras la ordenabas; volvé a intentar".to_string(),
            ));
        }

        let mut config = self.config.clone();
        config.profiles = names
            .iter()
            .filter_map(|n| self.config.profiles.iter().find(|p| &p.name == n).cloned())
            .collect();
        self.commit_config(config)
    }

    pub fn list_profiles(&self) -> Vec<Profile> {
        self.config.profiles.clone()
    }

    pub fn apply_profile(&mut self, name: &str) -> Result<(), ManagerError> {
        self.ensure_no_pending_confirmation()?;

        let profile = self
            .config
            .profiles
            .iter()
            .find(|profile| profile.name == name)
            .cloned()
            .ok_or_else(|| ManagerError::NotFound(format!("profile '{name}'")))?;

        self.apply_target_layout(profile.layout)
    }

    /// PROBAR un borrador: el MISMO cuerpo que `apply_profile` (validar, normalizar el
    /// primario, remapear por EDID, `apply_layout`) pero sin buscar por nombre y sin escribir
    /// nada en `profiles`. Lo que queda pendiente se marca como prueba
    /// (`pending_is_test`). Si el borrador ya es lo puesto, no hay nada pendiente.
    pub fn apply_draft(&mut self, layout: Layout) -> Result<(), ManagerError> {
        self.ensure_no_pending_confirmation()?;
        self.apply_target_layout(layout)?;
        if let Some(pending) = self.pending_confirmation.as_mut() {
            pending.is_test = true;
        }
        Ok(())
    }

    /// El cuerpo común de `apply_profile` y `apply_draft`. Quien llama ya verificó que no
    /// hay una confirmación pendiente.
    fn apply_target_layout(&mut self, layout: Layout) -> Result<(), ManagerError> {
        let mut target_layout = layout;
        target_layout.ensure_valid()?;
        normalize_primary(&mut target_layout);

        let (target_layout, current_layout) = self.remap_and_resolve_for_apply(target_layout)?;

        if current_layout == target_layout {
            return Ok(());
        }

        self.apply_layout(target_layout)
    }

    /// Las pantallas PRENDIDAS de `layout` que Windows no está enumerando hoy (ni por id ni
    /// por el remapeo por EDID). Solo mira: no toca la topología. Sirve para avisar "no está
    /// conectada" ANTES de probar un borrador.
    pub fn unresolved_enabled_outputs(
        &self,
        layout: &Layout,
    ) -> Result<Vec<DisplayId>, ManagerError> {
        let mut current = self.backend.get_layout()?;
        normalize_primary(&mut current);
        let remapped = remap_layout_display_ids(layout, &current);
        let ids: HashSet<&DisplayId> = current.outputs.iter().map(|o| &o.display_id).collect();
        Ok(remapped
            .outputs
            .iter()
            .filter(|o| o.enabled && !ids.contains(&o.display_id))
            .map(|o| o.display_id.clone())
            .collect())
    }

    /// Remap the desired layout onto the current enumeration and strictly validate it. An enabled
    /// output that does not resolve names a display the backend is not enumerating at all, so
    /// there is nothing to apply: the backend gets a chance to record why (it must not change the
    /// topology — nothing it could do would make an absent display appear), and then the layout
    /// is rejected with an actionable error. Attaching a display that IS enumerated but detached
    /// needs none of this: it already resolves, and `apply_layout` attaches it.
    fn remap_and_resolve_for_apply(
        &self,
        target_layout: Layout,
    ) -> Result<(Layout, Layout), ManagerError> {
        let mut current_layout = self.backend.get_layout()?;
        normalize_primary(&mut current_layout);
        let target_layout = remap_layout_display_ids(&target_layout, &current_layout);

        if ensure_all_enabled_outputs_resolve(&target_layout, &current_layout).is_ok() {
            return Ok((target_layout, current_layout));
        }

        self.backend.prepare_attach_targets(&target_layout)?;
        let mut current_layout = self.backend.get_layout()?;
        normalize_primary(&mut current_layout);
        let target_layout = remap_layout_display_ids(&target_layout, &current_layout);
        self.ensure_outputs_resolve_or_report_disconnected(&target_layout, &current_layout)?;
        Ok((target_layout, current_layout))
    }

    fn ensure_outputs_resolve_or_report_disconnected(
        &self,
        desired: &Layout,
        current: &Layout,
    ) -> Result<(), ManagerError> {
        let current_ids: HashSet<&DisplayId> = current
            .outputs
            .iter()
            .map(|output| &output.display_id)
            .collect();

        let Some(unresolved) = desired
            .outputs
            .iter()
            .find(|output| output.enabled && !current_ids.contains(&output.display_id))
        else {
            return Ok(());
        };

        let edid_hash = unresolved
            .display_id
            .edid_hash
            .map(|value| format!("{value:016x}"))
            .unwrap_or_else(|| "-".to_string());
        let friendly = self
            .backend
            .list_displays()
            .unwrap_or_default()
            .into_iter()
            .find(|display| {
                display.id == unresolved.display_id
                    || (unresolved.display_id.edid_hash.is_some()
                        && display.id.edid_hash == unresolved.display_id.edid_hash)
            })
            .map(|display| format!("'{}' ", display.friendly_name))
            .unwrap_or_default();
        // This is NOT an attach failure: the display is not being enumerated at all (powered off,
        // unplugged, or reported unavailable). Say so, instead of blaming a rescue that never ran.
        Err(ManagerError::Validation(format!(
            "display {friendly}(target_id={}, edid_hash={edid_hash}) is not connected right now: Windows does not report it as an available display. turn it on or reconnect it and try again, or re-save the profile without it",
            unresolved.display_id.target_id
        )))
    }

    pub fn delete_profile(&mut self, name: &str) -> Result<(), ManagerError> {
        self.ensure_scenes_writable()?;
        let before = self.config.profiles.len();
        self.config.profiles.retain(|profile| profile.name != name);
        if self.config.profiles.len() == before {
            return Err(no_existe(name));
        }
        self.persist_config()
    }

    pub fn restore_last_layout(&mut self) -> Result<(), ManagerError> {
        self.ensure_no_pending_confirmation()?;

        let target_layout = self
            .config
            .last_restorable_layout
            .clone()
            .or_else(|| self.config.last_known_good_layout.clone())
            .ok_or_else(|| ManagerError::NotFound("last restorable layout".to_string()))?;

        let mut remapped_target_layout = target_layout;
        remapped_target_layout.ensure_valid()?;
        normalize_primary(&mut remapped_target_layout);
        let (remapped_target_layout, current_layout) =
            self.remap_and_resolve_for_apply(remapped_target_layout)?;
        self.backend.apply_layout(remapped_target_layout.clone())?;
        self.pending_confirmation = None;
        self.config.last_restorable_layout = Some(current_layout);
        self.config.last_known_good_layout = Some(remapped_target_layout);
        self.persist_config()
    }

    pub fn settings(&self) -> &AppSettings {
        &self.config.settings
    }

    pub fn update_settings(&mut self, settings: AppSettings) -> Result<(), ManagerError> {
        let revert_timeout_secs = settings.revert_timeout_secs.max(1);
        let startup_profile_name = settings
            .startup_profile_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);
        let profile_shortcut_base = settings
            .profile_shortcut_base
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_PROFILE_SHORTCUT_BASE.to_string());
        let display_toggle_shortcut_base = settings
            .display_toggle_shortcut_base
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| DEFAULT_DISPLAY_TOGGLE_SHORTCUT_BASE.to_string());
        if profile_shortcut_base.eq_ignore_ascii_case(&display_toggle_shortcut_base) {
            return Err(ManagerError::Validation(
                "profile and monitor shortcut bases must be different".to_string(),
            ));
        }
        let profile_shortcuts = settings
            .profile_shortcuts
            .into_iter()
            .filter_map(|(name, shortcut)| {
                let name = name.trim();
                let shortcut = shortcut.trim();
                if name.is_empty() || shortcut.is_empty() {
                    return None;
                }
                Some((name.to_string(), shortcut.to_string()))
            })
            .collect();
        let display_toggle_shortcuts = settings
            .display_toggle_shortcuts
            .into_iter()
            .filter_map(|(display_key, shortcut)| {
                let display_key = display_key.trim();
                let shortcut = shortcut.trim();
                if display_key.is_empty() || shortcut.is_empty() {
                    return None;
                }
                Some((display_key.to_string(), shortcut.to_string()))
            })
            .collect();
        self.confirmation_timeout = Duration::from_secs(revert_timeout_secs);
        self.config.settings = AppSettings {
            revert_timeout_secs,
            start_with_windows: settings.start_with_windows,
            startup_profile_name,
            global_shortcuts_enabled: settings.global_shortcuts_enabled,
            profile_shortcut_base: Some(profile_shortcut_base),
            display_toggle_shortcut_base: Some(display_toggle_shortcut_base),
            profile_shortcuts,
            display_toggle_shortcuts,
            // TRAMPA #1 (Displays v2, Fase 3): este literal re-arma AppSettings
            // campo por campo. El audio por perfil se copia TAL CUAL del input;
            // NUNCA `Default::default()` ni `BTreeMap::new()`, o cada guardado de
            // ajustes/atajos vaciaría en silencio TODAS las salidas de audio.
            profile_audio: settings.profile_audio,
            // TRAMPA #1 también para la Fase 4: las acciones por perfil se copian
            // TAL CUAL. Si acá se pusiera `BTreeMap::new()`, cada guardado de
            // ajustes/atajos/audio borraría en silencio TODAS las escenas.
            profile_actions: settings.profile_actions,
            // TRAMPA #1 también para el módulo escenas: el emoji por perfil se copia
            // TAL CUAL. Con `BTreeMap::new()`, cada guardado de ajustes borraría en
            // silencio todos los emojis.
            profile_icons: settings.profile_icons,
        };
        self.persist_config()
    }

    pub fn config(&self) -> &AppConfig {
        &self.config
    }

    fn ensure_no_pending_confirmation(&self) -> Result<(), ManagerError> {
        if self.pending_confirmation.is_some() {
            return Err(ManagerError::ConfirmationPending);
        }
        Ok(())
    }

    /// Lo mismo, para los que escriben escenas: durante una PRUEBA el texto es el de Guido
    /// (`PRUEBA_PENDIENTE`); durante un cambio común, el de siempre.
    fn ensure_scenes_writable(&self) -> Result<(), ManagerError> {
        match &self.pending_confirmation {
            None => Ok(()),
            Some(pending) if pending.is_test => {
                Err(ManagerError::Validation(PRUEBA_PENDIENTE.to_string()))
            }
            Some(_) => Err(ManagerError::ConfirmationPending),
        }
    }

    fn persist_config(&self) -> Result<(), ManagerError> {
        self.store.save(&self.config)
    }

    /// Guarda UNA vez la config ya armada y recién si salió bien la adopta en memoria: un
    /// error de disco no deja la memoria a medio cambiar.
    fn commit_config(&mut self, config: AppConfig) -> Result<(), ManagerError> {
        self.store.save(&config)?;
        self.config = config;
        Ok(())
    }
}

fn nombre_vacio() -> ManagerError {
    ManagerError::Validation("poné un nombre para la escena".to_string())
}

fn nombre_repetido(name: &str) -> ManagerError {
    ManagerError::Validation(format!("ya hay una escena que se llama \"{name}\""))
}

fn no_existe(name: &str) -> ManagerError {
    ManagerError::NotFound(format!("no existe la escena \"{name}\""))
}

/// Las reglas de un layout para GUARDARLO como escena (los textos son para Guido).
fn validate_scene_layout(layout: &Layout) -> Result<(), ManagerError> {
    if layout.enabled_output_count() == 0 {
        return Err(ManagerError::Validation(
            "tiene que quedar al menos una pantalla prendida".to_string(),
        ));
    }
    if layout.outputs.iter().any(|o| o.primary && !o.enabled) {
        return Err(ManagerError::Validation(
            "la pantalla principal tiene que estar prendida".to_string(),
        ));
    }
    let principales = layout
        .outputs
        .iter()
        .filter(|o| o.enabled && o.primary)
        .count();
    if principales != 1 {
        return Err(ManagerError::Validation(
            "elegí una sola pantalla principal".to_string(),
        ));
    }
    Ok(())
}

/// Mueve de `from` a `to` TODO lo que cuelga del nombre de una escena: el perfil mismo (queda
/// en su lugar), atajo, sonido, acciones, emoji y la escena de arranque. Quien llama ya
/// verificó que `from` existe y que `to` está libre.
fn rename_in_config(config: &mut AppConfig, from: &str, to: &str) {
    // Sobras de una escena borrada con el nombre de destino no se heredan.
    quitar_claves(config, to);
    if let Some(profile) = config.profiles.iter_mut().find(|p| p.name == from) {
        profile.name = to.to_string();
    }
    let settings = &mut config.settings;
    if let Some(value) = settings.profile_shortcuts.remove(from) {
        settings.profile_shortcuts.insert(to.to_string(), value);
    }
    if let Some(value) = settings.profile_audio.remove(from) {
        settings.profile_audio.insert(to.to_string(), value);
    }
    if let Some(value) = settings.profile_actions.remove(from) {
        settings.profile_actions.insert(to.to_string(), value);
    }
    if let Some(value) = settings.profile_icons.remove(from) {
        settings.profile_icons.insert(to.to_string(), value);
    }
    if settings.startup_profile_name.as_deref() == Some(from) {
        settings.startup_profile_name = Some(to.to_string());
    }
}

/// Borra todo lo que cuelga de un nombre en los ajustes (atajo, sonido, acciones, emoji y
/// arranque), sin tocar los perfiles.
fn quitar_claves(config: &mut AppConfig, name: &str) {
    let settings = &mut config.settings;
    settings.profile_shortcuts.remove(name);
    settings.profile_audio.remove(name);
    settings.profile_actions.remove(name);
    settings.profile_icons.remove(name);
    if settings.startup_profile_name.as_deref() == Some(name) {
        settings.startup_profile_name = None;
    }
}

/// "X (copia)", y si existe "X (copia 2)", "X (copia 3)"… el primero libre.
pub fn copy_name(base: &str, profiles: &[Profile]) -> String {
    let libre = |candidato: &str| !profiles.iter().any(|p| p.name == candidato);
    let primero = format!("{base} (copia)");
    if libre(&primero) {
        return primero;
    }
    let mut n = 2u32;
    loop {
        let candidato = format!("{base} (copia {n})");
        if libre(&candidato) {
            return candidato;
        }
        n += 1;
    }
}

fn normalize_primary(layout: &mut Layout) {
    let mut primary_found = false;

    for output in &mut layout.outputs {
        if !output.enabled {
            output.primary = false;
            continue;
        }

        if output.primary && !primary_found {
            primary_found = true;
            continue;
        }

        output.primary = false;
    }

    if !primary_found {
        if let Some(output) = layout.outputs.iter_mut().find(|output| output.enabled) {
            output.primary = true;
        }
    }

    if let Some(primary) = layout
        .outputs
        .iter()
        .find(|output| output.enabled && output.primary)
    {
        if primary.position.x != 0 || primary.position.y != 0 {
            let offset_x = primary.position.x;
            let offset_y = primary.position.y;
            for output in &mut layout.outputs {
                output.position.x -= offset_x;
                output.position.y -= offset_y;
            }
        }
    }
}

fn resolve_display_id_for_layout_action(
    requested: &DisplayId,
    layout: &Layout,
) -> Option<DisplayId> {
    if layout.find_output_index(requested).is_some() {
        return Some(requested.clone());
    }

    if let Some(edid_hash) = requested.edid_hash {
        let mut matches = layout
            .outputs
            .iter()
            .filter(|output| output.display_id.edid_hash == Some(edid_hash));
        let first = matches.next()?;
        if matches.next().is_none() {
            return Some(first.display_id.clone());
        }
    }

    if requested.edid_hash.is_none() {
        let mut matches = layout
            .outputs
            .iter()
            .filter(|output| output.display_id.target_id == requested.target_id);
        let first = matches.next()?;
        if matches.next().is_none() {
            return Some(first.display_id.clone());
        }
    }

    None
}

fn fingerprint_for_display(display_id: &DisplayId, friendly_name: Option<&str>) -> Option<String> {
    let edid_hash = display_id.edid_hash?;
    let normalized_name = friendly_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("")
        .to_ascii_uppercase();
    Some(format!("{edid_hash:016x}:{normalized_name}"))
}

fn sync_display_fingerprints(config: &mut AppConfig, displays: &[DisplayInfo]) -> bool {
    let mut changed = false;
    for display in displays {
        let fingerprint = fingerprint_for_display(&display.id, Some(&display.friendly_name));
        let next = crate::model::DisplayFingerprint {
            display_id: display.id.clone(),
            friendly_name: display.friendly_name.clone(),
            edid_fingerprint: fingerprint,
        };

        if let Some(existing) = config
            .display_fingerprints
            .iter_mut()
            .find(|candidate| candidate.display_id == next.display_id)
        {
            if existing != &next {
                *existing = next;
                changed = true;
            }
        } else {
            config.display_fingerprints.push(next);
            changed = true;
        }
    }

    if changed {
        config
            .display_fingerprints
            .sort_by(|left, right| left.display_id.cmp(&right.display_id));
    }
    changed
}

fn migrate_saved_layout_ids_with_fingerprints(
    config: &mut AppConfig,
    current_layout: &Layout,
    current_displays: &[DisplayInfo],
) -> bool {
    let mut changed = false;
    let mut remap_profile_layout = |layout: &mut Layout| {
        let remapped = remap_layout_display_ids_with_fingerprints(
            layout,
            current_layout,
            current_displays,
            &config.display_fingerprints,
        );
        if &remapped != layout {
            *layout = remapped;
            changed = true;
        }
    };

    for profile in &mut config.profiles {
        remap_profile_layout(&mut profile.layout);
    }

    if let Some(layout) = &mut config.last_known_good_layout {
        remap_profile_layout(layout);
    }
    if let Some(layout) = &mut config.last_restorable_layout {
        remap_profile_layout(layout);
    }

    changed
}

fn remap_layout_display_ids_with_fingerprints(
    desired: &Layout,
    current: &Layout,
    current_displays: &[DisplayInfo],
    fingerprints: &[crate::model::DisplayFingerprint],
) -> Layout {
    let mut remapped = remap_layout_display_ids(desired, current);
    let current_ids: HashSet<DisplayId> = current
        .outputs
        .iter()
        .map(|output| output.display_id.clone())
        .collect();
    let mut used: HashSet<DisplayId> = remapped
        .outputs
        .iter()
        .filter(|output| current_ids.contains(&output.display_id))
        .map(|output| output.display_id.clone())
        .collect();

    let friendly_by_id: HashMap<DisplayId, String> = current_displays
        .iter()
        .map(|display| (display.id.clone(), display.friendly_name.clone()))
        .collect();
    let fingerprint_by_id: HashMap<DisplayId, String> = fingerprints
        .iter()
        .filter_map(|entry| {
            entry
                .edid_fingerprint
                .as_ref()
                .map(|fingerprint| (entry.display_id.clone(), fingerprint.clone()))
        })
        .collect();

    let mut current_by_fingerprint: HashMap<String, Vec<DisplayId>> = HashMap::new();
    for output in &current.outputs {
        let fingerprint = fingerprint_by_id
            .get(&output.display_id)
            .cloned()
            .or_else(|| {
                let friendly = friendly_by_id.get(&output.display_id).map(String::as_str);
                fingerprint_for_display(&output.display_id, friendly)
            });
        if let Some(fingerprint) = fingerprint {
            current_by_fingerprint
                .entry(fingerprint)
                .or_default()
                .push(output.display_id.clone());
        }
    }

    for output in &mut remapped.outputs {
        if current_ids.contains(&output.display_id) {
            continue;
        }

        let fingerprint = fingerprint_by_id
            .get(&output.display_id)
            .cloned()
            .or_else(|| fingerprint_for_display(&output.display_id, None));
        let Some(fingerprint) = fingerprint else {
            continue;
        };
        let Some(candidates) = current_by_fingerprint.get(&fingerprint) else {
            continue;
        };

        let available: Vec<_> = candidates
            .iter()
            .filter(|candidate| !used.contains(*candidate))
            .cloned()
            .collect();
        if available.len() != 1 {
            continue;
        }

        let replacement = available[0].clone();
        used.insert(replacement.clone());
        output.display_id = replacement;
    }

    remapped
}

fn remap_layout_display_ids(desired: &Layout, current: &Layout) -> Layout {
    let current_ids: HashSet<DisplayId> = current
        .outputs
        .iter()
        .map(|output| output.display_id.clone())
        .collect();

    if desired
        .outputs
        .iter()
        .all(|output| current_ids.contains(&output.display_id))
    {
        return desired.clone();
    }

    let mut remapped = desired.clone();
    let mut used: HashSet<DisplayId> = HashSet::new();
    for output in &remapped.outputs {
        if current_ids.contains(&output.display_id) {
            used.insert(output.display_id.clone());
        }
    }

    let mut current_by_edid: HashMap<u64, Vec<&crate::model::OutputConfig>> = HashMap::new();
    for output in &current.outputs {
        if let Some(edid_hash) = output.display_id.edid_hash {
            current_by_edid.entry(edid_hash).or_default().push(output);
        }
    }

    for output in &mut remapped.outputs {
        if current_ids.contains(&output.display_id) {
            continue;
        }

        let mut replacement = None;

        if let Some(edid_hash) = output.display_id.edid_hash {
            let candidates = unique_unused_candidates(
                current_by_edid.get(&edid_hash).cloned().unwrap_or_default(),
                &used,
            );
            replacement =
                choose_remap_candidate(&candidates).map(|candidate| candidate.display_id.clone());
        }

        if replacement.is_none() && output.display_id.edid_hash.is_none() {
            // Deterministic fallback for legacy profiles created before EDID hashes were
            // persisted: remap by target id with the same deterministic preference, but never
            // guess across adapters (iGPU/dGPU pairs reuse the same target id numbering, so a
            // cross-adapter pick could land on the wrong physical monitor and get persisted).
            let candidates = unique_unused_candidates_by_target_id(
                output.display_id.target_id,
                &current.outputs,
                &used,
            );
            if candidates_share_one_adapter(&candidates) {
                replacement = choose_remap_candidate(&candidates)
                    .map(|candidate| candidate.display_id.clone());
            }
        }

        if let Some(next_id) = replacement {
            used.insert(next_id.clone());
            output.display_id = next_id;
        }
    }

    remapped
}

fn ensure_all_enabled_outputs_resolve(
    desired: &Layout,
    current: &Layout,
) -> Result<(), ManagerError> {
    let current_ids: HashSet<&DisplayId> = current
        .outputs
        .iter()
        .map(|output| &output.display_id)
        .collect();

    if let Some(unresolved) = desired
        .outputs
        .iter()
        .find(|output| output.enabled && !current_ids.contains(&output.display_id))
    {
        let edid_hash = unresolved
            .display_id
            .edid_hash
            .map(|value| format!("{value:016x}"))
            .unwrap_or_else(|| "-".to_string());
        return Err(ManagerError::Validation(format!(
            "profile/layout references an unknown display (target_id={}, edid_hash={edid_hash}). re-save the profile on this system",
            unresolved.display_id.target_id
        )));
    }

    Ok(())
}

fn candidates_share_one_adapter(candidates: &[&crate::model::OutputConfig]) -> bool {
    let mut adapters = candidates
        .iter()
        .map(|candidate| candidate.display_id.adapter_luid);
    let Some(first) = adapters.next() else {
        return true;
    };
    adapters.all(|adapter| adapter == first)
}

fn choose_remap_candidate<'a>(
    candidates: &[&'a crate::model::OutputConfig],
) -> Option<&'a crate::model::OutputConfig> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some(candidates[0]);
    }

    // Deterministic tie-break for duplicate identities (e.g. a stale cached entry plus the same
    // physical monitor re-enumerated under a new adapter LUID after resume/reboot): prefer the
    // single enabled candidate. Two active identical twins stay ambiguous and are left unmapped.
    let enabled: Vec<_> = candidates
        .iter()
        .copied()
        .filter(|candidate| candidate.enabled)
        .collect();
    if enabled.len() == 1 {
        return Some(enabled[0]);
    }

    None
}

fn unique_unused_candidates<'a>(
    candidates: Vec<&'a crate::model::OutputConfig>,
    used: &HashSet<DisplayId>,
) -> Vec<&'a crate::model::OutputConfig> {
    candidates
        .into_iter()
        .filter(|candidate| !used.contains(&candidate.display_id))
        .collect()
}

fn unique_unused_candidates_by_target_id<'a>(
    target_id: u32,
    current_outputs: &'a [crate::model::OutputConfig],
    used: &HashSet<DisplayId>,
) -> Vec<&'a crate::model::OutputConfig> {
    current_outputs
        .iter()
        .filter(|candidate| candidate.display_id.target_id == target_id)
        .filter(|candidate| !used.contains(&candidate.display_id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Accion, AudioTarget, OutputConfig, PerfilAcciones, Position, Resolution},
        MemoryConfigStore, MockBackend,
    };

    fn sample_display_id(target_id: u32) -> DisplayId {
        sample_display_id_on_adapter(1, target_id)
    }

    fn sample_display_id_on_adapter(adapter_luid: u64, target_id: u32) -> DisplayId {
        DisplayId {
            adapter_luid,
            target_id,
            edid_hash: Some(target_id as u64),
        }
    }

    fn sample_layout() -> Layout {
        sample_layout_on_adapter(1)
    }

    fn sample_layout_on_adapter(adapter_luid: u64) -> Layout {
        Layout {
            outputs: vec![
                OutputConfig {
                    display_id: sample_display_id_on_adapter(adapter_luid, 1),
                    enabled: true,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 1920,
                        height: 1080,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: true,
                },
                OutputConfig {
                    display_id: sample_display_id_on_adapter(adapter_luid, 2),
                    enabled: true,
                    position: Position { x: 1920, y: 0 },
                    resolution: Resolution {
                        width: 2560,
                        height: 1440,
                    },
                    refresh_rate_mhz: 144_000,
                    primary: false,
                },
            ],
        }
    }

    fn sample_displays() -> Vec<DisplayInfo> {
        sample_displays_on_adapter(1)
    }

    fn sample_displays_on_adapter(adapter_luid: u64) -> Vec<DisplayInfo> {
        vec![
            DisplayInfo {
                id: sample_display_id_on_adapter(adapter_luid, 1),
                friendly_name: "Primary".to_string(),
                is_active: true,
                is_primary: true,
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
                refresh_rate_mhz: 60_000,
            },
            DisplayInfo {
                id: sample_display_id_on_adapter(adapter_luid, 2),
                friendly_name: "Secondary".to_string(),
                is_active: true,
                is_primary: false,
                resolution: Resolution {
                    width: 2560,
                    height: 1440,
                },
                refresh_rate_mhz: 144_000,
            },
        ]
    }

    fn build_manager() -> (
        MonarchDisplayManager<MockBackend, MemoryConfigStore>,
        MockBackend,
        MemoryConfigStore,
    ) {
        let backend = MockBackend::new(sample_displays(), sample_layout()).unwrap();
        let store = MemoryConfigStore::default();
        let manager = MonarchDisplayManager::new(backend.clone(), store.clone()).unwrap();
        (manager, backend, store)
    }

    /// Mock wrapper that counts `prepare_attach_targets` and `apply_layout` calls (the latter is
    /// the core-visible proxy for "the topology was touched") and can simulate apply failures.
    #[derive(Clone)]
    struct CountingBackend {
        inner: MockBackend,
        prepare_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        apply_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        fail_apply: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl CountingBackend {
        fn new(inner: MockBackend) -> Self {
            Self {
                inner,
                prepare_calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                apply_calls: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                fail_apply: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }
        }

        fn prepare_calls(&self) -> usize {
            self.prepare_calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn apply_calls(&self) -> usize {
            self.apply_calls.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn set_fail_apply(&self, fail: bool) {
            self.fail_apply
                .store(fail, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl DisplayBackend for CountingBackend {
        fn list_displays(&self) -> Result<Vec<DisplayInfo>, ManagerError> {
            self.inner.list_displays()
        }

        fn get_layout(&self) -> Result<Layout, ManagerError> {
            self.inner.get_layout()
        }

        fn apply_layout(&self, layout: Layout) -> Result<(), ManagerError> {
            self.apply_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail_apply.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(ManagerError::Backend("simulated apply failure".to_string()));
            }
            self.inner.apply_layout(layout)
        }

        fn prepare_attach_targets(&self, _desired: &Layout) -> Result<(), ManagerError> {
            self.prepare_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn toggle_display_creates_pending_confirmation() {
        let (mut manager, backend, _) = build_manager();
        manager.toggle_display(&sample_display_id(2)).unwrap();

        let layout = backend.current_layout().unwrap();
        assert_eq!(layout.enabled_output_count(), 1);
        assert!(manager.has_pending_confirmation());
        assert!(manager.pending_confirmation_remaining().is_some());
    }

    #[test]
    fn cannot_disable_last_active_display() {
        let (mut manager, _, _) = build_manager();

        manager.toggle_display(&sample_display_id(2)).unwrap();
        manager.confirm_current_layout().unwrap();

        let err = manager.toggle_display(&sample_display_id(1)).unwrap_err();
        assert!(matches!(err, ManagerError::Validation(_)));
    }

    #[test]
    fn rollback_restores_previous_layout() {
        let (mut manager, backend, store) = build_manager();
        let original = backend.current_layout().unwrap();

        manager.toggle_display(&sample_display_id(2)).unwrap();
        manager.rollback_pending().unwrap();

        assert_eq!(backend.current_layout().unwrap(), original);
        assert_eq!(
            store.snapshot().unwrap().last_known_good_layout,
            Some(original)
        );
    }

    #[test]
    fn detaching_primary_reassigns_primary_and_rebases_origin() {
        let (mut manager, backend, _) = build_manager();

        manager.toggle_display(&sample_display_id(1)).unwrap();

        let layout = backend.current_layout().unwrap();
        let primary = layout
            .outputs
            .iter()
            .find(|output| output.enabled && output.primary)
            .expect("expected new primary after detaching original primary");
        assert_eq!(primary.display_id, sample_display_id(2));
        assert_eq!(primary.position, Position { x: 0, y: 0 });

        let detached_former_primary = layout
            .outputs
            .iter()
            .find(|output| output.display_id == sample_display_id(1))
            .expect("expected detached former primary output");
        assert!(!detached_former_primary.enabled);
        assert_eq!(
            detached_former_primary.position,
            Position { x: -1920, y: 0 }
        );
    }

    #[test]
    fn reattaching_primary_after_detach_preserves_non_overlapping_positions() {
        let (mut manager, backend, _) = build_manager();

        manager.toggle_display(&sample_display_id(1)).unwrap();
        manager.confirm_current_layout().unwrap();
        manager.toggle_display(&sample_display_id(1)).unwrap();

        let layout = backend.current_layout().unwrap();
        let enabled: Vec<_> = layout
            .outputs
            .iter()
            .filter(|output| output.enabled)
            .collect();
        assert_eq!(enabled.len(), 2);
        assert!(enabled
            .iter()
            .any(|output| output.position == Position { x: 0, y: 0 }));
        assert!(enabled
            .iter()
            .any(|output| output.position == Position { x: -1920, y: 0 }));
    }

    #[test]
    fn can_apply_again_after_manual_rollback() {
        let (mut manager, backend, _) = build_manager();

        manager.toggle_display(&sample_display_id(2)).unwrap();
        assert!(manager.has_pending_confirmation());

        manager.rollback_pending().unwrap();
        assert!(!manager.has_pending_confirmation());

        manager.toggle_display(&sample_display_id(2)).unwrap();
        assert!(manager.has_pending_confirmation());
        assert_eq!(backend.current_layout().unwrap().enabled_output_count(), 1);
    }

    #[test]
    fn save_and_apply_profile_round_trip() {
        let (mut manager, backend, _) = build_manager();

        manager.save_profile("dual", false).unwrap();
        manager.toggle_display(&sample_display_id(2)).unwrap();
        manager.confirm_current_layout().unwrap();

        manager.apply_profile("dual").unwrap();
        let layout = backend.current_layout().unwrap();
        assert_eq!(layout.enabled_output_count(), 2);
        assert!(manager.has_pending_confirmation());
    }

    #[test]
    fn applying_matching_profile_is_a_noop() {
        let (mut manager, backend, _) = build_manager();

        manager.save_profile("current", false).unwrap();
        let before = backend.current_layout().unwrap();

        manager.apply_profile("current").unwrap();

        assert_eq!(backend.current_layout().unwrap(), before);
        assert!(!manager.has_pending_confirmation());
    }

    #[test]
    fn apply_profile_remaps_display_ids_after_adapter_luid_change() {
        let backend =
            MockBackend::new(sample_displays_on_adapter(9), sample_layout_on_adapter(9)).unwrap();
        let profile_layout = sample_layout_on_adapter(1);
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "dual".to_string(),
                layout: profile_layout,
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager.apply_profile("dual").unwrap();

        let applied = backend.current_layout().unwrap();
        assert!(applied
            .outputs
            .iter()
            .all(|output| output.display_id.adapter_luid == 9));
        assert!(!manager.has_pending_confirmation());
    }

    #[test]
    fn apply_profile_does_not_fallback_to_wrong_target_when_edid_is_known() {
        let display_one = DisplayInfo {
            id: DisplayId {
                adapter_luid: 9,
                target_id: 1,
                edid_hash: Some(1),
            },
            friendly_name: "Left".to_string(),
            is_active: true,
            is_primary: true,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            refresh_rate_mhz: 60_000,
        };
        let display_three_reusing_target = DisplayInfo {
            id: DisplayId {
                adapter_luid: 9,
                target_id: 2,
                edid_hash: Some(3),
            },
            friendly_name: "Ultrawide".to_string(),
            is_active: false,
            is_primary: false,
            resolution: Resolution {
                width: 3440,
                height: 1440,
            },
            refresh_rate_mhz: 144_000,
        };
        let backend = MockBackend::new(
            vec![display_one.clone(), display_three_reusing_target.clone()],
            Layout {
                outputs: vec![
                    OutputConfig {
                        display_id: display_one.id.clone(),
                        enabled: true,
                        position: Position { x: 0, y: 0 },
                        resolution: display_one.resolution.clone(),
                        refresh_rate_mhz: display_one.refresh_rate_mhz,
                        primary: true,
                    },
                    OutputConfig {
                        display_id: display_three_reusing_target.id.clone(),
                        enabled: false,
                        position: Position { x: 1920, y: 0 },
                        resolution: display_three_reusing_target.resolution.clone(),
                        refresh_rate_mhz: display_three_reusing_target.refresh_rate_mhz,
                        primary: false,
                    },
                ],
            },
        )
        .unwrap();
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "work".to_string(),
                layout: Layout {
                    outputs: vec![
                        OutputConfig {
                            display_id: DisplayId {
                                adapter_luid: 1,
                                target_id: 1,
                                edid_hash: Some(1),
                            },
                            enabled: true,
                            position: Position { x: 0, y: 0 },
                            resolution: Resolution {
                                width: 1920,
                                height: 1080,
                            },
                            refresh_rate_mhz: 60_000,
                            primary: true,
                        },
                        OutputConfig {
                            display_id: DisplayId {
                                adapter_luid: 1,
                                target_id: 2,
                                edid_hash: Some(2),
                            },
                            enabled: true,
                            position: Position { x: 1920, y: 0 },
                            resolution: Resolution {
                                width: 1920,
                                height: 1080,
                            },
                            refresh_rate_mhz: 60_000,
                            primary: false,
                        },
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend, store).unwrap();

        let err = manager.apply_profile("work").unwrap_err();
        assert!(matches!(
            err,
            ManagerError::Validation(message)
                if message.contains("is not connected right now")
        ));
    }

    fn duplicate_edid_current_state() -> (Vec<DisplayInfo>, Layout, DisplayId, DisplayId) {
        let primary_id = DisplayId {
            adapter_luid: 9,
            target_id: 1,
            edid_hash: Some(1),
        };
        let stale_id = DisplayId {
            adapter_luid: 1,
            target_id: 2,
            edid_hash: Some(2),
        };
        let fresh_id = DisplayId {
            adapter_luid: 9,
            target_id: 2,
            edid_hash: Some(2),
        };

        let displays = vec![
            DisplayInfo {
                id: primary_id.clone(),
                friendly_name: "Primary".to_string(),
                is_active: true,
                is_primary: true,
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
                refresh_rate_mhz: 60_000,
            },
            DisplayInfo {
                id: stale_id.clone(),
                friendly_name: "Secondary".to_string(),
                is_active: false,
                is_primary: false,
                resolution: Resolution {
                    width: 2560,
                    height: 1440,
                },
                refresh_rate_mhz: 144_000,
            },
            DisplayInfo {
                id: fresh_id.clone(),
                friendly_name: "Secondary".to_string(),
                is_active: true,
                is_primary: false,
                resolution: Resolution {
                    width: 2560,
                    height: 1440,
                },
                refresh_rate_mhz: 144_000,
            },
        ];
        let layout = Layout {
            outputs: vec![
                OutputConfig {
                    display_id: primary_id,
                    enabled: true,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 1920,
                        height: 1080,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: true,
                },
                OutputConfig {
                    display_id: stale_id.clone(),
                    enabled: false,
                    position: Position { x: 1920, y: 0 },
                    resolution: Resolution {
                        width: 2560,
                        height: 1440,
                    },
                    refresh_rate_mhz: 144_000,
                    primary: false,
                },
                OutputConfig {
                    display_id: fresh_id.clone(),
                    enabled: true,
                    position: Position { x: 1920, y: 0 },
                    resolution: Resolution {
                        width: 2560,
                        height: 1440,
                    },
                    refresh_rate_mhz: 144_000,
                    primary: false,
                },
            ],
        };

        (displays, layout, stale_id, fresh_id)
    }

    fn profile_output(display_id: DisplayId, x: i32, primary: bool) -> OutputConfig {
        OutputConfig {
            display_id,
            enabled: true,
            position: Position { x, y: 0 },
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
            refresh_rate_mhz: 60_000,
            primary,
        }
    }

    #[test]
    fn apply_profile_prefers_active_candidate_among_duplicate_edid_entries() {
        let (displays, layout, stale_id, fresh_id) = duplicate_edid_current_state();
        let backend = MockBackend::new(displays, layout).unwrap();
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "dual".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 1,
                                edid_hash: Some(1),
                            },
                            0,
                            true,
                        ),
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 2,
                                edid_hash: Some(2),
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager.apply_profile("dual").unwrap();

        let applied = backend.current_layout().unwrap();
        let secondary = applied
            .outputs
            .iter()
            .find(|output| output.display_id.edid_hash == Some(2))
            .expect("expected remapped secondary output");
        assert_eq!(secondary.display_id, fresh_id);
        assert!(secondary.enabled);
        assert!(!applied
            .outputs
            .iter()
            .any(|output| output.display_id == stale_id));
    }

    #[test]
    fn apply_profile_hashless_fallback_does_not_guess_across_adapters() {
        // Two candidates share target_id 2 but live on different adapters (stale LUID entry vs
        // fresh one). The hash-less fallback must not guess between them: iGPU/dGPU pairs reuse
        // target id numbering, so a cross-adapter pick could hit the wrong physical monitor.
        let (displays, layout, _, _) = duplicate_edid_current_state();
        let backend = MockBackend::new(displays, layout).unwrap();
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "legacy".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 1,
                                edid_hash: None,
                            },
                            0,
                            true,
                        ),
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 2,
                                edid_hash: None,
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend, store).unwrap();

        let err = manager.apply_profile("legacy").unwrap_err();
        assert!(matches!(
            err,
            ManagerError::Validation(message)
                if message.contains("is not connected right now")
        ));
    }

    #[test]
    fn apply_profile_still_bails_for_two_active_twin_candidates() {
        let primary_id = DisplayId {
            adapter_luid: 9,
            target_id: 1,
            edid_hash: Some(1),
        };
        let twin_left_id = DisplayId {
            adapter_luid: 9,
            target_id: 2,
            edid_hash: Some(7),
        };
        let twin_right_id = DisplayId {
            adapter_luid: 9,
            target_id: 3,
            edid_hash: Some(7),
        };
        let twin_display = |id: &DisplayId| DisplayInfo {
            id: id.clone(),
            friendly_name: "Twin".to_string(),
            is_active: true,
            is_primary: false,
            resolution: Resolution {
                width: 2560,
                height: 1440,
            },
            refresh_rate_mhz: 144_000,
        };
        let displays = vec![
            DisplayInfo {
                id: primary_id.clone(),
                friendly_name: "Primary".to_string(),
                is_active: true,
                is_primary: true,
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
                refresh_rate_mhz: 60_000,
            },
            twin_display(&twin_left_id),
            twin_display(&twin_right_id),
        ];
        let twin_output = |id: &DisplayId, x: i32| OutputConfig {
            display_id: id.clone(),
            enabled: true,
            position: Position { x, y: 0 },
            resolution: Resolution {
                width: 2560,
                height: 1440,
            },
            refresh_rate_mhz: 144_000,
            primary: false,
        };
        let layout = Layout {
            outputs: vec![
                OutputConfig {
                    display_id: primary_id,
                    enabled: true,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 1920,
                        height: 1080,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: true,
                },
                twin_output(&twin_left_id, 1920),
                twin_output(&twin_right_id, 4480),
            ],
        };
        let backend = MockBackend::new(displays, layout).unwrap();
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "twins".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 1,
                                edid_hash: Some(1),
                            },
                            0,
                            true,
                        ),
                        profile_output(
                            DisplayId {
                                adapter_luid: 5,
                                target_id: 9,
                                edid_hash: Some(7),
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend, store).unwrap();

        let err = manager.apply_profile("twins").unwrap_err();
        assert!(matches!(
            err,
            ManagerError::Validation(message)
                if message.contains("is not connected right now")
        ));
    }

    #[test]
    fn apply_profile_hashless_legacy_output_remaps_to_seeded_inactive_display() {
        // Field case (Guido's TV): a legacy profile entry saved without edid_hash by an old
        // build, while the detached TV exists only as an ALL_PATHS-seeded inactive display
        // under the current adapter LUID. The hash-less target_id fallback must accept the
        // seeded candidate (Some(hash) on the candidate, None on the request) and remap.
        let primary_id = DisplayId {
            adapter_luid: 9,
            target_id: 1,
            edid_hash: Some(1),
        };
        let seeded_tv_id = DisplayId {
            adapter_luid: 9,
            target_id: 4352,
            edid_hash: Some(77),
        };
        let displays = vec![
            DisplayInfo {
                id: primary_id.clone(),
                friendly_name: "Primary".to_string(),
                is_active: true,
                is_primary: true,
                resolution: Resolution {
                    width: 1920,
                    height: 1080,
                },
                refresh_rate_mhz: 60_000,
            },
            DisplayInfo {
                id: seeded_tv_id.clone(),
                friendly_name: "TV".to_string(),
                is_active: false,
                is_primary: false,
                resolution: Resolution {
                    width: 0,
                    height: 0,
                },
                refresh_rate_mhz: 60_000,
            },
        ];
        let layout = Layout {
            outputs: vec![
                OutputConfig {
                    display_id: primary_id,
                    enabled: true,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 1920,
                        height: 1080,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: true,
                },
                OutputConfig {
                    display_id: seeded_tv_id.clone(),
                    enabled: false,
                    position: Position { x: 0, y: 0 },
                    resolution: Resolution {
                        width: 0,
                        height: 0,
                    },
                    refresh_rate_mhz: 60_000,
                    primary: false,
                },
            ],
        };
        let backend = MockBackend::new(displays, layout).unwrap();
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "couch".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(
                            DisplayId {
                                adapter_luid: 1,
                                target_id: 1,
                                edid_hash: None,
                            },
                            0,
                            true,
                        ),
                        profile_output(
                            DisplayId {
                                adapter_luid: 1,
                                target_id: 4352,
                                edid_hash: None,
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager.apply_profile("couch").unwrap();

        let applied = backend.current_layout().unwrap();
        let tv = applied
            .outputs
            .iter()
            .find(|output| output.display_id == seeded_tv_id)
            .expect("expected TV output remapped to the seeded display");
        assert!(tv.enabled);
    }

    #[test]
    fn apply_profile_does_not_touch_topology_when_display_is_not_connected() {
        // Field case: after a resume, Windows reported one of the monitors with
        // targetAvailable=FALSE, so it was not enumerated at all. Applying a profile that wants
        // it must NOT change the topology — the old code forced a topology extend here, which
        // attached every connected-inactive display (including a TV the very same profile asks to
        // detach), stalled 3.5s and failed anyway. An absent display is not an attach failure.
        let backend =
            CountingBackend::new(MockBackend::new(sample_displays(), sample_layout()).unwrap());
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "PC".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(sample_display_id(1), 0, true),
                        // A monitor Windows is not enumerating right now.
                        profile_output(
                            DisplayId {
                                adapter_luid: 1,
                                target_id: 4353,
                                edid_hash: Some(0xa8c7_f832_281a_39c5),
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        let err = manager.apply_profile("PC").unwrap_err();
        assert!(
            matches!(&err, ManagerError::Validation(message) if message.contains("is not connected right now")),
            "expected the not-connected diagnosis, got: {err}"
        );
        assert_eq!(
            backend.apply_calls(),
            0,
            "an absent display must never trigger a topology change"
        );
        assert!(!manager.has_pending_confirmation());
    }

    #[test]
    fn apply_profile_calls_prepare_attach_targets_when_outputs_are_unresolved() {
        let backend =
            CountingBackend::new(MockBackend::new(sample_displays(), sample_layout()).unwrap());
        let store = MemoryConfigStore::new(AppConfig {
            profiles: vec![Profile {
                name: "ghost".to_string(),
                layout: Layout {
                    outputs: vec![
                        profile_output(sample_display_id(1), 0, true),
                        profile_output(
                            DisplayId {
                                adapter_luid: 1,
                                target_id: 9,
                                edid_hash: Some(99),
                            },
                            1920,
                            false,
                        ),
                    ],
                },
            }],
            ..AppConfig::default()
        });
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        let err = manager.apply_profile("ghost").unwrap_err();
        assert!(matches!(
            err,
            ManagerError::Validation(message)
                if message.contains("is not connected right now")
        ));
        assert_eq!(backend.prepare_calls(), 1);
    }

    #[test]
    fn apply_profile_does_not_call_prepare_attach_targets_when_outputs_resolve() {
        let backend =
            CountingBackend::new(MockBackend::new(sample_displays(), sample_layout()).unwrap());
        let store = MemoryConfigStore::default();
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager.save_profile("dual", false).unwrap();
        manager.toggle_display(&sample_display_id(2)).unwrap();
        manager.confirm_current_layout().unwrap();

        manager.apply_profile("dual").unwrap();

        assert_eq!(backend.prepare_calls(), 0);
    }

    #[test]
    fn rollback_pending_keeps_pending_when_backend_apply_fails() {
        let backend =
            CountingBackend::new(MockBackend::new(sample_displays(), sample_layout()).unwrap());
        let store = MemoryConfigStore::default();
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager.toggle_display(&sample_display_id(2)).unwrap();
        assert!(manager.has_pending_confirmation());

        backend.set_fail_apply(true);
        assert!(manager.rollback_pending().is_err());
        assert!(manager.has_pending_confirmation());

        backend.set_fail_apply(false);
        manager.rollback_pending().unwrap();
        assert!(!manager.has_pending_confirmation());
    }

    #[test]
    fn toggle_display_remaps_stale_adapter_luid_by_target_id() {
        let backend =
            MockBackend::new(sample_displays_on_adapter(9), sample_layout_on_adapter(9)).unwrap();
        let store = MemoryConfigStore::default();
        let mut manager = MonarchDisplayManager::new(backend.clone(), store).unwrap();

        manager
            .toggle_display(&sample_display_id_on_adapter(1, 2))
            .unwrap();

        let layout = backend.current_layout().unwrap();
        let output = layout
            .outputs
            .iter()
            .find(|output| output.display_id == sample_display_id_on_adapter(9, 2))
            .expect("expected remapped target");
        assert!(!output.enabled);
    }

    #[test]
    fn delete_profile_removes_saved_profile() {
        let (mut manager, _, _) = build_manager();
        manager.save_profile("dual", false).unwrap();
        manager.delete_profile("dual").unwrap();
        assert!(manager.list_profiles().is_empty());
    }

    #[test]
    fn restore_last_layout_restores_previous_confirmed_layout() {
        let (mut manager, backend, _) = build_manager();
        let original = backend.current_layout().unwrap();

        manager.toggle_display(&sample_display_id(2)).unwrap();
        manager.confirm_current_layout().unwrap();
        assert_eq!(backend.current_layout().unwrap().enabled_output_count(), 1);

        manager.restore_last_layout().unwrap();
        assert_eq!(backend.current_layout().unwrap(), original);
    }

    #[test]
    fn expired_confirmation_triggers_auto_rollback() {
        let (mut manager, backend, _) = build_manager();
        let original = backend.current_layout().unwrap();

        manager.set_confirmation_timeout(Duration::ZERO);
        manager.toggle_display(&sample_display_id(2)).unwrap();

        let rolled_back = manager.rollback_if_confirmation_expired().unwrap();
        assert!(rolled_back);
        assert_eq!(backend.current_layout().unwrap(), original);
        assert!(!manager.has_pending_confirmation());
    }

    // --- Displays v2, Fase 3: audio por perfil ------------------------------

    #[test]
    fn update_settings_preserves_profile_audio() {
        // Trampa #1: update_settings re-arma AppSettings campo por campo. Guardar
        // CUALQUIER ajuste NO debe vaciar las salidas de audio por perfil.
        let (mut manager, _backend, _store) = build_manager();

        let mut settings = manager.settings().clone();
        settings.profile_audio.insert(
            "TV".to_string(),
            AudioTarget {
                endpoint_id: "{0.0.0.00000000}.{tv-endpoint}".to_string(),
                friendly_name: "TV Samsung".to_string(),
            },
        );
        manager.update_settings(settings).unwrap();
        assert_eq!(
            manager.settings().profile_audio.len(),
            1,
            "update_settings descartó el audio recién asignado"
        );

        // Cambiar OTRO ajuste (perfil de arranque) y guardar: el audio DEBE
        // seguir intacto (es la regresión que blinda la trampa #1).
        let mut settings = manager.settings().clone();
        settings.startup_profile_name = Some("TV".to_string());
        manager.update_settings(settings).unwrap();

        let audio = manager.settings().profile_audio.get("TV");
        assert!(
            audio.is_some(),
            "trampa #1: cambiar un ajuste vació profile_audio"
        );
        assert_eq!(audio.unwrap().friendly_name, "TV Samsung");
        assert_eq!(
            manager.settings().startup_profile_name.as_deref(),
            Some("TV")
        );
    }

    #[test]
    fn config_without_profile_audio_loads_with_empty_map() {
        // Regresión (criterio 1): un displays.json de v1.3.0 NO tiene la clave
        // profile_audio; debe cargar igual, con el mapa vacío, sin perder nada.
        let json = r#"{
            "profiles": [{ "name": "dual", "layout": { "outputs": [] } }],
            "settings": {
                "revert_timeout_secs": 8,
                "profile_shortcuts": { "dual": "Ctrl+Shift+1" }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(
            config.settings.profile_audio.is_empty(),
            "profile_audio debe nacer vacío en un store viejo"
        );
        assert_eq!(config.settings.revert_timeout_secs, 8);
        assert_eq!(
            config
                .settings
                .profile_shortcuts
                .get("dual")
                .map(String::as_str),
            Some("Ctrl+Shift+1")
        );
        assert_eq!(config.profiles.len(), 1);
    }

    #[test]
    fn profile_audio_survives_json_round_trip() {
        // El campo nuevo persiste y se relee idéntico (ida y vuelta por JSON).
        let mut config = AppConfig::default();
        config.settings.profile_audio.insert(
            "TV".to_string(),
            AudioTarget {
                endpoint_id: "{endpoint-id}".to_string(),
                friendly_name: "TV".to_string(),
            },
        );
        let json = serde_json::to_string(&config).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, back);
        assert_eq!(
            back.settings.profile_audio.get("TV").unwrap().endpoint_id,
            "{endpoint-id}"
        );
    }

    // --- Displays v2, Fase 4: acciones por perfil (escenas) -----------------

    #[test]
    fn update_settings_preserves_profile_actions() {
        // Trampa #1 (Fase 4): update_settings re-arma AppSettings campo por campo.
        // Guardar CUALQUIER ajuste NO debe vaciar las acciones por perfil.
        let (mut manager, _backend, _store) = build_manager();

        let mut settings = manager.settings().clone();
        settings.profile_actions.insert(
            "Jugar".to_string(),
            PerfilAcciones {
                entrada: vec![
                    Accion::Lanzar {
                        destino: "steam.exe".to_string(),
                        args: vec!["-start".to_string(), "steam://open/bigpicture".to_string()],
                    },
                    Accion::Volumen { nivel: 40 },
                ],
                salida: vec![Accion::Lanzar {
                    destino: "steam://close/bigpicture".to_string(),
                    args: vec![],
                }],
                ..Default::default()
            },
        );
        manager.update_settings(settings).unwrap();
        assert_eq!(
            manager.settings().profile_actions.len(),
            1,
            "update_settings descartó las acciones recién asignadas"
        );

        // Cambiar OTRO ajuste (perfil de arranque) y guardar: las acciones DEBEN
        // seguir intactas (regresión que blinda la trampa #1 para la Fase 4).
        let mut settings = manager.settings().clone();
        settings.startup_profile_name = Some("Jugar".to_string());
        manager.update_settings(settings).unwrap();

        let acciones = manager.settings().profile_actions.get("Jugar");
        assert!(
            acciones.is_some(),
            "trampa #1: cambiar un ajuste vació profile_actions"
        );
        assert_eq!(acciones.unwrap().entrada.len(), 2);
        assert_eq!(acciones.unwrap().salida.len(), 1);
        assert_eq!(
            manager.settings().startup_profile_name.as_deref(),
            Some("Jugar")
        );
    }

    #[test]
    fn config_without_profile_actions_loads_with_empty_map() {
        // Regresión (criterio 1): un displays.json de v1.4.0 NO tiene la clave
        // profile_actions; debe cargar igual, con el mapa vacío, sin perder nada.
        let json = r#"{
            "profiles": [{ "name": "dual", "layout": { "outputs": [] } }],
            "settings": {
                "revert_timeout_secs": 8,
                "profile_shortcuts": { "dual": "Ctrl+Shift+1" }
            }
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(
            config.settings.profile_actions.is_empty(),
            "profile_actions debe nacer vacío en un store viejo"
        );
        assert_eq!(config.settings.revert_timeout_secs, 8);
        assert_eq!(config.profiles.len(), 1);
    }

    #[test]
    fn profile_actions_survive_json_round_trip() {
        // Ida y vuelta por JSON: las acciones persisten y se releen idénticas,
        // con el tag serde ("tipo") y los args opcionales.
        let mut config = AppConfig::default();
        config.settings.profile_actions.insert(
            "VerPelis".to_string(),
            PerfilAcciones {
                entrada: vec![Accion::Lanzar {
                    destino: "chrome.exe".to_string(),
                    args: vec!["--profile-directory=Default".to_string()],
                }],
                salida: vec![],
                ..Default::default()
            },
        );
        let json = serde_json::to_string(&config).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, back);
        // Un `lanzar` sin `args` en el JSON debe deserializar con la lista vacía.
        let one: PerfilAcciones =
            serde_json::from_str(r#"{"entrada":[{"tipo":"lanzar","destino":"x.exe"}],"salida":[]}"#)
                .unwrap();
        match &one.entrada[0] {
            Accion::Lanzar { destino, args } => {
                assert_eq!(destino, "x.exe");
                assert!(args.is_empty(), "args omitido debe caer en Vec vacío");
            }
            _ => panic!("esperaba Lanzar"),
        }
    }
}
