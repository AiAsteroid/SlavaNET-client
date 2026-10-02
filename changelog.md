## 1.0.0

Первая версия SlavaNET — форк Koala Clash 1.4.1 под нашим именем.

- одношаговое подключение подписки через Telegram вместо круга по браузеру
- личный кабинет внутри клиента: баланс, устройства, докупка, переименование
- свой протокол ссылок slavanet:// и свой идентификатор пакета
- обновления с наших релизов, а не с upstream
- переделанный интерфейс: нижняя капсула вместо боковой панели, список
  серверов сразу на главной, квадратные флаги вместо эмодзи
- тёмная тема «Ступень светлее», единый стиль всех экранов

Ядро, маршрутизация и TUN — как в Koala Clash, они не менялись.

## 1.4.1

- hotfix

## 1.4.0

- fixed bug with proxy providers
- added new headers: expand-proxy-groups, profile-web-page-name
- minor ui fixes
- added alert about expiring subscription
- new bugs :)

## 1.3.1

- fixed system proxy
- fixed bug from issue #89

## 1.3.0

- new update notifier
- improved ui on proxies page
- added default values for route-exclude-address
- added headers for hiding global mode and downloading custom css
- added yaml view in rules editor
- improved hwid (for Remnawave v2.8.0)
- fix setup public dns on macos
- added translations in monaco editor
- fixed ui for overrided GLOBAL selector



## 1.2.0

- reduced memory usage
- fix problem with deeplink alert after restart with autostart enabled
- implement hot reloading config
- fix bug with adding a rule at the end
- fixed an issue with retrieving data via a proxy
- fixed an issue with profile updates (please test)
- ui fixes
- other optimizations
