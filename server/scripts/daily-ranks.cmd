@echo off
rem Ежедневный замер наших мест на карточках Kaspi.
rem
rem Запускать С ЭТОГО компьютера, а не с сервера: публичный каталог Kaspi блокирует
rem адреса дата-центров (подробности в server/services/kaspiCatalog.js).
rem
rem Поставить в планировщик (выполнить один раз):
rem   schtasks /create /tn "ARTROOM zamer kartochek" /tr "D:\kaspi-app-orderds\server\scripts\daily-ranks.cmd" /sc daily /st 09:00
rem Снять:
rem   schtasks /delete /tn "ARTROOM zamer kartochek" /f
rem
rem Вывод каждого запуска дописывается в server\logs\card-ranks.log, а сам срез
rem ложится в базу - его показывает панель "Что изменилось на карточках" в "Продажах".
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
endlocal
