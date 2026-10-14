@echo off
rem Еженедельный отчёт за прошлую неделю (пн-вс). Запускать по понедельникам утром,
rem после того как отработает замер мест - он даёт срез последнего дня недели.
rem
rem Поставить в планировщик (выполнить один раз):
rem   schtasks /create /tn "ARTROOM nedelnyy otchet" /tr "D:\kaspi-app-orderds\server\scripts\weekly-report.cmd" /sc weekly /d MON /st 10:00
rem Снять:
rem   schtasks /delete /tn "ARTROOM nedelnyy otchet" /f
rem
rem Отчёт ложится в server\reports\nedelya-ГГГГ-ММ-ДД.html и сразу открывается
rem в браузере. Текстовую версию дописываем в logs\weekly-report.log.
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
echo.>> "logs\weekly-report.log"
echo ===== %date% %time% =====>> "logs\weekly-report.log"
node scripts\weekly-report.js>> "logs\weekly-report.log" 2>&1
if errorlevel 1 goto end

rem Открыть свежий отчёт: самый новый файл в reports.
for /f "delims=" %%f in ('dir /b /o-d "reports\nedelya-*.html"') do (
  start "" "reports\%%f"
  goto end
)

:end
endlocal
