// Global variables
const LEGACY_NICKNAME_KEY = atob('a2FpZi1uaWNrbmFtZQ==');
let downloadInProgress = false;
let verifyInProgress = false;
let gameFilesReady = false;
let checkInterval;
let launcherConfig = null;
let mainScreenShown = false;
let launcherConfigLoadId = 0;

document.addEventListener('DOMContentLoaded', async () => {
    console.log('Document loaded, initializing launcher...');

    await loadNickname();

    const nicknameInput = document.getElementById('nickname-input');
    nicknameInput.addEventListener('input', handleNicknameChange);
    nicknameInput.addEventListener('focus', () => nicknameInput.removeAttribute('readonly'));

    await startLauncherUpdateFlow();
});

async function startLauncherUpdateFlow() {
    const loadText = document.getElementById('launcher-load-text');
    const updateSection = document.getElementById('launcher-update-section');
    const updateBar = document.getElementById('launcher-update-bar-fill');
    const updatePercent = document.getElementById('launcher-update-percent');

    if (!window.electronAPI) {
        setTimeout(showMainScreen, 500);
        return;
    }

    let updateFinished = false;
    let updateInProgress = false;
    let unsubscribe = null;

    const finishUpdateFlow = () => {
        if (updateFinished) return;
        updateFinished = true;
        if (unsubscribe) unsubscribe();
        showMainScreen();
    };

    const showUpdateProgress = (percent) => {
        if (updateSection) updateSection.classList.add('visible');
        const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
        if (updateBar) updateBar.style.width = `${safePercent}%`;
        if (updatePercent) updatePercent.textContent = `${safePercent}%`;
    };

    unsubscribe = window.electronAPI.onUpdateStatus((status) => {
        if (status.status === 'checking') {
            if (loadText) loadText.textContent = 'Проверка обновлений...';
        } else if (status.status === 'available') {
            updateInProgress = true;
            if (loadText) loadText.textContent = 'Найдено обновление лаунчера...';
            showUpdateProgress(0);
        } else if (status.status === 'downloading') {
            updateInProgress = true;
            if (loadText) loadText.textContent = 'Загрузка обновления лаунчера...';
            showUpdateProgress(status.progress?.percent || 0);
        } else if (status.status === 'downloaded') {
            updateInProgress = true;
            if (loadText) loadText.textContent = 'Установка обновления...';
            showUpdateProgress(100);
            window.electronAPI.installUpdate();
        } else if (status.status === 'not-available') {
            finishUpdateFlow();
        } else if (status.status === 'error') {
            console.error('Update error:', status.error);
            if (updateInProgress) {
                if (loadText) loadText.textContent = 'Ошибка обновления. Повторная попытка...';
                window.electronAPI.checkForUpdates();
                return;
            }
            finishUpdateFlow();
        }
    });

    await window.electronAPI.checkForUpdates();

    setTimeout(() => {
        if (!updateFinished && !updateInProgress) {
            console.warn('Update check timeout, opening main screen');
            finishUpdateFlow();
        }
    }, 30000);
}

async function showMainScreen() {
    if (mainScreenShown) return;
    mainScreenShown = true;

    const loadingScreen = document.getElementById('loadingScreen');
    loadingScreen.style.opacity = '0';

    setTimeout(async () => {
        loadingScreen.style.display = 'none';
        document.getElementById('mainContent').style.opacity = '1';

        await loadLauncherConfig();
        initButtons();
        updateOnlineCount();
        initializeSettings();
        blurNicknameInput();

        if (window.electronAPI) {
            const { path, displayPath } = await window.electronAPI.getInstallationPath();
            if (!path && !displayPath) {
                showSettingsDialog(true);
                setPathRequiredState();
            } else {
                setReadyToLaunchState();
            }
        } else {
            setReadyToLaunchState();
        }
    }, 500);
}

async function loadLauncherConfig() {
    if (!window.electronAPI) return;

    const loadId = ++launcherConfigLoadId;

    try {
        const result = await window.electronAPI.getLauncherConfig();
        if (loadId !== launcherConfigLoadId) return;

        launcherConfig = result.config || null;
        if (launcherConfig?.news) {
            launcherConfig.news = launcherConfig.news.filter((item, index, list) => {
                if (!item) return false;
                const key = `${item.title || ''}|${item.description || ''}|${item.image || ''}`;
                return list.findIndex(other => `${other.title || ''}|${other.description || ''}|${other.image || ''}` === key) === index;
            });
        }

        console.log('News loaded:', launcherConfig?.news?.length ?? 0);
        applyLauncherConfig(launcherConfig);
    } catch (error) {
        console.error('Failed to load launcher config:', error);
    }
}

function applyLauncherConfig(config) {
    if (!config) return;

    if (config.server) {
        const serverName = document.getElementById('server-name');
        const maxOnline = document.getElementById('max-online-count');
        if (serverName && config.server.name) {
            serverName.textContent = config.server.name;
        }
        if (maxOnline && config.server.maxPlayers) {
            maxOnline.textContent = config.server.maxPlayers;
        }
    }

    renderNews(config.news || []);
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderNews(newsItems) {
    const container = document.getElementById('news-container');
    if (!container) return;

    container.innerHTML = '';

    if (!newsItems.length) {
        return;
    }

    const items = newsItems.filter(item => item && (item.title || item.description || item.image));

    container.innerHTML = items.map((item, index) => `
        <div class="new" data-article-url="${escapeHtml(item.url || '')}">
            <div class="new-image-container">
                <img src="${escapeHtml(item.image || './Resources/news.png')}" onerror="this.src='./Resources/news.png'" alt="">
            </div>
            <div class="news-bottom">
                <div class="news-text">
                    <span class="news-main-title">${escapeHtml(item.title || '')}</span>
                    <span class="news-description">${escapeHtml(item.description || '')}</span>
                </div>
                <button type="button">
                    <svg width="16" height="9" viewBox="0 0 16 9" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M0 4.5H14M14 4.5L10.5 1M14 4.5L10.5 8" stroke="url(#paint0_linear_news${index})" stroke-width="2" />
                        <defs>
                            <linearGradient id="paint0_linear_news${index}" x1="15" y1="5" x2="0" y2="5" gradientUnits="userSpaceOnUse">
                                <stop stop-color="#0A0A0B" />
                                <stop offset="1" stop-color="#0A0A0B" stop-opacity="0" />
                            </linearGradient>
                        </defs>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');

    initNews();
}

// Function to load nickname from registry or localStorage
async function loadNickname() {
    try {
        let nickname = '';

        if (window.electronAPI) {
            // Try to get from registry first
            const result = await window.electronAPI.getNickname();
            nickname = result.nickname || '';
        }

        // Fallback to localStorage if empty
        if (!nickname) {
            nickname = localStorage.getItem('westland-nickname') || localStorage.getItem(LEGACY_NICKNAME_KEY) || '';
        }

        if (nickname) {
            const nicknameInput = document.getElementById('nickname-input');
            nicknameInput.value = nickname;
            blurNicknameInput();
        }
    } catch (error) {
        console.error('Failed to load nickname:', error);
    }
}

// Handle nickname input changes
function handleNicknameChange() {
    const nicknameInput = document.getElementById('nickname-input');
    const nickname = nicknameInput.value.trim();

    if (!nickname) return;

    // Store in localStorage as fallback
    try {
        localStorage.setItem('westland-nickname', nickname);
    } catch (error) {
        console.error('Failed to save nickname to localStorage:', error);
    }

    // Store in registry if available
    if (window.electronAPI) {
        window.electronAPI.saveNickname(nickname).catch(err => {
            console.error('Failed to save nickname to registry:', err);
        });
    }
}


function blurNicknameInput() {
    const nicknameInput = document.getElementById('nickname-input');
    if (!nicknameInput) return;

    nicknameInput.blur();
    if (nicknameInput.value && typeof nicknameInput.setSelectionRange === 'function') {
        nicknameInput.setSelectionRange(nicknameInput.value.length, nicknameInput.value.length);
    }
}

// Format file size
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

// Update download progress UI
function updateDownloadProgress(percent, downloadedBytes, totalBytes, speed) {
    const progressBar = document.getElementById('download-progress-bar');
    const percentElement = document.getElementById('download-percent');

    if (!progressBar || !percentElement) return;

    percent = Math.max(0, Math.min(100, percent));
    progressBar.style.width = `${percent}%`;
    percentElement.textContent = `${Math.round(percent)}%`;
}

function setPathRequiredState() {
    const statusElement = document.getElementById('download-status');
    const playButtonText = document.getElementById('play-button-text');
    const playButton = document.getElementById('play-button');

    updateDownloadProgress(0);
    if (statusElement) {
        statusElement.textContent = 'Выберите папку для скачки игры';
    }
    if (playButtonText) {
        playButtonText.textContent = 'Укажите путь установки';
    }
    if (playButton) {
        playButton.classList.remove('active');
    }
    restoreLoadingSpinner();
    gameFilesReady = false;
}

function setReadyToLaunchState() {
    const statusElement = document.getElementById('download-status');
    const playButtonText = document.getElementById('play-button-text');
    const playButton = document.getElementById('play-button');

    replaceLoadingWithCheckmark();
    updateDownloadProgress(100);
    if (statusElement) {
        statusElement.textContent = 'Готово к запуску';
    }
    if (playButtonText) {
        playButtonText.textContent = 'Запустить игру';
    }
    if (playButton) {
        playButton.classList.add('active');
    }
    gameFilesReady = false;
}

// Update online count via SAMP query using CDN config
async function updateOnlineCount() {
    try {
        const onlineElement = document.getElementById('online-count');
        if (!onlineElement) return;

        const server = launcherConfig?.server || { ip: '147.45.38.102', port: 7777, maxPlayers: 1000 };
        const maxOnlineElement = document.getElementById('max-online-count');
        if (maxOnlineElement && server.maxPlayers) {
            maxOnlineElement.textContent = server.maxPlayers;
        }

        if (window.electronAPI) {
            try {
                const result = await window.electronAPI.getServerOnline({
                    ip: server.ip,
                    port: server.port
                });

                if (result.success) {
                    onlineElement.textContent = result.data.players;
                    if (maxOnlineElement && result.data.maxPlayers) {
                        maxOnlineElement.textContent = result.data.maxPlayers;
                    }
                } else {
                    onlineElement.textContent = '0';
                }
            } catch (error) {
                console.error('Error getting server online:', error);
                onlineElement.textContent = '0';
            }
        } else {
            setTimeout(() => {
                const randomOnline = Math.floor(Math.random() * 500) + 500;
                onlineElement.textContent = randomOnline;
            }, 1000);
        }
    } catch (error) {
        console.error('Error updating online count:', error);
        const onlineElement = document.getElementById('online-count');
        if (onlineElement) onlineElement.textContent = '0';
    }

    setTimeout(updateOnlineCount, 60000);
}

// Attach click handlers to static news items
function initNews() {
    const newsElements = document.querySelectorAll('#news-container .new');
    newsElements.forEach(newsElement => {
        const articleUrl = newsElement.dataset.articleUrl;
        if (!articleUrl) return;

        newsElement.addEventListener('click', () => {
            openExternalLink(articleUrl);
        });
    });
}

// Open external links
function openExternalLink(url) {
    if (!url || url === '#') return;
    if (window.electronAPI) {
        window.electronAPI.openExternal(url);
    } else {
        window.open(url, '_blank');
    }
}

function replaceLoadingWithCheckmark() {
    const loaderIcon = document.getElementById('download-progress-container')?.querySelector('.loader-icon');
    if (!loaderIcon) return;

    loaderIcon.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" style="fill: #4CAF50;">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
        </svg>
    `;
}

function restoreLoadingSpinner() {
    const loaderIcon = document.getElementById('download-progress-container')?.querySelector('.loader-icon');
    if (!loaderIcon) return;

    loaderIcon.innerHTML = '<img src="./Resources/loading-icon.png" alt="Loading">';
}

// Verify game files — returns true when game files are ready to launch
async function verifyFiles({ repair = false } = {}) {
    if (verifyInProgress) return gameFilesReady;
    verifyInProgress = true;
    gameFilesReady = false;

    const playButton = document.getElementById('play-button');
    const playButtonText = document.getElementById('play-button-text');
    const statusElement = document.getElementById('download-status');

    if (!playButton || !playButtonText || !statusElement) {
        verifyInProgress = false;
        return false;
    }

    playButtonText.textContent = repair ? 'Починка игры...' : 'Проверка файлов...';
    statusElement.textContent = repair
        ? 'Удаление лишних файлов и проверка по CDN...'
        : 'Инициализация проверки файлов...';
    playButton.classList.remove('active');
    restoreLoadingSpinner();
    updateDownloadProgress(0);

    // Check if Electron API is available
    if (window.electronAPI) {
        try {
            const { path, success } = await window.electronAPI.getInstallationPath();
            if (!success || !path) {
                showSettingsDialog(true);
                setPathRequiredState();
                verifyInProgress = false;
                return false;
            }

            const unsubscribe = window.electronAPI.onCheckFilesProgress((progress) => {
                updateDownloadProgress(progress.percent);
                statusElement.innerHTML = `Проверка файлов: <span class="current">${progress.checked}</span> / <span class="total">${progress.total}</span>`;
            });

            const checkResult = repair
                ? await window.electronAPI.repairGame()
                : await window.electronAPI.checkFiles();
            unsubscribe();

            if (checkResult.error) {
                console.error('Error checking files:', checkResult.error);
                statusElement.innerHTML = `Ошибка проверки файлов: ${checkResult.error}`;
                playButtonText.textContent = repair ? 'Починить игру' : 'Проверить файлы';
                verifyInProgress = false;
                return false;
            }

            if (repair && checkResult.cleanedFiles > 0) {
                statusElement.textContent = `Удалено лишних файлов: ${checkResult.cleanedFiles}. Проверка завершена.`;
            }

            const filesToDownload = checkResult.results.filter(file =>
                file.status === 'missing' ||
                file.status === 'invalid-size' ||
                file.status === 'invalid-hash'
            );

            if (filesToDownload.length > 0) {
                const downloadSuccess = await downloadFiles(filesToDownload);
                verifyInProgress = false;
                gameFilesReady = downloadSuccess;
                return downloadSuccess;
            }

            replaceLoadingWithCheckmark();
            updateDownloadProgress(100);
            statusElement.innerHTML = `Все файлы проверены. Игра готова к запуску!`;
            playButtonText.textContent = 'Запустить игру';
            playButton.classList.add('active');
            verifyInProgress = false;
            gameFilesReady = true;
            return true;
        } catch (error) {
            console.error('Error in verification process:', error);
            statusElement.innerHTML = `Ошибка: ${error.message}`;
            playButtonText.textContent = 'Проверить файлы';
            verifyInProgress = false;
            return false;
        }
    } else {
        // Demo mode - simulate file checking
        let progress = 0;
        return await new Promise((resolve) => {
            const interval = setInterval(() => {
                progress += 5;
                updateDownloadProgress(progress);
                statusElement.innerHTML = `Проверка файлов: <span class="current">${progress * 23 / 100} MB</span> / <span class="total">2.3 GB</span>`;

                if (progress >= 100) {
                    clearInterval(interval);
                    replaceLoadingWithCheckmark();
                    updateDownloadProgress(100);
                    statusElement.innerHTML = `Все файлы проверены. Игра готова к запуску!`;
                    playButtonText.textContent = 'Запустить игру';
                    playButton.classList.add('active');
                    verifyInProgress = false;
                    gameFilesReady = true;
                    resolve(true);
                }
            }, 200);
        });
    }
}

// Download files — returns true when all files downloaded successfully
async function downloadFiles(filesToDownload) {
    if (downloadInProgress) return false;
    downloadInProgress = true;

    const playButton = document.getElementById('play-button');
    const playButtonText = document.getElementById('play-button-text');
    const statusElement = document.getElementById('download-status');

    if (!playButton || !playButtonText || !statusElement) {
        downloadInProgress = false;
        return false;
    }

    playButtonText.textContent = 'Загрузка...';
    restoreLoadingSpinner();

    try {
        if (window.electronAPI) {
            const unsubscribe = window.electronAPI.onDownloadProgress((progress) => {
                updateDownloadProgress(
                    progress.percent,
                    progress.downloadedBytes,
                    progress.totalBytes,
                    progress.speed
                );

                const downloadedStr = formatSize(progress.downloadedBytes || 0);
                const totalStr = formatSize(progress.totalBytes || 0);
                const speedStr = formatSize(progress.speed || 0) + '/с';

                statusElement.innerHTML = `Загрузка: <span class="current">${downloadedStr}</span> / <span class="total">${totalStr}</span> <span class="speed">(${speedStr})</span>`;
            });

            const unsubscribeError = window.electronAPI.onDownloadFileFailed((failedFile) => {
                console.error('Failed to download file:', failedFile);
            });

            const downloadResult = await window.electronAPI.downloadFiles({
                files: filesToDownload
            });

            unsubscribe();
            unsubscribeError();

            if (downloadResult.success) {
                replaceLoadingWithCheckmark();
                updateDownloadProgress(100);
                statusElement.innerHTML = `Все файлы загружены. Игра готова к запуску!`;
                playButtonText.textContent = 'Запустить игру';
                playButton.classList.add('active');
                gameFilesReady = true;
                return true;
            }

            statusElement.innerHTML = `Ошибка загрузки: ${downloadResult.stats.failedFiles} файлов не загружено`;
            playButtonText.textContent = 'Повторить загрузку';
            gameFilesReady = false;
            return false;
        } else {
            return await new Promise((resolve) => {
                let progress = 0;
                const totalSize = 100 * 1024 * 1024;
                const interval = setInterval(() => {
                    progress += 2;
                    const downloadedBytes = Math.floor(totalSize * progress / 100);
                    const speed = 2 * 1024 * 1024;

                    updateDownloadProgress(progress, downloadedBytes, totalSize, speed);

                    const downloadedStr = formatSize(downloadedBytes);
                    const totalStr = formatSize(totalSize);
                    const speedStr = formatSize(speed) + '/с';

                    statusElement.innerHTML = `Загрузка: <span class="current">${downloadedStr}</span> / <span class="total">${totalStr}</span> <span class="speed">(${speedStr})</span>`;

                    if (progress >= 100) {
                        clearInterval(interval);
                        replaceLoadingWithCheckmark();
                        updateDownloadProgress(100);
                        statusElement.innerHTML = `Все файлы загружены. Игра готова к запуску!`;
                        playButtonText.textContent = 'Запустить игру';
                        playButton.classList.add('active');
                        gameFilesReady = true;
                        resolve(true);
                    }
                }, 100);
            });
        }
    } catch (error) {
        console.error('Error in download process:', error);
        statusElement.innerHTML = `Ошибка загрузки: ${error.message}`;
        playButtonText.textContent = 'Повторить загрузку';
        return false;
    } finally {
        downloadInProgress = false;
    }
}


// Initialize buttons
function initButtons() {
    // Exit button
    const exitButton = document.getElementById('exit-button');
    if (exitButton) {
        exitButton.addEventListener('click', () => {
            if (window.electronAPI) {
                window.electronAPI.closeWindow();
            } else {
                console.log('Not running in Electron environment');
            }
        });
    }

    const minimizeButton = document.getElementById('minimize-button');
    if (minimizeButton) {
        minimizeButton.addEventListener('click', () => {
            if (window.electronAPI) {
                window.electronAPI.minimizeLauncher();
            }
        });
    }

    // Social buttons (URLs will be configured later)
    attachClickHandler('website-button', () => openExternalLink('#'));
    attachClickHandler('vk-button', () => openExternalLink('#'));
    attachClickHandler('youtube-button', () => openExternalLink('#'));

    // Navigation links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', function () {
            openExternalLink('#');
        });
    });

    // Settings button
    attachClickHandler('settings-button', showSettingsDialog);

    // Logo button
    attachClickHandler('logo-button', () => openExternalLink('#'));

    // Play button
    const playButton = document.getElementById('play-button');
    if (playButton) {
        playButton.addEventListener('click', async function () {
            const nickname = document.getElementById('nickname-input').value.trim();
            const playButtonText = document.getElementById('play-button-text');

            if (!nickname) {
                alert('Пожалуйста, введите ваш никнейм');
                return;
            }

            // Validate nickname
            if (window.electronAPI) {
                const validation = await window.electronAPI.validateNickname(nickname);
                if (!validation.valid) {
                    alert(validation.message);
                    return;
                }
            }

            if (playButtonText.textContent === 'Запустить игру') {
                const filesReady = await verifyFiles();
                if (filesReady) {
                    await launchGame(nickname);
                }
            } else if (playButtonText.textContent === 'Проверка файлов...' ||
                playButtonText.textContent === 'Загрузка...') {
                return;
            } else if (playButtonText.textContent === 'Проверить файлы' ||
                playButtonText.textContent === 'Повторить загрузку') {
                verifyFiles();
            } else if (playButtonText.textContent === 'Укажите путь установки') {
                showSettingsDialog(true); // Show settings with path error
            }
        });
    }
}

async function launchGame(nickname) {
    const playButtonText = document.getElementById('play-button-text');

    playButtonText.textContent = 'Запуск...';
    try {
        if (window.electronAPI) {
            const isRunning = await window.electronAPI.checkGameRunning();
            if (isRunning) {
                alert('Игра уже запущена');
                playButtonText.textContent = 'Запустить игру';
                return;
            }

            if (!launcherConfig?.server) {
                await loadLauncherConfig();
            }

            const result = await window.electronAPI.startGame(nickname, launcherConfig?.server);
            if (!result.success) {
                throw new Error(result.error || 'Failed to start game');
            }

            startGameProcessChecker();
        } else {
            setTimeout(() => {
                alert(`Игра запускается с ником: ${nickname}`);
                playButtonText.textContent = 'Игра запущена';

                setTimeout(() => {
                    playButtonText.textContent = 'Запустить игру';
                }, 10000);
            }, 1000);
        }
    } catch (error) {
        console.error('Ошибка запуска игры:', error);
        playButtonText.textContent = 'Ошибка, попробуйте снова';
        setTimeout(() => {
            playButtonText.textContent = 'Запустить игру';
        }, 2000);
    }
}

// Helper function to attach click handler with null check
function attachClickHandler(id, handler) {
    const element = document.getElementById(id);
    if (element) {
        element.addEventListener('click', handler);
    }
}

function showSettingsDialog(showPathError = false) {
    const settingsOverlay = document.querySelector('.settings-overlay');
    if (!settingsOverlay) return;

    settingsOverlay.style.display = 'flex';

    loadCurrentInstallationPath().then(() => {
        const pathInput = document.getElementById('install-path');
        const pathErrorMessage = document.querySelector('.path-error-message');

        if (pathErrorMessage) {
            if (pathInput?.value) {
                pathErrorMessage.classList.remove('visible');
            } else if (showPathError) {
                pathErrorMessage.textContent = 'Пожалуйста, выберите путь установки';
                pathErrorMessage.classList.add('visible');
            } else {
                pathErrorMessage.classList.remove('visible');
            }
        }

        loadSettings();

        // Set up event listeners if not already set
        setupSettingsEventListeners();

        updateGraphicsButtons();

        // Disable RAM buttons
        disableRamButtons();
    });
}

// Новая функция для загрузки текущего пути установки
async function loadCurrentInstallationPath() {
    try {
        if (window.electronAPI) {
            const { path, displayPath, exists } = await window.electronAPI.getInstallationPath();
            const pathInput = document.getElementById('install-path');
            const pathToShow = displayPath || path;

            if (pathInput) {
                pathInput.value = pathToShow || '';
            }

            const pathErrorMessage = document.querySelector('.path-error-message');
            if (pathErrorMessage) {
                if (pathToShow && exists) {
                    pathErrorMessage.classList.remove('visible');
                } else if (pathToShow && !exists) {
                    pathErrorMessage.textContent = 'Указанный путь не существует!';
                    pathErrorMessage.classList.add('visible');
                }
            }
        }
    } catch (error) {
        console.error('Error loading installation path:', error);
    }
}

// Close settings dialog
function closeSettingsDialog() {
    const settingsOverlay = document.querySelector('.settings-overlay');
    if (!settingsOverlay) return;

    settingsOverlay.style.display = 'none';
}

// Set up all event listeners for settings dialog
function setupSettingsEventListeners() {
    // Close button
    const closeBtn = document.getElementById('close-settings');
    if (closeBtn) {
        // Remove existing listener to avoid duplicates
        closeBtn.removeEventListener('click', closeSettingsDialog);
        // Add new listener
        closeBtn.addEventListener('click', closeSettingsDialog);
    }

    // Change installation path
    const changePathBtn = document.getElementById('change-path');
    if (changePathBtn) {
        changePathBtn.removeEventListener('click', handleChangePath);
        changePathBtn.addEventListener('click', handleChangePath);
    }

    // RAM buttons
    const ramButtons = document.querySelectorAll('.ram-button');
    ramButtons.forEach(button => {
        button.removeEventListener('click', handleRamButtonClick);
        button.addEventListener('click', handleRamButtonClick);
    });

    // Graphics buttons
    const graphicsButtons = document.querySelectorAll('.graphics-button');
    graphicsButtons.forEach(button => {
        button.removeEventListener('click', handleGraphicsButtonClick);
        button.addEventListener('click', handleGraphicsButtonClick);
    });

    // Check files button
    const checkFilesBtn = document.getElementById('check-files');
    if (checkFilesBtn) {
        checkFilesBtn.removeEventListener('click', handleCheckFiles);
        checkFilesBtn.addEventListener('click', handleCheckFiles);
    }

    // Reset game button
    const repairGameBtn = document.getElementById('repair-game');
    if (repairGameBtn) {
        repairGameBtn.removeEventListener('click', handleRepairGame);
        repairGameBtn.addEventListener('click', handleRepairGame);
    }

    // Widescreen checkbox
    const widescreenCheckbox = document.getElementById('widescreen-fix');
    if (widescreenCheckbox) {
        widescreenCheckbox.removeEventListener('change', handleWidescreenChange);
        widescreenCheckbox.addEventListener('change', handleWidescreenChange);
    }
}

async function handleWidescreenChange(event) {
    if (!window.electronAPI) return;

    try {
        // Call the Electron API to toggle widescreen fix
        await window.electronAPI.toggleWidescreenFix(event.target.checked);
    } catch (error) {
        console.error('Error toggling widescreen fix:', error);
        alert(`Ошибка: ${error.message}`);

        // Reset checkbox to previous state in case of error
        event.target.checked = !event.target.checked;
    }
}

// Handle changing installation path
// Add function to disable RAM buttons
function disableRamButtons() {
    const ramButtons = document.querySelectorAll('.ram-button');
    ramButtons.forEach(button => {
        button.classList.add('disabled');
    });
}

// Modify the function that handles installation path changes
async function handleChangePath() {
    if (!window.electronAPI) return;

    try {
        const result = await window.electronAPI.showDirectoryPicker();
        if (!result.canceled && result.filePaths.length > 0) {
            const path = result.filePaths[0];

            // Validate path
            const validation = await window.electronAPI.validateInstallationPath(path);

            if (validation.valid) {
                await window.electronAPI.setInstallationPath(path);
                const { displayPath, path: savedPath } = await window.electronAPI.getInstallationPath();
                document.getElementById('install-path').value = displayPath || savedPath || path;

                // Hide path error message when valid path is set
                const pathErrorMessage = document.querySelector('.path-error-message');
                if (pathErrorMessage) {
                    pathErrorMessage.classList.remove('visible');
                }

                // Закрываем окно настроек
                closeSettingsDialog();
                setReadyToLaunchState();
            } else {
                alert(`Ошибка: ${validation.error}`);
            }
        }
    } catch (error) {
        console.error('Error selecting installation path:', error);
        alert('Произошла ошибка при выборе пути установки');
    }
}

// Handle RAM button click
async function handleRamButtonClick(event) {
    if (!window.electronAPI) return;

    const ramButtons = document.querySelectorAll('.ram-button');

    // Get the RAM value from button ID (ram-1024, ram-2048, etc.)
    const ramValue = event.target.id.split('-')[1];

    try {
        // Set memory allocation
        await window.electronAPI.setMemoryAllocation(ramValue);

        // Update button styles
        ramButtons.forEach(btn => {
            btn.classList.remove('active');
        });
        event.target.classList.add('active');
    } catch (error) {
        console.error('Error setting memory allocation:', error);
        alert(`Ошибка: ${error.message}`);
    }
}

// Функция для обновления состояния кнопок графики
async function updateGraphicsButtons() {
    if (!window.electronAPI) return;

    try {
        // Получаем текущие активные моды
        const activeMods = await window.electronAPI.getActiveMods();

        // Все кнопки графики
        const graphicsButtons = document.querySelectorAll('.graphics-button');

        // Сначала снимаем выделение со всех кнопок
        graphicsButtons.forEach(btn => btn.classList.remove('active'));

        // Определяем, какая кнопка должна быть активна
        let activeButtonId = 'graphics-low'; // По умолчанию "Низкие"

        if (activeMods.graphics === 'lowgraphics') {
            activeButtonId = 'graphics-medium';
        } else if (activeMods.graphics === 'highgraphics') {
            activeButtonId = 'graphics-high';
        }

        // Активируем нужную кнопку
        const activeButton = document.getElementById(activeButtonId);
        if (activeButton) {
            activeButton.classList.add('active');
        }

        // Обновляем чекбокс широкоэкранного режима
        const widescreenCheckbox = document.getElementById('widescreen-fix');
        if (widescreenCheckbox) {
            widescreenCheckbox.checked = activeMods.widescreen;
        }
    } catch (error) {
        console.error('Ошибка при обновлении кнопок графики:', error);
    }
}

// Handle graphics button click
async function handleGraphicsButtonClick(event) {
    if (!window.electronAPI) return;

    // Блокируем кнопку на время обработки
    event.target.disabled = true;

    try {
        // Определяем какой мод нужно установить
        let modName = null;
        if (event.target.id === 'graphics-medium') {
            modName = 'lowgraphics'; // Средние = lowgraphics
        } else if (event.target.id === 'graphics-high') {
            modName = 'highgraphics'; // Высокие = highgraphics
        }
        // Низкие = null (удаление мода)

        // Устанавливаем мод
        const result = await window.electronAPI.setGraphicsMod(modName);

        if (!result.success) {
            throw new Error(result.error || 'Не удалось установить мод');
        }

        // Обновляем UI
        await updateGraphicsButtons();

    } catch (error) {
        console.error('Ошибка установки графики:', error);
        alert(`Ошибка: ${error.message}`);
    } finally {
        event.target.disabled = false;
    }
}

// Handle check files button
function handleCheckFiles() {
    closeSettingsDialog();
    verifyFiles();
}

// Handle repair game button
function handleRepairGame() {
    if (!window.electronAPI) return;

    if (confirm('Удалить лишние файлы (не из client.json) и проверить все файлы игры по CDN?')) {
        closeSettingsDialog();
        verifyFiles({ repair: true });
    }
}

// Load settings
async function loadSettings() {
    if (!window.electronAPI) return;

    try {
        // Load installation path
        const { path, displayPath } = await window.electronAPI.getInstallationPath();
        const pathInput = document.getElementById('install-path');
        const pathToShow = displayPath || path;
        if (pathToShow && pathInput) {
            pathInput.value = pathToShow;
        }

        // Load memory allocation setting
        const memoryAllocation = await window.electronAPI.getMemoryAllocation();
        const ramButtons = document.querySelectorAll('.ram-button');
        ramButtons.forEach(button => {
            const buttonRam = button.id.split('-')[1];
            if (buttonRam === memoryAllocation) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });

        // Load graphics setting
        const activeMods = await window.electronAPI.getActiveMods();
        const graphicsButtons = document.querySelectorAll('.graphics-button');
        const widescreenCheckbox = document.getElementById('widescreen-fix');
        if (widescreenCheckbox) {
            widescreenCheckbox.checked = activeMods.widescreen;
        }

        // First, remove active class from all buttons
        graphicsButtons.forEach(button => {
            button.classList.remove('active');
        });

        // Map the mod names to the correct buttons according to requirements
        let activeButtonId = null;
        if (!activeMods.graphics) {
            // No graphics mod means "Низкие" (Low) is active
            activeButtonId = 'graphics-low';
        } else if (activeMods.graphics === 'lowgraphics') {
            // lowgraphics mod means "Средние" (Medium) is active
            activeButtonId = 'graphics-medium';
        } else if (activeMods.graphics === 'highgraphics') {
            // highgraphics mod means "Высокие" (High) is active
            activeButtonId = 'graphics-high';
        }

        // Set the active class on the correct button
        if (activeButtonId) {
            const activeButton = document.getElementById(activeButtonId);
            if (activeButton) {
                activeButton.classList.add('active');
            }
        }
    } catch (error) {
        console.error('Error loading settings:', error);
    }
}

// Initialize settings (call this on page load)
function initializeSettings() {
    // Hide settings dialog by default
    const settingsOverlay = document.querySelector('.settings-overlay');
    if (settingsOverlay) {
        settingsOverlay.style.display = 'none';
    }

    // Attach click handler to settings button
    const settingsButton = document.getElementById('settings-button');
    if (settingsButton) {
        settingsButton.addEventListener('click', showSettingsDialog);
    }
}

// Function to update mod buttons in settings dialog
function updateModButtons() {
    if (!window.electronAPI) return;

    window.electronAPI.getActiveMods().then(activeMods => {
        const lowButton = document.getElementById('graphics-low');
        const mediumButton = document.getElementById('graphics-medium');
        const highButton = document.getElementById('graphics-high');

        if (lowButton && mediumButton && highButton) {
            // Reset all buttons
            lowButton.classList.remove('active');
            mediumButton.classList.remove('active');
            highButton.classList.remove('active');

            // Apply active class based on current mod
            if (!activeMods.graphics) {
                // No graphics mod means "Низкие" (Low) is active
                lowButton.classList.add('active');
            } else if (activeMods.graphics === 'lowgraphics') {
                // lowgraphics mod means "Средние" (Medium) is active
                mediumButton.classList.add('active');
            } else if (activeMods.graphics === 'highgraphics') {
                // highgraphics mod means "Высокие" (High) is active
                highButton.classList.add('active');
            }

            const widescreenCheckbox = document.getElementById('widescreen-fix');
            if (widescreenCheckbox) {
                widescreenCheckbox.checked = activeMods.widescreen;
            }
        }
    }).catch(error => {
        console.error('Error updating mod buttons:', error);
    });
}

// Function to check if the game is running
function startGameProcessChecker() {
    if (!window.electronAPI) return;

    const playButton = document.getElementById('play-button');
    const playButtonText = document.getElementById('play-button-text');

    if (!playButton || !playButtonText) return;

    playButtonText.textContent = 'Игра запущена';

    // Check every 5 seconds if the game is still running
    checkInterval = setInterval(async () => {
        try {
            const isRunning = await window.electronAPI.checkGameRunning();

            if (!isRunning) {
                clearInterval(checkInterval);
                playButtonText.textContent = 'Запустить игру';
            }
        } catch (error) {
            console.error('Error checking game status:', error);
            clearInterval(checkInterval);
            playButtonText.textContent = 'Запустить игру';
        }
    }, 5000);
}

// Cleanup function to be called when the window is closing
function cleanup() {
    if (checkInterval) {
        clearInterval(checkInterval);
    }
}

// Add event listener for window unload
window.addEventListener('beforeunload', cleanup);