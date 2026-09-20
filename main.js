const { app, BrowserWindow, ipcMain, screen, shell, net } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { exec } = require('child_process')
const https = require('https')
const http = require('http')
const { EventEmitter } = require('events')
const downloadEmitter = new EventEmitter()
const { spawn } = require('child_process');
const regedit = require('regedit'); // You'll need to install this package
const { execSync } = require('child_process');
const { dialog } = require('electron');
const dgram = require('dgram');
const log = require('electron-log')
// Add at the top with your other requires
const { autoUpdater } = require('electron-updater');
const { execFile } = require('child_process');
const { launchViaSampInjector, isSampInjectorAvailable } = require('./samp-injector-launcher');

if (typeof process.env.USERPROFILE === 'undefined') {
    process.env.USERPROFILE = require('os').homedir();
}

// Полифилл для современных функций
if (!Object.fromEntries) {
    Object.fromEntries = entries => [...entries].reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {});
}

// Добавьте это в начало main.js, перед объявлением функций
const GAME_FILES_BASE_URL = 'https://wl-rp-files.b-cdn.net';
const LAUNCHER_CONFIG_URL = `${GAME_FILES_BASE_URL}/launcher-config.json`;
const GAME_FOLDER_NAME = 'Westland RP';
const NICKNAME_REGISTRY_KEY = 'HKCU\\Software\\Westland RP';
const NICKNAME_VALUE_NAME = 'Nickname';
const INSTALLATION_PATH_REGISTRY_KEY = 'HKCU\\Software\\Westland RP';
const INSTALLATION_PATH_VALUE_NAME = 'InstallationPath';
const LEGACY_REGISTRY_KEY = Buffer.from('SEBLQ1VcU29mdHdhcmVcS2FpZiBHYW1lcw==', 'base64').toString(); // миграция со старого лаунчера
const REGISTRY_DEBUG = process.env.LAUNCHER_REGISTRY_DEBUG === '1';

const NO_CACHE_HEADERS = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'User-Agent': 'Westland-Launcher/1.0'
};

function buildNoCacheUrl(url) {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}_=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fetchJsonNoCache(url) {
    return new Promise((resolve, reject) => {
        const requestUrl = new URL(buildNoCacheUrl(url));
        const client = requestUrl.protocol === 'https:' ? https : http;

        const req = client.get(requestUrl.toString(), {
            headers: NO_CACHE_HEADERS,
            timeout: 30000
        }, (response) => {
            if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
                return fetchJsonNoCache(response.headers.location).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode}`));
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`Invalid JSON: ${error.message}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

function normalizeNewsItems(news) {
    if (!Array.isArray(news)) return [];

    const seen = new Set();
    const items = [];

    for (const item of news) {
        if (!item || typeof item !== 'object') continue;

        const normalized = {
            title: String(item.title || '').trim(),
            description: String(item.description || '').trim(),
            image: String(item.image || '').trim(),
            url: String(item.url || '').trim()
        };

        if (!normalized.title && !normalized.description && !normalized.image) continue;

        const key = `${normalized.title}|${normalized.description}|${normalized.image}`;
        if (seen.has(key)) continue;

        seen.add(key);
        items.push(normalized);
    }

    return items;
}

let mainWindow

function createWindow() {
    if (require('os').release().startsWith('6.1') && !process.argv.includes('--force-win7')) {
        dialog.showErrorBox(
            'Требуется обновление',
            'Для работы лаунчера требуется Windows 10 или новее. ' +
            'Или запустите с параметром --force-win7 для попытки запуска на Windows 7.'
        );
        app.quit();
        return;
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    const windowWidth = Math.floor(screenWidth * 0.66667)
    const windowHeight = Math.floor(windowWidth * 0.5625)

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: Math.floor((screenWidth - windowWidth) / 2),
        y: Math.floor((screenHeight - windowHeight) / 2),
        frame: false,
        resizable: false,
        transparent: true,
        backgroundColor: '#00000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    })

    // mainWindow.webContents.once('did-finish-load', () => {
    //     mainWindow.webContents.openDevTools({ mode: 'detach' });
    // });

    checkFirstLaunch();

    mainWindow.webContents.session.clearCache().then(() => {
        console.log('Cache cleared')
    });

    mainWindow.loadFile('index.html')

    ipcMain.on('close-window', () => {
        mainWindow.close()
    })

    ipcMain.on('minimize-window', () => {
        if (mainWindow) {
            mainWindow.minimize();
        }
    })

    ipcMain.on('open-external', (event, url) => {
        shell.openExternal(url)
    })

    mainWindow.on('closed', () => {
        mainWindow = null
    })
}

// Improved fetchRemoteHashes function with error handling and retries
let cachedLauncherConfig = null;
let launcherConfigRequestId = 0;
let launcherConfigFetchPromise = null;

const DEFAULT_LAUNCHER_CONFIG = {
    server: { name: 'Westland 1', ip: '147.45.38.102', port: 7777, maxPlayers: 1000 },
    news: []
};

async function fetchLauncherConfigInternal() {
    const requestId = ++launcherConfigRequestId;

    try {
        const config = await fetchJsonNoCache(LAUNCHER_CONFIG_URL);
        if (requestId !== launcherConfigRequestId) {
            throw new Error('Stale launcher config response');
        }

        if (!config.server || !Array.isArray(config.news)) {
            throw new Error('Invalid launcher-config.json format');
        }

        cachedLauncherConfig = {
            ...config,
            server: normalizeServerConfig(config.server),
            news: normalizeNewsItems(config.news)
        };

        log.info(`Launcher config loaded: ${cachedLauncherConfig.server.ip}:${cachedLauncherConfig.server.port}, news: ${cachedLauncherConfig.news.length}`);
        return { success: true, config: cachedLauncherConfig };
    } catch (error) {
        if (requestId !== launcherConfigRequestId) {
            throw error;
        }

        log.warn('Failed to fetch launcher config:', error.message);
        const fallbackConfig = {
            ...DEFAULT_LAUNCHER_CONFIG,
            server: normalizeServerConfig(DEFAULT_LAUNCHER_CONFIG.server),
            news: []
        };
        return { success: false, config: fallbackConfig, error: error.message };
    }
}

async function fetchLauncherConfig() {
    if (!launcherConfigFetchPromise) {
        launcherConfigFetchPromise = fetchLauncherConfigInternal().finally(() => {
            launcherConfigFetchPromise = null;
        });
    }

    return launcherConfigFetchPromise;
}

function normalizeServerConfig(server) {
    const fallback = { ip: '147.45.38.102', port: '7777' };
    if (!server) return fallback;

    const ip = String(server.ip || '').trim();
    const port = String(server.port || fallback.port).trim();

    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        log.warn(`Invalid server IP in config: "${ip}", using default ${fallback.ip}`);
        return fallback;
    }

    return { ip, port };
}

function getServerFromConfig(serverOverride) {
    if (serverOverride?.ip) {
        return normalizeServerConfig(serverOverride);
    }

    if (cachedLauncherConfig?.server) {
        return normalizeServerConfig(cachedLauncherConfig.server);
    }

    return normalizeServerConfig(DEFAULT_LAUNCHER_CONFIG.server);
}

ipcMain.handle('get-launcher-config', async () => fetchLauncherConfig());

async function fetchRemoteHashes(retryCount = 3) {
    let attempts = 0;
    const url = `${GAME_FILES_BASE_URL}/client.json`;

    while (attempts < retryCount) {
        try {
            console.log(`Fetching remote file hashes (attempt ${attempts + 1}/${retryCount})...`);
            const jsonData = await fetchJsonNoCache(url);

            // Validate the response structure
            if (!jsonData.files || !Array.isArray(jsonData.files)) {
                throw new Error('Invalid game-files.json format');
            }

            const filesMap = {};
            for (const file of jsonData.files) {
                if (!file.name || !file.hash || file.size === undefined) {
                    // log.warn(`Skipping invalid file entry: ${JSON.stringify(file)}`);
                    continue;
                }

                const normalizedName = file.name.replace(/\\/g, '/');
                filesMap[normalizedName] = {
                    hash: file.hash,
                    size: file.size,
                    originalName: file.name
                };
            }

            // log.info(`Fetched information for ${Object.keys(filesMap).length} files`);
            return filesMap;

        } catch (error) {
            attempts++;
            // log.error(`Error fetching remote hashes (attempt ${attempts}/${retryCount}): ${error.message}`);

            if (attempts >= retryCount) {
                throw new Error(`Failed to fetch remote file hashes after ${retryCount} attempts: ${error.message}`);
            }

            // Wait before retry with exponential backoff
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempts)));
        }
    }
}

function normalizePath(relativePath) {
    return relativePath.replace(/\\/g, '/')
}

function buildGameFileDownloadUrl(normalizedName) {
    const encodedPath = normalizedName
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
    return `${GAME_FILES_BASE_URL}/Client/${encodedPath}`;
}

ipcMain.handle('show-directory-picker', async () => {
    try {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Выберите папку для установки'
        });
        return result;
    } catch (error) {
        console.error('Directory picker error:', error);
        return { canceled: true };
    }
});

async function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(filePath)

        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

ipcMain.handle('check-files', async () => {
    try {
        return await performFileCheck();
    } catch (error) {
        log.error('Error during file check:', error);
        return {
            error: error.message,
            results: [],
            totalFiles: 0,
            totalDownloadSize: 0,
            cleanedFiles: 0
        };
    }
});

async function checkFileSizeAndHash(filePath, expectedSize, expectedHash) {
    try {
        const installPath = getInstallationPath();
        const normalizedName = normalizePath(filePath);
        const fullPath = path.join(installPath, GAME_FOLDER_NAME, normalizedName);

        if (!fs.existsSync(fullPath)) {
            return { status: 'missing', actualSize: 0, actualHash: '' };
        }

        const stats = fs.statSync(fullPath);
        const actualSize = stats.size;

        console.log(`[checkFile] ${normalizedName}: expected=${expectedSize}, actual=${actualSize}`);

        // Если размер не указан и нет хеша — файл считается валидным, если существует
        if (expectedSize === 0 && !expectedHash) {
            return { status: 'valid', actualSize, actualHash: '' };
        }

        // Если размер отличается (больше или меньше)
        if (expectedSize > 0 && actualSize !== expectedSize) {
            console.log(`[checkFile] Size mismatch!`);

            const actualHash = expectedHash && actualSize < 70 * 1024 * 1024
                ? await calculateFileHash(fullPath)
                : '';

            // Удаляем файл
            try {
                fs.unlinkSync(fullPath);
                console.log(`[checkFile] File deleted due to size mismatch.`);
            } catch (deleteErr) {
                console.error(`[checkFile] Failed to delete file:`, deleteErr);
            }

            return {
                status: 'invalid-size',
                actualSize,
                actualHash,
                expectedHash: expectedHash?.toLowerCase() || ''
            };
        }

        // Проверяем хеш если указан и размер < 70 МБ (изменено с 60 МБ)
        if (expectedHash && actualSize < 70 * 1024 * 1024) {
            const actualHash = await calculateFileHash(fullPath);
            if (actualHash !== expectedHash.toLowerCase()) {
                console.log(`[checkFile] Hash mismatch!`);
                return {
                    status: 'invalid-hash',
                    actualSize,
                    actualHash,
                    expectedHash: expectedHash.toLowerCase()
                };
            }
            return { status: 'valid', actualSize, actualHash };
        }

        return { status: 'valid', actualSize, actualHash: '' };
    } catch (error) {
        console.error(`Error checking file ${filePath}:`, error);
        return { status: 'error', actualSize: 0, actualHash: '' };
    }
}



// Вспомогательная функция для рекурсивного получения всех файлов в папке
function getAllFilesInFolder(dir) {
    let results = [];
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            results = results.concat(getAllFilesInFolder(fullPath));
        } else {
            results.push(fullPath);
        }
    }

    return results;
}

// Функция для очистки лишних файлов, которых нет в client.json
async function cleanGameFolders(silent = false) {
    try {
        const installPath = getInstallationPath();
        const gamePath = path.join(installPath, GAME_FOLDER_NAME);

        if (!fs.existsSync(gamePath)) {
            !silent && console.log('Game directory not found, nothing to clean');
            return { success: true, cleanedFiles: 0 };
        }

        const remoteFiles = await fetchRemoteHashes();
        const allowedFiles = new Set(Object.keys(remoteFiles).map(normalizePath));

        const protectedItems = [
            'gta_sa.exe',
            'mods/'
        ].map(normalizePath);

        const isProtected = (normalizedPath) => protectedItems.some(protectedPath =>
            normalizedPath === protectedPath ||
            (protectedPath.endsWith('/') && normalizedPath.startsWith(protectedPath))
        );

        let cleanedFiles = 0;
        const allFiles = getAllFilesInFolder(gamePath);

        for (const file of allFiles) {
            const relativePath = path.relative(gamePath, file);
            const normalizedPath = normalizePath(relativePath);

            if (isProtected(normalizedPath)) continue;
            if (allowedFiles.has(normalizedPath)) continue;

            try {
                fs.unlinkSync(file);
                !silent && console.log(`Removed file: ${normalizedPath}`);
                cleanedFiles++;
            } catch (err) {
                !silent && console.error(`Failed to remove ${normalizedPath}:`, err);
            }
        }

        const removeEmptyExtraDirs = (dir) => {
            if (!fs.existsSync(dir)) return;

            for (const entry of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    removeEmptyExtraDirs(fullPath);
                }
            }

            if (dir === gamePath) return;

            const relativePath = normalizePath(path.relative(gamePath, dir));
            if (isProtected(relativePath) || isProtected(`${relativePath}/`)) return;

            if (fs.readdirSync(dir).length === 0) {
                try {
                    fs.rmdirSync(dir);
                    !silent && console.log(`Removed empty directory: ${relativePath}`);
                    cleanedFiles++;
                } catch (err) {
                    !silent && console.error(`Failed to remove directory ${relativePath}:`, err);
                }
            }
        };

        removeEmptyExtraDirs(gamePath);

        !silent && console.log(`Cleaning complete. Removed ${cleanedFiles} items.`);
        return { success: true, cleanedFiles };
    } catch (error) {
        console.error('Error cleaning game folders:', error);
        return { success: false, error: error.message, cleanedFiles: 0 };
    }
}

async function performFileCheck() {
    const installPath = getInstallationPath();
    if (!installPath) {
        log.warn('No installation path set during file check');
        return { error: 'NO_INSTALLATION_PATH' };
    }

    await ensureModsInstalled();
    const remoteFiles = await fetchRemoteHashes();

    const cleanResult = await cleanGameFolders(true);
    log.info(`Cleaned ${cleanResult.cleanedFiles} extra files before check`);

    const totalFiles = Object.keys(remoteFiles).length;
    let checkedFiles = 0;
    let totalDownloadSize = 0;
    let results = [];

    let missingFiles = [];
    let invalidSizeFiles = [];
    let invalidHashFiles = [];

    const batchSize = 50;
    const fileEntries = Object.entries(remoteFiles);

    for (let i = 0; i < fileEntries.length; i += batchSize) {
        const batch = fileEntries.slice(i, i + batchSize);

        const batchPromises = batch.map(async ([normalizedName, fileData]) => {
            const sizeCheck = await checkFileSizeAndHash(normalizedName, fileData.size, fileData.hash);
            let status = sizeCheck.status;
            let actualHash = '';

            if (sizeCheck.status === 'invalid-size') {
                status = 'invalid-size';
                actualHash = sizeCheck.actualHash;
            }

            checkedFiles++;

            if (status !== 'valid') {
                totalDownloadSize += fileData.size;

                if (status === 'missing') {
                    missingFiles.push({
                        path: fileData.originalName,
                        size: fileData.size
                    });
                } else if (status === 'invalid-size') {
                    invalidSizeFiles.push({
                        path: fileData.originalName,
                        expectedSize: fileData.size,
                        actualSize: sizeCheck.actualSize
                    });
                } else if (status === 'invalid-hash') {
                    invalidHashFiles.push({
                        path: fileData.originalName,
                        expectedHash: fileData.hash,
                        actualHash: sizeCheck.actualHash
                    });
                }
            }

            return {
                path: fileData.originalName,
                normalizedPath: normalizedName,
                status,
                size: fileData.size,
                hash: fileData.hash,
                actualSize: sizeCheck.actualSize,
                actualHash
            };
        });

        const batchResults = await Promise.all(batchPromises);
        results = results.concat(batchResults);

        mainWindow?.webContents.send('check-files-progress', {
            checked: checkedFiles,
            total: totalFiles,
            percent: Math.round((checkedFiles / totalFiles) * 100)
        });

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    log.info('=== FILE CHECK RESULTS ===');
    log.info(`Total files checked: ${totalFiles}`);
    log.info(`Missing files: ${missingFiles.length}`);
    log.info(`Invalid size files: ${invalidSizeFiles.length}`);
    log.info(`Invalid hash files: ${invalidHashFiles.length}`);
    log.info(`Total download size needed: ${formatSize(totalDownloadSize)}`);
    log.info('==========================');

    mainWindow?.webContents.send('check-files-progress', {
        checked: totalFiles,
        total: totalFiles,
        percent: 100
    });

    return {
        results,
        totalFiles,
        totalDownloadSize,
        cleanedFiles: cleanResult.cleanedFiles || 0
    };
}

async function ensureModsInstalled() {
    try {
        // First load active mods configuration from registry
        activeMods = loadActiveMods();

        // Check if graphics mod is active but files are missing
        if (activeMods.graphics) {
            const installPath = getInstallationPath();
            const gamePath = path.join(installPath, GAME_FOLDER_NAME);
            const modPath = path.join(gamePath, 'mods', activeMods.graphics);

            if (fs.existsSync(modPath)) {
                // Check for at least one mod file that should be in game root
                const modFiles = fs.readdirSync(modPath);
                let needsRepair = false;

                for (const file of modFiles) {
                    const sourcePath = path.join(modPath, file);
                    const destPath = path.join(gamePath, file);

                    // If a mod file is missing in the game root, we need to repair
                    if (!fs.existsSync(destPath) && !fs.statSync(sourcePath).isDirectory()) {
                        needsRepair = true;
                        break;
                    }
                }

                if (needsRepair) {
                    console.log(`Mod files missing, reinstalling ${activeMods.graphics} mod`);
                    await installMod('graphics', activeMods.graphics);
                }
            } else {
                // Mod folder doesn't exist, disable the mod
                console.log(`Mod folder ${modPath} doesn't exist, disabling mod`);
                activeMods.graphics = null;
                saveActiveMods();
            }
        }

        // Check if widescreen fix is active but files are missing
        if (activeMods.widescreen) {
            const installPath = getInstallationPath();
            const gamePath = path.join(installPath, GAME_FOLDER_NAME);
            const modPath = path.join(gamePath, 'mods', 'widescreenfix');

            if (fs.existsSync(modPath)) {
                // Check for widescreen asi in game root
                const widescreenFile = path.join(gamePath, 'widescreen.asi');

                if (!fs.existsSync(widescreenFile)) {
                    console.log('Widescreen fix files missing, reinstalling');
                    await installMod('widescreen', 'widescreenfix');
                }
            } else {
                // Mod folder doesn't exist, disable the mod
                console.log(`Widescreen fix folder doesn't exist, disabling mod`);
                activeMods.widescreen = false;
                saveActiveMods();
            }
        }

        return true;
    } catch (error) {
        console.error('Error ensuring mods are installed:', error);
        return false;
    }
}

async function downloadFileWithRetry(url, relativePath, expectedHash, onProgress, maxRetries = 5) {
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
        try {
            await downloadFileWithProgress(url, relativePath, expectedHash, onProgress);
            return;
        } catch (error) {
            retryCount++;
            lastError = error;
            console.error(`Download failed (attempt ${retryCount}/${maxRetries}): ${error.message}`);
            console.error(`URL: ${url}`);
            console.error(`Path: ${relativePath}`);
            console.error(`Error details:`, error);

            // Different handling based on error type
            if (error.code === 'ECONNRESET' || error.message.includes('timeout')) {
                await new Promise(resolve => setTimeout(resolve, 5000 * Math.pow(2, retryCount)));
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
            }
        }
    }
    throw new Error(`Failed after ${maxRetries} attempts: ${lastError?.message}`);
}

async function downloadFileWithProgress(url, relativePath, expectedHash, onProgress) {
    return new Promise((resolve, reject) => {
        console.log(`Starting download: ${url}`);
        const installPath = getInstallationPath();
        const filePath = path.join(installPath, GAME_FOLDER_NAME, normalizePath(relativePath));
        const dirPath = path.dirname(filePath);

        // Create directories if they don't exist
        fs.mkdirSync(dirPath, { recursive: true });

        const fileStream = fs.createWriteStream(filePath);
        let receivedBytes = 0;
        let contentLength = 0;
        let lastProgressUpdate = 0;
        let downloadSpeed = 0;
        let lastBytes = 0;
        let lastTime = Date.now();

        const request = (url.startsWith('https:') ? https : http).get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Westland-Launcher/1.0',
                'Connection': 'keep-alive'
            }
        }, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode}`));
            }

            // Get content length from headers or use 0 if not provided
            contentLength = parseInt(response.headers['content-length'], 10) || 0;

            response.on('data', (chunk) => {
                receivedBytes += chunk.length;

                // Calculate download speed
                const now = Date.now();
                const timeDiff = (now - lastTime) / 1000; // in seconds
                if (timeDiff > 0) {
                    const byteDiff = receivedBytes - lastBytes;
                    downloadSpeed = byteDiff / timeDiff; // bytes per second
                    lastBytes = receivedBytes;
                    lastTime = now;
                }

                // Throttle progress updates to max 5 per second
                if (now - lastProgressUpdate >= 200) {
                    // Calculate percent based on actual received bytes if contentLength is 0
                    const percent = contentLength > 0
                        ? (receivedBytes / contentLength * 100)
                        : (receivedBytes / (receivedBytes + 1024) * 100); // Estimate if unknown size

                    onProgress?.({
                        receivedBytes,
                        contentLength: contentLength || receivedBytes + 1024, // Estimate total if unknown
                        percent: parseFloat(percent.toFixed(1)),
                        speed: downloadSpeed
                    });
                    lastProgressUpdate = now;
                }
            });

            response.pipe(fileStream);
        });

        request.on('error', reject);

        fileStream.on('finish', async () => {
            try {
                // Verify file size against actual file stats, not content-length
                const stats = fs.statSync(filePath);

                // Only verify against expected size if it was provided (contentLength > 0)
                if (contentLength > 0 && stats.size !== contentLength) {
                    throw new Error(`Size mismatch: expected ${contentLength}, got ${stats.size}`);
                }

                if (expectedHash) {
                    const actualHash = await calculateFileHash(filePath);
                    if (actualHash !== expectedHash) {
                        throw new Error(`Hash mismatch: expected ${expectedHash}, got ${actualHash}`);
                    }
                }
                resolve();
            } catch (err) {
                // Delete corrupted file
                fs.unlinkSync(filePath);
                reject(err);
            }
        });

        fileStream.on('error', reject);
    });
}

ipcMain.handle('download-files', async (event, { files }) => {
    // Filter only files that need to be downloaded
    const filesToDownload = files.filter(file =>
        file.status === 'missing' ||
        file.status === 'invalid-size' ||
        file.status === 'invalid-hash'
    );

    const totalFiles = filesToDownload.length;
    let downloadedFiles = 0;
    let failedFiles = 0;
    let totalBytes = filesToDownload.reduce((sum, file) => sum + file.size, 0);
    let totalDownloadedBytes = 0;
    let startTime = Date.now();
    let lastProgressUpdate = Date.now();

    const sender = event.sender || mainWindow?.webContents;

    console.log(`Starting download of ${totalFiles} files, total size: ${totalBytes} bytes`);

    // Send initial progress
    sender.send('download-progress', {
        totalFiles,
        downloadedFiles,
        failedFiles,
        totalBytes,
        downloadedBytes: 0,
        percent: 0,
        speed: 0
    });

    for (let i = 0; i < filesToDownload.length; i++) {
        const file = filesToDownload[i];
        const normalizedName = normalizePath(file.path);
        const fileUrl = buildGameFileDownloadUrl(normalizedName);

        try {
            // Track this specific file's download
            let fileDownloadedBytes = 0;

            await downloadFileWithRetry(
                fileUrl,
                file.path,
                file.hash,
                (progress) => {
                    // Update how much of the current file has been downloaded
                    fileDownloadedBytes = progress.receivedBytes;

                    // Calculate overall progress
                    const currentOverallBytes = totalDownloadedBytes + fileDownloadedBytes;
                    const currentPercent = totalBytes > 0
                        ? Math.min(100, (currentOverallBytes / totalBytes) * 100)
                        : 100;

                    // Calculate download speed based on overall progress
                    const now = Date.now();
                    const elapsed = (now - startTime) / 1000; // in seconds
                    const overallSpeed = elapsed > 0 ? currentOverallBytes / elapsed : 0;

                    // Throttle progress updates to not overwhelm the renderer (max 5 updates per second)
                    if (now - lastProgressUpdate >= 200) {
                        lastProgressUpdate = now;

                        // Send detailed progress update including overall stats
                        sender.send('download-progress', {
                            totalFiles,
                            downloadedFiles,
                            failedFiles,
                            totalBytes,
                            downloadedBytes: currentOverallBytes,
                            percent: currentPercent,
                            currentFile: i + 1,
                            currentFileName: file.path,
                            speed: overallSpeed,
                            fileProgress: progress.percent // Individual file progress
                        });
                    }
                }
            );

            // Add completed file size to total downloaded
            totalDownloadedBytes += file.size;
            downloadedFiles++;

            // Send progress update after file completes
            sender.send('download-progress', {
                totalFiles,
                downloadedFiles,
                failedFiles,
                totalBytes,
                downloadedBytes: totalDownloadedBytes,
                percent: totalBytes > 0
                    ? Math.min(100, (totalDownloadedBytes / totalBytes) * 100)
                    : 100,
                currentFile: i + 1,
                currentFileName: file.path,
                remainingFiles: totalFiles - downloadedFiles - failedFiles,
                speed: totalDownloadedBytes / ((Date.now() - startTime) / 1000)
            });
        } catch (error) {
            failedFiles++;
            sender.send('download-file-failed', {
                path: file.path,
                error: error.message
            });
        }
    }

    // Final progress update showing 100% completion
    sender.send('download-progress', {
        totalFiles,
        downloadedFiles,
        failedFiles,
        totalBytes,
        downloadedBytes: totalBytes,
        percent: 100,
        speed: totalBytes / ((Date.now() - startTime) / 1000)
    });

    return {
        success: failedFiles === 0,
        stats: {
            totalFiles,
            downloadedFiles,
            failedFiles
        }
    };
});

// Helper function to format file sizes for display
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

async function getRegistryValue(key, valueName) {
    return new Promise((resolve, reject) => {
        // Add safety check for registry module
        if (!regedit) {
            console.warn('Regedit module not available, returning empty value');
            return resolve('');
        }

        // Check if key exists, create if it doesn't
        regedit.list(key, (err, result) => {
            if (err) {
                // log.error('Error listing registry key:', err);
                // Try to create the key if it doesn't exist
                regedit.createKey(key, (createErr) => {
                    if (createErr) {
                        // log.error('Failed to create registry key:', createErr);
                        return reject(createErr);
                    }
                    return resolve('');
                });
                return;
            }

            const value = result[key]?.values?.[valueName]?.value;
            if (REGISTRY_DEBUG) {
                console.log(`Registry value read - Key: ${key}, Name: ${valueName}, Value: "${value}"`);
            }
            resolve(value || '');
        });
    });
}

// Now replace the API functions to use these direct methods
ipcMain.handle('get-nickname', async () => {
    try {
        const nickname = directRegistryRead(NICKNAME_REGISTRY_KEY, NICKNAME_VALUE_NAME);
        return { nickname: nickname || '' };
    } catch (error) {
        return { nickname: '' };
    }
});

ipcMain.handle('save-nickname', async (event, nickname) => {
    try {
        console.log(`Save nickname called with: "${nickname}"`);
        if (!nickname) {
            console.warn('Attempted to save empty nickname, skipping');
            return { success: false, error: 'Empty nickname' };
        }

        const success = directRegistryWrite(NICKNAME_REGISTRY_KEY, NICKNAME_VALUE_NAME, nickname);
        return { success };
    } catch (error) {
        // log.error(`Error saving nickname "${nickname}":`, error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('init-registry', async () => {
    try {
        directRegistryCreateKey(NICKNAME_REGISTRY_KEY);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

let isStarting = false; // флаг защиты от двойного запуска

function activateGameWindow(processNames, processId = null) {
    if (process.platform !== 'win32') return;

    const namesList = processNames.map((name) => `'${name}'`).join(',');
    const pidInit = processId ? `$targetPid = ${processId}` : '$targetPid = $null';

    const psCommand = `
${pidInit}
$names = @(${namesList})
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class GameFocus {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    public static bool Activate(Process p) {
        if (p == null) return false;
        var h = p.MainWindowHandle;
        if (h == IntPtr.Zero) return false;
        AllowSetForegroundWindow(p.Id);
        ShowWindow(h, 9);
        SwitchToThisWindow(h, true);
        SetForegroundWindow(h);
        return true;
    }
}
'@
$activated = $false
if ($targetPid) {
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($p) { $activated = [GameFocus]::Activate($p) }
}
if (-not $activated) {
    foreach ($name in $names) {
        $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and [GameFocus]::Activate($p)) { break }
    }
}
`;

    execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
        { windowsHide: true },
        () => {}
    );
}

function isGameProcessRunning() {
    return new Promise((resolve) => {
        const command = process.platform === 'win32'
            ? 'tasklist /FI "IMAGENAME eq gta_sa.exe" /NH'
            : 'ps aux | grep gta_sa.exe | grep -v grep';

        exec(command, (error, stdout) => {
            if (error) {
                resolve(false);
                return;
            }

            resolve(stdout.toLowerCase().includes('gta_sa.exe'));
        });
    });
}

function waitForGameProcess(timeoutMs = 12000, intervalMs = 500) {
    const startedAt = Date.now();

    return new Promise((resolve) => {
        const check = async () => {
            if (await isGameProcessRunning()) {
                resolve(true);
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                resolve(false);
                return;
            }

            setTimeout(check, intervalMs);
        };

        check();
    });
}

function launchCoreExe(gamePath, args) {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            const cmdArgs = [
                '/c',
                'start',
                '""',
                '/D',
                gamePath,
                'core.exe',
                ...args
            ];

            const child = spawn('cmd.exe', cmdArgs, {
                windowsHide: true,
                detached: true,
                stdio: 'ignore'
            });

            child.on('error', reject);
            child.on('exit', (code) => resolve({ method: 'cmd-start', code }));
            child.unref();
            return;
        }

        const corePath = path.join(gamePath, 'core.exe');
        const child = spawn(corePath, args, {
            cwd: gamePath,
            windowsHide: true,
            stdio: 'ignore'
        });

        child.on('error', reject);
        child.on('exit', (code) => resolve({ method: 'spawn', code, pid: child.pid }));
    });
}

function scheduleGameWindowFocus(processId) {
    const delays = [1000, 2000, 4000, 6000, 10000, 15000, 20000];
    delays.forEach((delay) => {
        setTimeout(() => activateGameWindow(['gta_sa', 'core'], processId), delay);
    });
}

ipcMain.handle('start-game', async (event, nickname, serverOverride) => {
    try {
        if (isStarting)
            return { success: false, error: 'Игра уже запускается, попробуйте чуть позже' };

        isStarting = true;
        setTimeout(() => { isStarting = false; }, 2000);

        const validation = await validateNickname(nickname);
        if (!validation.valid)
            return { success: false, error: validation.message };

        const gamePath = resolveGameDirectory();
        const corePath = path.join(gamePath, 'core.exe');

        await fetchLauncherConfig();
        const server = getServerFromConfig(serverOverride);

        const useInjector = isSampInjectorAvailable();
        if (!useInjector && !fs.existsSync(corePath)) {
            isStarting = false;
            return {
                success: false,
                error: 'Не найден samp-injector.exe в лаунчере и core.exe в папке игры'
            };
        }

        let launchMethod = 'core.exe';
        const coreArgs = [
            '-c',
            '-n', nickname,
            '-h', server.ip,
            '-p', server.port
        ];

        if (useInjector) {
            console.log('Запуск через samp-injector.exe, папка игры:', gamePath, 'сервер', `${server.ip}:${server.port}`);

            try {
                const injectorResult = await launchViaSampInjector(
                    gamePath,
                    nickname,
                    server.ip,
                    server.port
                );

                if (!injectorResult.success) {
                    console.warn('samp-injector.exe:', injectorResult.error);
                } else {
                    launchMethod = injectorResult.method;
                }
            } catch (error) {
                console.warn('samp-injector.exe failed:', error.message);
            }
        }

        scheduleGameWindowFocus(null);

        let gameStarted = useInjector
            ? await waitForGameProcess(15000)
            : false;

        if (!gameStarted && fs.existsSync(corePath)) {
            console.log('Запуск через core.exe', coreArgs);
            await launchCoreExe(gamePath, coreArgs);
            launchMethod = 'core.exe';
            scheduleGameWindowFocus(null);
            gameStarted = await waitForGameProcess(20000);
        }

        if (!gameStarted) {
            console.error(`gta_sa.exe не запустился (${launchMethod}, ${server.ip}:${server.port})`);
            return {
                success: false,
                error: 'Игра не запустилась. Проверьте файлы игры или запустите вручную из папки игры.'
            };
        }

        return { success: true };

    } catch (error) {
        isStarting = false;
        return { success: false, error: `Не удалось запустить игру: ${error.message}` };
    }
});

ipcMain.handle('validate-nickname', async (event, nickname) => {
    try {
        // Basic validation - empty check
        if (!nickname || nickname.trim().length === 0) {
            return { valid: false, message: 'Никнейм не может быть пустым' };
        }

        // Length check
        if (nickname.length > 28) {
            return { valid: false, message: 'Никнейм не должен превышать 28 символов' };
        }

        return { valid: true };
    } catch (error) {
        // log.error('Error validating nickname:', error);
        return { valid: false, message: error.message };
    }
});

async function validateNickname(nickname) {
    if (!nickname || nickname.trim().length === 0) {
        return { valid: false, message: 'Пожалуйста, введите ваш ник' };
    }

    if (nickname.length > 28) {
        return { valid: false, message: 'Ник не должен превышать 28 символов' };
    }

    return { valid: true };
}

// Add this at the top of your main.js
const vbsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'vbs')
    : path.join(__dirname, 'node_modules/regedit/vbs');

// Then before any regedit operations
regedit.setExternalVBSLocation(vbsDir);

// Add this function to check if this is the first launch
// Modified checkFirstLaunch function to not set path automatically
async function checkFirstLaunch() {
    try {
        const installPath = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);
        return !installPath; // Просто возвращаем статус первого запуска
    } catch (error) {
        return true;
    }
}

function normalizeInstallBasePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') {
        return '';
    }

    let normalized = path.normalize(rawPath.replace(/["']/g, ''));

    // Корень диска: D: или D:\ — всегда D:\
    if (/^[A-Za-z]:\\?$/.test(normalized)) {
        return normalized.slice(0, 2) + '\\';
    }

    return normalized.replace(/\\+$/, '');
}

function stripGameFolderFromInstallPath(basePath) {
    if (!basePath) return '';
    const baseName = path.basename(basePath);
    if (baseName.toLowerCase() === GAME_FOLDER_NAME.toLowerCase()) {
        return path.dirname(basePath);
    }
    return basePath;
}

function getGameDirectoryPath(basePath) {
    if (!basePath) return '';
    return path.join(basePath, GAME_FOLDER_NAME);
}

function resolveGameDirectory() {
    const basePath = getInstallationPath();
    if (!basePath) return '';

    const nestedPath = getGameDirectoryPath(basePath);
    if (fs.existsSync(path.join(nestedPath, 'core.exe')) ||
        fs.existsSync(path.join(nestedPath, 'gta_sa.exe'))) {
        return nestedPath;
    }

    // Путь в реестре уже указывает на папку игры (D:\Westland RP)
    if (fs.existsSync(path.join(basePath, 'core.exe')) ||
        fs.existsSync(path.join(basePath, 'gta_sa.exe'))) {
        return basePath;
    }

    return nestedPath;
}

function ensureGameDirectory(basePath) {
    const gamePath = getGameDirectoryPath(basePath);
    if (!gamePath) return '';
    fs.mkdirSync(gamePath, { recursive: true });
    return gamePath;
}

function parseRegQueryValue(stdout, valueName) {
    if (!stdout) return '';

    const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (!line.includes(valueName)) continue;

        const regMatch = line.match(/REG_SZ\s+(.+)$/i);
        if (regMatch) {
            return regMatch[1].trim();
        }

        const parts = line.split(/\s{2,}/);
        if (parts.length >= 3) {
            return parts.slice(2).join(' ').trim();
        }
    }

    return '';
}

let cachedInstallationPath = null;

function getInstallationPath() {
    if (cachedInstallationPath) return cachedInstallationPath;

    try {
        let installPath = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);

        if (!installPath || typeof installPath !== 'string' || installPath.trim() === '') {
            return '';
        }

        installPath = normalizeInstallBasePath(installPath);
        installPath = stripGameFolderFromInstallPath(installPath);

        if (!installPath || installPath === '.' || !fs.existsSync(installPath)) {
            return '';
        }

        cachedInstallationPath = installPath;
        return installPath;
    } catch (error) {
        return '';
    }
}

// Function to set installation path - only time we write to registry after startup
// В функции setInstallationPath
function setInstallationPath(newPath) {
    try {
        const normalizedPath = normalizeInstallBasePath(newPath);
        const basePath = stripGameFolderFromInstallPath(normalizedPath);

        if (!basePath || !fs.existsSync(basePath)) {
            throw new Error('Указанная директория не существует');
        }

        const testFile = path.join(basePath, 'write_test.tmp');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);

        ensureGameDirectory(basePath);

        directRegistryWrite(
            INSTALLATION_PATH_REGISTRY_KEY,
            INSTALLATION_PATH_VALUE_NAME,
            basePath
        );

        cachedInstallationPath = basePath;
        cachedRegistryValues[`${INSTALLATION_PATH_REGISTRY_KEY}\\${INSTALLATION_PATH_VALUE_NAME}`] = basePath;
        return true;
    } catch (error) {
        throw error;
    }
}

// Expose these functions to the renderer process
ipcMain.handle('get-installation-path', async () => {
    try {
        const installPath = getInstallationPath();
        const gamePath = installPath ? getGameDirectoryPath(installPath) : '';

        return {
            success: true,
            path: installPath,
            gamePath,
            displayPath: gamePath || installPath,
            exists: installPath && fs.existsSync(installPath)
        };
    } catch (error) {
        console.error('[IPC] Error handling get-installation-path:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('is-first-launch', async () => {
    try {
        const installPath = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);
        return !installPath;
    } catch (error) {
        return true;
    }
});

ipcMain.handle('set-installation-path', async (event, newPath) => {
    try {
        if (!newPath || typeof newPath !== 'string') {
            return { success: false, error: 'Invalid path provided' };
        }

        // Check if the path exists
        if (!fs.existsSync(newPath)) {
            return { success: false, error: 'The specified path does not exist' };
        }

        const success = setInstallationPath(newPath);
        return { success };
    } catch (error) {
        // log.error('[IPC] Error handling set-installation-path:', error);
        return { success: false, error: error.message };
    }
});

// Добавим новый IPC-хендлер для валидации пути:
ipcMain.handle('validate-installation-path', async (event, pathToValidate) => {
    try {
        if (!pathToValidate || typeof pathToValidate !== 'string') {
            return { valid: false, error: 'Путь не указан' };
        }

        const normalizedPath = normalizeInstallBasePath(pathToValidate);

        if (!normalizedPath || !fs.existsSync(normalizedPath)) {
            return { valid: false, error: 'Директория не существует' };
        }

        // Проверяем возможность записи
        try {
            const testFile = path.join(normalizedPath, 'test.tmp');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
        } catch (error) {
            return { valid: false, error: 'Нет прав на запись в директорию' };
        }

        return { valid: true };
    } catch (error) {
        return { valid: false, error: error.message };
    }
});

// Add this at the top of your main process
let cachedRegistryValues = {};

// Optimized registry access
async function getRegistryValueCached(key, valueName) {
    const cacheKey = `${key}\\${valueName}`;
    if (cachedRegistryValues[cacheKey] !== undefined) {
        return cachedRegistryValues[cacheKey];
    }

    const value = await getRegistryValue(key, valueName);
    cachedRegistryValues[cacheKey] = value;
    return value;
}

// Modify your initialization to use caching
app.on('ready', async () => {
    try {
        await Promise.all([
            directRegistryCreateKey(NICKNAME_REGISTRY_KEY),
            directRegistryCreateKey(INSTALLATION_PATH_REGISTRY_KEY)
        ]);

        migrateLegacyRegistryIfNeeded();

        const nickname = directRegistryRead(NICKNAME_REGISTRY_KEY, NICKNAME_VALUE_NAME);
        const installPath = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);

        if (REGISTRY_DEBUG) {
            console.log('[Registry] Startup — nickname:', nickname || '(empty)', ', path:', installPath || '(empty)');
        }

        cachedInstallationPath = installPath
            ? stripGameFolderFromInstallPath(normalizeInstallBasePath(installPath))
            : null;

        createWindow();
    } catch (error) {
        console.error('Initialization error:', error);
        createWindow();
    }
});

function runRegCommand(command) {
    return execSync(command, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
    });
}

function migrateLegacyRegistryIfNeeded() {
    const currentPath = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);
    if (!currentPath) {
        const legacyPath = directRegistryRead(LEGACY_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME);
        if (legacyPath) {
            const normalizedLegacy = normalizeInstallBasePath(legacyPath);
            directRegistryWrite(INSTALLATION_PATH_REGISTRY_KEY, INSTALLATION_PATH_VALUE_NAME, normalizedLegacy);
            cachedInstallationPath = normalizedLegacy;
            if (REGISTRY_DEBUG) {
                console.log('[Registry] Migrated installation path from legacy launcher');
            }
        }
    }

    const currentNickname = directRegistryRead(NICKNAME_REGISTRY_KEY, NICKNAME_VALUE_NAME);
    if (!currentNickname) {
        const legacyNickname = directRegistryRead(LEGACY_REGISTRY_KEY, NICKNAME_VALUE_NAME);
        if (legacyNickname) {
            directRegistryWrite(NICKNAME_REGISTRY_KEY, NICKNAME_VALUE_NAME, legacyNickname);
            if (REGISTRY_DEBUG) {
                console.log('[Registry] Migrated nickname from legacy launcher');
            }
        }
    }
}

// Replace existing registry functions with these direct command-line approaches
function directRegistryRead(key, valueName) {
    try {
        if (process.platform !== 'win32') {
            return '';
        }

        const cacheKey = `${key}\\${valueName}`;
        if (cachedRegistryValues[cacheKey] !== undefined) {
            return cachedRegistryValues[cacheKey];
        }

        const command = `REG QUERY "${key}" /v ${valueName}`;

        try {
            const stdout = runRegCommand(command);

            if (stdout) {
                const value = parseRegQueryValue(stdout, valueName);
                if (value) {
                    cachedRegistryValues[cacheKey] = value;
                    return value;
                }
            }

            cachedRegistryValues[cacheKey] = '';
            return '';
        } catch (error) {
            // Value or key missing — normal on first launch
            cachedRegistryValues[cacheKey] = '';
            return '';
        }
    } catch (error) {
        return '';
    }
}

// Add this function for direct registry access
function directRegistryAccess(action, key, valueName, value = '') {
    try {
        if (process.platform !== 'win32') return false;

        if (action === 'read') {
            const command = `REG QUERY "${key}" /v ${valueName}`;
            try {
                const stdout = runRegCommand(command);
                if (stdout) {
                    const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
                    for (const line of lines) {
                        if (line.includes(valueName)) {
                            const parts = line.split(/\s{2,}/);
                            if (parts.length >= 3) {
                                return parts[2];
                            }
                        }
                    }
                }
                return '';
            } catch (error) {
                return '';
            }
        } else if (action === 'write') {
            // Ensure key exists first
            execSync(`REG ADD "${key}" /f`, { encoding: 'utf8', windowsHide: true });

            // Write value
            const escapedValue = value.replace(/"/g, '\\"');
            const command = `REG ADD "${key}" /v ${valueName} /t REG_SZ /d "${escapedValue}" /f`;
            execSync(command, { encoding: 'utf8', windowsHide: true });
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Registry ${action} error:`, error.message);
        return false;
    }
}

function directRegistryWrite(key, valueName, value) {
    try {
        if (process.platform !== 'win32') {
            return true;
        }

        directRegistryCreateKey(key);

        const escapedValue = value
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"');

        try {
            const currentValue = directRegistryRead(key, valueName);
            if (currentValue === value) {
                return true;
            }
        } catch (error) {
            // Proceed with write
        }

        const command = `REG ADD "${key}" /v ${valueName} /t REG_SZ /d "${escapedValue}" /f`;
        runRegCommand(command);

        cachedRegistryValues[`${key}\\${valueName}`] = value;
        if (valueName === INSTALLATION_PATH_VALUE_NAME) {
            cachedInstallationPath = value.replace(/["']/g, '');
        }

        return true;
    } catch (error) {
        throw new Error(`Ошибка записи в реестр: ${error.message}`);
    }
}

function directRegistryCreateKey(key) {
    try {
        if (process.platform !== 'win32') {
            return true;
        }

        try {
            runRegCommand(`REG QUERY "${key}"`);
            return true;
        } catch (error) {
            runRegCommand(`REG ADD "${key}" /f`);
            return true;
        }
    } catch (error) {
        return false;
    }
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
    if (mainWindow === null) createWindow()
})

// Track active mods
let activeMods = {
    graphics: null, // 'high', 'low', or null
    widescreen: false
};

// Save active mods to registry
function saveActiveMods() {
    try {
        if (activeMods.graphics) {
            directRegistryWrite(INSTALLATION_PATH_REGISTRY_KEY, 'ActiveGraphicsMod', activeMods.graphics);
        } else {
            // If no graphics mod is active, remove the registry entry
            // This would require a new function to delete registry values
            // For now we just set it to empty
            directRegistryWrite(INSTALLATION_PATH_REGISTRY_KEY, 'ActiveGraphicsMod', '');
        }

        directRegistryWrite(INSTALLATION_PATH_REGISTRY_KEY, 'WidescreenFix', activeMods.widescreen ? 'true' : 'false');

        console.log('Saved active mods configuration:', activeMods);
        return true;
    } catch (error) {
        console.error('Error saving active mods:', error);
        return false;
    }
}

// Новая функция для рекурсивного копирования
function copyRecursiveSync(src, dest) {
    try {
        if (fs.lstatSync(src).isDirectory()) {
            if (!fs.existsSync(dest)) fs.mkdirSync(dest);
            fs.readdirSync(src).forEach(child => {
                copyRecursiveSync(path.join(src, child), path.join(dest, child));
            });
        } else {
            fs.copyFileSync(src, dest);
        }
    } catch (error) {
        console.error(`[Mods] Copy error: ${src} -> ${dest}`, error);
        throw new Error(`Failed to copy mod files: ${error.message}`);
    }
}


// Function to copy mod files to game directory
async function installMod(modType, modName) {
    try {
        const installPath = getInstallationPath();
        const gamePath = path.join(installPath, GAME_FOLDER_NAME);
        const modPath = path.join(gamePath, 'mods', modName);

        console.log(`Installing ${modType} mod "${modName}" from ${modPath} to ${gamePath}`);

        // Validate paths
        if (!fs.existsSync(modPath)) {
            throw new Error(`Mod directory not found: ${modPath}`);
        }

        if (!fs.existsSync(gamePath)) {
            throw new Error(`Game directory not found: ${gamePath}`);
        }

        // For graphics mods, ensure any conflicting mod is uninstalled first
        if (modType === 'graphics') {
            // Check if another graphics mod is active
            const currentGraphicsMod = activeMods.graphics;
            if (currentGraphicsMod && currentGraphicsMod !== modName) {
                console.log(`Removing conflicting graphics mod: ${currentGraphicsMod}`);
                await uninstallMod('graphics', currentGraphicsMod);
            }
        }

        // Get list of files to copy
        const files = fs.readdirSync(modPath);

        // Copy each file
        for (const file of files) {
            const sourcePath = path.join(modPath, file);
            const destPath = path.join(gamePath, file);

            // Handle directories recursively
            if (fs.statSync(sourcePath).isDirectory()) {
                copyRecursiveSync(sourcePath, destPath);
                console.log(`Copied directory: ${file}`);
                continue;
            }

            // Copy the file
            fs.copyFileSync(sourcePath, destPath);
            console.log(`Copied: ${file}`);
        }

        // Update active mods tracking
        if (modType === 'graphics') {
            activeMods.graphics = modName;
        } else if (modType === 'widescreen') {
            activeMods.widescreen = true;
        }

        // Save the active mod configuration
        saveActiveMods();

        return { success: true };
    } catch (error) {
        console.error(`Error installing ${modType} mod:`, error);
        return { success: false, error: error.message };
    }
}

// Function to remove mod files from game directory
async function uninstallMod(modType, modName) {
    try {
        const installPath = getInstallationPath();
        const gamePath = path.join(installPath, GAME_FOLDER_NAME);
        const modPath = path.join(gamePath, 'mods', modName);

        console.log(`Uninstalling ${modType} mod "${modName}" from ${gamePath}`);

        if (!fs.existsSync(modPath)) {
            throw new Error(`Mod directory not found: ${modPath}`);
        }

        if (!fs.existsSync(gamePath)) {
            throw new Error(`Game directory not found: ${gamePath}`);
        }

        // Рекурсивно получаем все файлы мода
        const allFiles = getAllFiles(modPath, modPath);

        // Удаляем каждый файл в игровой директории
        allFiles.forEach(relativePath => {
            const destPath = path.join(gamePath, relativePath);
            if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
                console.log(`Removed: ${relativePath}`);
            }
        });

        // Удаляем пустые директории (опционально)
        removeEmptyDirectories(gamePath);

        // Обновляем активные моды
        if (modType === 'graphics') {
            activeMods.graphics = null;
        } else if (modType === 'widescreen') {
            activeMods.widescreen = false;
        }

        saveActiveMods();

        return { success: true };
    } catch (error) {
        console.error(`Error uninstalling ${modType} mod:`, error);
        return { success: false, error: error.message };
    }
}

// Рекурсивно собирает все файлы в директории
function getAllFiles(dirPath, basePath, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach(file => {
        const filePath = path.join(dirPath, file);
        if (fs.statSync(filePath).isDirectory()) {
            getAllFiles(filePath, basePath, arrayOfFiles);
        } else {
            const relativePath = path.relative(basePath, filePath);
            arrayOfFiles.push(relativePath);
        }
    });

    return arrayOfFiles;
}

// Удаляет пустые директории в указанном пути
function removeEmptyDirectories(startPath) {
    const dirs = [];

    function findDirs(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            if (entry.isDirectory()) {
                const dirPath = path.join(dir, entry.name);
                dirs.push(dirPath);
                findDirs(dirPath);
            }
        });
    }
    findDirs(startPath);

    // Сортируем от самых вложенных к корневым
    dirs.sort((a, b) => b.localeCompare(a));

    dirs.forEach(dir => {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            console.log(`Removed empty directory: ${dir}`);
        }
    });
}

// Add IPC handlers for the renderer
ipcMain.handle('get-active-mods', async () => {
    return loadActiveMods();
});

// В main.js
process.on('uncaughtException', (error) => {
    mainWindow?.webContents.send('mods-error', error.message);
});

// Update the existing set-graphics-mod handler to handle proper switching
ipcMain.handle('set-graphics-mod', async (event, modName) => {
    try {
        // Load current mods state
        activeMods = loadActiveMods();
        const prevMod = activeMods.graphics;

        // If there's a change in selected mod
        if (prevMod !== modName) {
            // If there was a previous mod, uninstall it first
            if (prevMod) {
                console.log(`[Mods] Removing previous graphics mod: ${prevMod}`);
                await uninstallMod('graphics', prevMod);
            }

            // If new mod is selected, install it
            if (modName) {
                console.log(`[Mods] Installing new graphics mod: ${modName}`);
                const result = await installMod('graphics', modName);
                if (!result.success) return result;
            }
        }

        // Reset cached installation path to force fresh path checks
        cachedInstallationPath = null;
        return { success: true };
    } catch (error) {
        console.error('[Mods] Graphics mod error:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('toggle-widescreen-fix', async (event, enable) => {
    try {
        const modName = 'widescreenfix'; // Папка с модом должна называться именно так
        if (enable) {
            return await installMod('widescreen', modName);
        } else {
            return await uninstallMod('widescreen', modName);
        }
    } catch (error) {
        console.error('[Mods] Widescreen error:', error);
        return { success: false, error: error.message };
    }
});

function loadActiveMods() {
    try {
        const graphicsMod = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, 'ActiveGraphicsMod');
        const widescreenActive = directRegistryRead(INSTALLATION_PATH_REGISTRY_KEY, 'WidescreenFix') === 'true';
        return { graphics: graphicsMod, widescreen: widescreenActive };
    } catch (error) {
        console.error('[Mods] Error loading mods:', error);
        return { graphics: null, widescreen: false };
    }
}

function querySampServer(serverIp, serverPort) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timeout: No response from SAMP server'));
        }, 3000);

        // Создаем пакет для запроса информации о сервере
        const packet = createInfoPacket(serverIp, serverPort);

        socket.on('error', (err) => {
            clearTimeout(timeout);
            socket.close();
            reject(err);
        });

        socket.on('message', (message) => {
            clearTimeout(timeout);
            socket.close();

            try {
                const serverInfo = parseInfoResponse(message);
                resolve(serverInfo);
            } catch (err) {
                reject(new Error(`Failed to parse server response: ${err.message}`));
            }
        });

        // Отправляем запрос на сервер
        socket.send(packet, 0, packet.length, serverPort, serverIp, (err) => {
            if (err) {
                clearTimeout(timeout);
                socket.close();
                reject(err);
            }
        });
    });
}

// Создаем пакет запроса для SAMP сервера
function createInfoPacket(serverIp, serverPort) {
    const ipParts = serverIp.split('.');

    // 'SAMP' + IP (4 bytes) + Port (2 bytes) + 'i'
    const buffer = Buffer.alloc(11);

    // Записываем 'SAMP'
    buffer.write('SAMP', 0);

    // Записываем IP адрес
    buffer.writeUInt8(parseInt(ipParts[0]), 4);
    buffer.writeUInt8(parseInt(ipParts[1]), 5);
    buffer.writeUInt8(parseInt(ipParts[2]), 6);
    buffer.writeUInt8(parseInt(ipParts[3]), 7);

    // Записываем порт
    buffer.writeUInt16LE(serverPort, 8);

    // Записываем 'i' (запрос информации)
    buffer.write('i', 10);

    return buffer;
}

// Разбор ответа от SAMP сервера
function parseInfoResponse(buffer) {
    // Пропускаем первые 11 байт (заголовок)
    let offset = 11;

    // Структура данных для хранения информации о сервере
    const info = {};

    // Пароль (1 байт)
    info.password = Boolean(buffer.readUInt8(offset));
    offset += 1;

    // Количество игроков (2 байта)
    info.players = buffer.readUInt16LE(offset);
    offset += 2;

    // Максимальное количество игроков (2 байта)
    info.maxPlayers = buffer.readUInt16LE(offset);
    offset += 2;

    // Название сервера (сначала длина - 4 байта, затем строка)
    const hostnameLen = buffer.readUInt32LE(offset);
    offset += 4;
    info.hostname = buffer.toString('utf8', offset, offset + hostnameLen);
    offset += hostnameLen;

    // Игровой режим (сначала длина - 4 байта, затем строка)
    const gamemodeLen = buffer.readUInt32LE(offset);
    offset += 4;
    info.gamemode = buffer.toString('utf8', offset, offset + gamemodeLen);
    offset += gamemodeLen;

    // Язык (сначала длина - 4 байта, затем строка)
    const languageLen = buffer.readUInt32LE(offset);
    offset += 4;
    info.language = buffer.toString('utf8', offset, offset + languageLen);

    return info;
}

// Обработчик IPC для запроса онлайна SAMP сервера
ipcMain.handle('get-server-online', async (event, { ip, port }) => {
    try {
        // log.info(`Querying SAMP server: ${ip}:${port}`);
        const serverInfo = await querySampServer(ip, port);

        // log.info(`Server response: ${serverInfo.players}/${serverInfo.maxPlayers} players online`);
        return {
            success: true,
            data: {
                players: serverInfo.players,
                maxPlayers: serverInfo.maxPlayers,
                hostname: serverInfo.hostname,
                gamemode: serverInfo.gamemode
            }
        };
    } catch (error) {
        // log.error(`Error querying SAMP server: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
});

// Add this function to force a complete redownload
ipcMain.handle('force-redownload', async () => {
    try {
        console.log('Force redownload requested');
        const installPath = getInstallationPath();

        if (!installPath) {
            return {
                success: false,
                error: 'Installation path not set or invalid'
            };
        }

        // Send initial progress
        mainWindow?.webContents.send('check-files-progress', {
            checked: 0,
            total: 100,
            percent: 0
        });

        // Get remote file list
        const remoteFiles = await fetchRemoteHashes();
        const totalFiles = Object.keys(remoteFiles).length;

        console.log(`Marking ${totalFiles} files for redownload`);

        // Create results array where all files are marked as missing
        const results = Object.entries(remoteFiles).map(([normalizedName, fileData]) => {
            return {
                path: fileData.originalName,
                normalizedPath: normalizedName,
                status: 'missing',  // Force status as missing to trigger download
                size: fileData.size,
                hash: fileData.hash,
                actualSize: 0,
                actualHash: ''
            };
        });

        // Calculate total download size (sum of all file sizes)
        const totalDownloadSize = Object.values(remoteFiles).reduce((total, file) => total + file.size, 0);

        // Final progress update
        mainWindow?.webContents.send('check-files-progress', {
            checked: totalFiles,
            total: totalFiles,
            percent: 100
        });

        return {
            results: results,
            totalFiles: totalFiles,
            totalDownloadSize: totalDownloadSize
        };
    } catch (error) {
        console.error('Error in force-redownload:', error);
        return {
            error: error.message,
            results: [],
            totalFiles: 0,
            totalDownloadSize: 0
        };
    }
});

// Add this function to clean installation directory
async function cleanInstallationDirectory() {
    return new Promise(async (resolve, reject) => {
        try {
            const installPath = getInstallationPath();
            if (!installPath) {
                return reject(new Error('Installation path not set or invalid'));
            }

            const gamePath = path.join(installPath, GAME_FOLDER_NAME);
            console.log(`Cleaning installation directory: ${gamePath}`);

            // Check if directory exists
            if (!fs.existsSync(gamePath)) {
                console.log('Game directory does not exist, nothing to clean');
                return resolve();
            }

            // List of critical directories to preserve
            const preserveDirectories = ['mods'];

            // Get all files and directories
            const items = fs.readdirSync(gamePath);

            for (const item of items) {
                // Skip directories we want to preserve
                if (preserveDirectories.includes(item) && fs.statSync(path.join(gamePath, item)).isDirectory()) {
                    console.log(`Preserving directory: ${item}`);
                    continue;
                }

                const itemPath = path.join(gamePath, item);

                try {
                    if (fs.statSync(itemPath).isDirectory()) {
                        // Remove directory recursively
                        fs.rmdirSync(itemPath, { recursive: true });
                        console.log(`Removed directory: ${item}`);
                    } else {
                        // Remove file
                        fs.unlinkSync(itemPath);
                        console.log(`Removed file: ${item}`);
                    }
                } catch (error) {
                    console.error(`Failed to remove ${item}: ${error.message}`);
                    // Continue with other files even if one fails
                }
            }

            resolve();
        } catch (error) {
            console.error('Error cleaning installation directory:', error);
            reject(error);
        }
    });
}

ipcMain.handle('repair-game', async () => {
    try {
        log.info('Game repair requested');
        return await performFileCheck();
    } catch (error) {
        log.error('Error repairing game:', error);
        return {
            success: false,
            error: error.message,
            results: [],
            totalFiles: 0,
            totalDownloadSize: 0,
            cleanedFiles: 0
        };
    }
});

// Add this IPC handler to check if gta_sa.exe is running
ipcMain.handle('check-game-running', () => {
    return isGameProcessRunning().then((isRunning) => {
        console.log(`Game process check: gta_sa.exe ${isRunning ? 'is' : 'is not'} running`);
        return isRunning;
    });
});

// Configure the update server URL - pointing to your CDN
autoUpdater.setFeedURL({
    provider: 'generic',
    url: `${GAME_FILES_BASE_URL}/launcher-updates`,
    channel: 'latest'
});

// Handle update events to communicate with the renderer process
autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-status', { status: 'checking' });
});

autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-status', {
        status: 'available',
        version: info.version,
        releaseNotes: info.releaseNotes
    });
});

autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('update-status', {
        status: 'downloading',
        progress: progressObj
    });
});

autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded, ready for installation');
    mainWindow?.webContents.send('update-status', {
        status: 'downloaded',
        version: info.version
    });
});

autoUpdater.on('update-not-available', () => {
    // log.info('No updates available');
    mainWindow?.webContents.send('update-status', { status: 'not-available' });
});

autoUpdater.on('download-progress', (progressObj) => {
    // log.info(`Download progress: ${progressObj.percent}%`);
    mainWindow?.webContents.send('update-status', {
        status: 'downloading',
        progress: progressObj
    });
});

autoUpdater.on('error', (err) => {
    log.error('Update error:', err.stack || err);
    mainWindow?.webContents.send('update-status', {
        status: 'error',
        error: err.message
    });
});

app.on('before-quit', () => {
    log.info('App is preparing to quit for update');
});

// Add an IPC handler to allow the renderer to request update checks
ipcMain.handle('check-for-updates', async () => {
    await checkForUpdates();
    return { success: true };
});

// Add this IPC handler to let the renderer ask for updates
ipcMain.handle('check-and-install-updates', async () => {
    try {
        log.info('Checking for updates on user request');
        autoUpdater.autoDownload = true;
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (error) {
        log.error('Update error:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('install-update', () => {
    // Set to true for silent installation (no UI)
    const isSilent = true;
    // Set to true to run the app after update
    const isForceRunAfter = true;

    log.info('Installing update silently...');
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
    return { success: true };
});

// Enhanced checkForUpdates function
async function checkForUpdates() {
    try {
        if (!app.isPackaged && process.env.FORCE_DEV_UPDATE !== '1') {
            log.info('Skipping update check in development mode');
            mainWindow?.webContents.send('update-status', { status: 'not-available' });
            return null;
        }

        log.info('Checking for updates...');
        mainWindow?.webContents.send('update-status', { status: 'checking' });

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;

        const result = await autoUpdater.checkForUpdates();
        log.info('Update check result:', result);
        return result;
    } catch (err) {
        log.error('Error checking for updates:', err);
        mainWindow?.webContents.send('update-status', {
            status: 'error',
            error: err.message
        });
        return null;
    }
}