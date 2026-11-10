// Mock de window.__TAURI__ para el banco de capturas (tools/ui-capturas).
// Datos fijos: nada de Date.now() ni azar en lo que se ve.
(function () {
  'use strict';

  const peers = [
    { id: 'aa11bb22cc33dd44', name: 'DRACOSSSLAPTOP', hexId: '0xA1B2', ip: '192.168.1.20', port: 53317,
      status: 'online', favorite: true, iconType: 'laptop', manual: false, clipboardSync: true },
    { id: 'ee55ff66aa77bb88', name: 'SALA-TV', hexId: '0xC3D4', ip: '192.168.1.31', port: 53317,
      status: 'online', favorite: false, iconType: 'media', manual: false, clipboardSync: false },
  ];

  const displays = [
    { id: 'mon-1', name: 'DELL U2723QE', active: true, primary: true, width: 2560, height: 1440, refreshMhz: 59951,
      positionX: 0, positionY: 0, adapterLuid: '0:1', targetId: 1, edidHash: null, canDetach: true },
    { id: 'mon-2', name: 'LG TV OLED', active: true, primary: false, width: 1920, height: 1080, refreshMhz: 60000,
      positionX: 2560, positionY: 0, adapterLuid: '0:1', targetId: 2, edidHash: null, canDetach: true },
  ];

  const profiles = [
    { name: 'ESCRITORIO', activeCount: 2, summary: '2 monitores · 2560×1440, 1920×1080',
      shortcut: 'Ctrl+Alt+1', audio: { endpointId: 'ep-1', friendlyName: 'Parlantes' },
      actions: { entrada: [], salida: [] } },
    { name: 'SOLO TV', activeCount: 1, summary: '1 monitor · 1920×1080',
      shortcut: null, audio: null, actions: { entrada: [], salida: [] } },
  ];

  const settings = {
    downloadDir: 'C:\\Users\\demo\\Downloads\\Millennium', autoAcceptFavorites: true,
    notificationsEnabled: true, startWithWindows: false, closeToTray: true,
  };

  const handlers = {
    get_local_info: () => ({ alias: 'MILLENNIUM-PC', hostIdHex: '0xFFFF', ip: '192.168.1.10', port: 53317,
      fingerprint: 'deadbeef', version: '0.0.0-mock' }),
    list_peers: () => peers,
    get_settings: () => settings,
    take_update_failure: () => null,
    get_runtime_log: () => [],
    displays_get_snapshot: () => ({ source: 'windows', displays, pending: null }),
    displays_list_profiles: () => profiles,
    displays_list_audio_outputs: () => [{ endpointId: 'ep-1', friendlyName: 'Parlantes' },
      { endpointId: 'ep-2', friendlyName: 'TV HDMI' }],
    displays_get_settings: () => ({ revertTimeoutSecs: 15, startupProfileName: null, globalShortcutsEnabled: true }),
  };

  async function invoke(cmd /*, args */) {
    const h = handlers[cmd];
    return h ? h() : null;
  }

  window.__TAURI__ = {
    core: { invoke },
    event: { listen: async () => () => {} },
    dialog: { open: async () => null },
    notification: {
      isPermissionGranted: async () => true,
      requestPermission: async () => 'granted',
      sendNotification: async () => {},
    },
  };
})();
