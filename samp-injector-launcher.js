const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function getBundledInjectorPath() {
    try {
        const { app } = require('electron');
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'native', 'samp-injector.exe');
        }
    } catch (_) {
        // outside Electron (tests/scripts)
    }

    return path.join(__dirname, 'native', 'samp-injector.exe');
}

function resolveInjectorExePath() {
    const exePath = getBundledInjectorPath();
    return fs.existsSync(exePath) ? exePath : null;
}

function validateGameFolder(gamePath) {
    if (!fs.existsSync(path.join(gamePath, 'gta_sa.exe'))) {
        return `gta_sa.exe not found: ${path.join(gamePath, 'gta_sa.exe')}`;
    }

    if (!fs.existsSync(path.join(gamePath, 'samp.dll'))) {
        return `samp.dll not found: ${path.join(gamePath, 'samp.dll')}`;
    }

    return null;
}

function launchViaSampInjector(gamePath, nickname, ip, port, password = '', mode = 'samp') {
    if (process.platform !== 'win32') {
        return Promise.resolve({ success: false, error: 'SA-MP injector is only supported on Windows' });
    }

    const exePath = resolveInjectorExePath();
    if (!exePath) {
        return Promise.resolve({ success: false, error: 'samp-injector.exe not found in launcher' });
    }

    const validationError = validateGameFolder(gamePath);
    if (validationError) {
        return Promise.resolve({ success: false, error: validationError });
    }

    const injectorArgs = [
        mode,
        gamePath,
        nickname,
        ip,
        String(port),
        password || ''
    ];

    return new Promise((resolve, reject) => {
        const cmdArgs = [
            '/c',
            'start',
            '""',
            '/D',
            gamePath,
            exePath,
            ...injectorArgs
        ];

        console.log('samp-injector command:', 'cmd.exe', cmdArgs.join(' '));

        const child = spawn('cmd.exe', cmdArgs, {
            windowsHide: true,
            detached: true,
            stdio: 'ignore'
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('spawn', () => {
            child.unref();
            resolve({
                success: true,
                method: 'samp-injector.exe',
                exePath
            });
        });
    });
}

function isSampInjectorAvailable() {
    return Boolean(resolveInjectorExePath());
}

module.exports = {
    launchViaSampInjector,
    isSampInjectorAvailable,
    resolveInjectorExePath
};
