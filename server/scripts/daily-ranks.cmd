@echo off
rem Ежедневный замер наших мест на карточках Kaspi и тревога по тому, что упало.
rem
rem Запускать С ЭТОГО компьютера, а не с сервера: публичный каталог Kaspi блокирует
rem адреса дата-центров (подробности в server/services/kaspiCatalog.js).
rem
rem Поставить в планировщик (выполнить один раз):
rem   schtasks /create /tn "ARTROOM zamer kartochek" /tr "D:\kaspi-app-orderds\server\scripts\daily-ranks.cmd" /sc daily /st 09:30
rem Снять:
rem   schtasks /delete /tn "ARTROOM zamer kartochek" /f
rem
rem Вывод каждого запуска дописывается в server\logs\card-ranks.log, а сам срез
rem ложится в базу - его показывает панель "Что изменилось на карточках" в "Продажах".
rem
rem Второй шаг - alert-card-drops.js - сравнивает срез со вчерашним и, если ходовая
rem позиция пропала с карточки, провалилась в выдаче или просто перестала продаваться,
rem показывает уведомление прямо на экране. Молчаливый замер уже стоил пяти дней
rem простоя шкафа IMPERIAL Алёна - это 760 тысяч тенге.
rem
rem Файл сохранён в кодировке cp866: cmd.exe читает .cmd в OEM-кодировке, и в UTF-8
rem кириллица в комментариях рассыпалась бы на несуществующие команды.

setlocal
cd /d "%~dp0.."

rem DATABASE_URL лежит только в .env.local склада - он смотрит на боевую базу.
rem В сам .cmd его не вписываем: файл попадает в git, а секретам там не место.
for /f "usebackq tokens=1,* delims==" %%a in ("..\production\warehouse-production-app\.env.local") do (
  if "%%a"=="DATABASE_URL" set "DATABASE_URL=%%b"
)
set DATABASE_URL=%DATABASE_URL:"=%

if not exist "logs" mkdir "logs"
echo.>> "logs\card-ranks.log"
echo ===== %date% %time% =====>> "logs\card-ranks.log"
node scripts\fetch-card-ranks.js --apply>> "logs\card-ranks.log" 2>&1

rem Тревога. Код выхода 1 означает "есть что показать", текст лежит в card-alert.txt.
node scripts\alert-card-drops.js>> "logs\card-ranks.log" 2>&1
if errorlevel 2 goto end
if errorlevel 1 goto alert
goto end

:alert
rem Текст тревоги читает сам PowerShell и обязательно как UTF-8: cmd.exe читал бы
rem файл в OEM-кодировке и показал бы кракозябры вместо названий.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'SilentlyContinue';" ^
  "$t = Get-Content 'logs/card-alert.txt' -Encoding UTF8;" ^
  "[void][reflection.assembly]::LoadWithPartialName('System.Windows.Forms');" ^
  "[void][reflection.assembly]::LoadWithPartialName('System.Drawing');" ^
  "$n = New-Object System.Windows.Forms.NotifyIcon;" ^
  "$n.Icon = [System.Drawing.SystemIcons]::Warning;" ^
  "$n.Visible = $true;" ^
  "$n.BalloonTipTitle = 'Kaspi: ' + $t[0];" ^
  "$n.BalloonTipText = $t[1];" ^
  "$n.ShowBalloonTip(30000);" ^
  "Start-Sleep -Seconds 12;" ^
  "$n.Dispose()"

:end
endlocal
