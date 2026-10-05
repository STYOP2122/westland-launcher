# Westland RP Launcher

Лаунчер для игрового проекта Westland RP на Electron. Загружает файлы клиента, проверяет их SHA256-хеши, сохраняет настройки игрока и запускает игру. Обновления самого лаунчера выполняются через electron-updater.

## Технологии

Electron, JavaScript, Node.js и electron-builder. Запуск игрового клиента и работа с реестром ориентированы на Windows.

## Подготовка

- Установите Node.js, npm и инструменты сборки нативных модулей: Python и Visual Studio Build Tools с C++.
- Проверьте настройки файлового сервера в `main.js`: `GAME_FILES_BASE_URL` и `LAUNCHER_CONFIG_URL`.
- Для запуска клиента используется `native/samp-injector.exe`.
- Настройки обновлений и упаковки находятся в `package.json` и `electron-builder.yml`.

## Запуск и сборка

```bash
git clone https://github.com/STYOP2122/westland-launcher.git
cd westland-launcher
npm install
npm start
```

В `package.json` установка запускает `node-gyp rebuild`. Если установка останавливается из-за отсутствующей конфигурации нативного модуля, этот шаг требует отдельной настройки под вашу среду.

```bash
npm run build
```

Сборка выполняется через electron-builder. Для работы загрузки игровых файлов нужен доступный файловый сервер с ожидаемыми конфигурацией и манифестом.

## Структура

- `main.js` — окно, загрузка и проверка файлов, настройки и обновления.
- `preload.js` — взаимодействие интерфейса с основным процессом.
- `renderer.js` и `index.html` — интерфейс.
- `samp-injector-launcher.js` — запуск игрового клиента.
- `native/` — вспомогательная программа запуска.
