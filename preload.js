
const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
    'electronAPI', {
    // Window management
    closeWindow: () => ipcRenderer.send('close-window'),
    minimizeLauncher: () => ipcRenderer.send('minimize-window'),

    // External links
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // Game files verification and download
    checkFiles: () => ipcRenderer.invoke('check-files'),
    downloadFiles: (options) => ipcRenderer.invoke('download-files', options),

    // Nickname management
    getNickname: () => ipcRenderer.invoke('get-nickname'),
    saveNickname: (nickname) => ipcRenderer.invoke('save-nickname', nickname),
    validateNickname: (nickname) => ipcRenderer.invoke('validate-nickname', nickname),
    initRegistry: () => ipcRenderer.invoke('init-registry'),

    // Game launching
    startGame: (nickname, server) => ipcRenderer.invoke('start-game', nickname, server),

    // Installation path management
    getInstallationPath: () => ipcRenderer.invoke('get-installation-path'),
    setInstallationPath: (path) => ipcRenderer.invoke('set-installation-path', path),
    validateInstallationPath: (path) => ipcRenderer.invoke('validate-installation-path', path),
    showDirectoryPicker: () => ipcRenderer.invoke('show-directory-picker'),

    // SAMP server queries
    getServerOnline: (options) => ipcRenderer.invoke('get-server-online', options),
    getLauncherConfig: () => ipcRenderer.invoke('get-launcher-config'),

    // Mods management
    getActiveMods: () => ipcRenderer.invoke('get-active-mods'),
    setGraphicsMod: (modName) => ipcRenderer.invoke('set-graphics-mod', modName),
    toggleWidescreenFix: (enable) => ipcRenderer.invoke('toggle-widescreen-fix', enable),

    // Update functionality
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    installUpdate: () => ipcRenderer.invoke('install-update'),

    // Event listeners
    onCheckFilesProgress: (callback) => {
        const subscription = (event, progress) => callback(progress);
        ipcRenderer.on('check-files-progress', subscription);

        // Return unsubscribe function
        return () => ipcRenderer.removeListener('check-files-progress', subscription);
    },

    onDownloadProgress: (callback) => {
        const subscription = (event, progress) => callback(progress);
        ipcRenderer.on('download-progress', subscription);

        // Return unsubscribe function
        return () => ipcRenderer.removeListener('download-progress', subscription);
    },

    onDownloadFileFailed: (callback) => {
        const channel = 'download-file-failed';
        const subscription = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },

    onUpdateStatus: (callback) => {
        const channel = 'update-status';
        const subscription = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },

    onModsError: (callback) => {
        const channel = 'mods-error';
        const subscription = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, subscription);
        return () => {
            ipcRenderer.removeListener(channel, subscription);
        };
    },
    repairGame: () => ipcRenderer.invoke('repair-game'),
    forceRedownload: () => ipcRenderer.invoke('force-redownload'),
    checkGameRunning: () => ipcRenderer.invoke('check-game-running')
}
)

// Version information
contextBridge.exposeInMainWorld('app', {
    getVersion: () => {
        try {
            const { app } = require('@electron/remote');
            return app.getVersion();
        } catch (error) {
            console.error('Failed to get app version:', error);
            return '1.0.0'; // Fallback version
        }
    }
})
