# Выкладка сайта на арендованный сервер. Запускать из папки проекта:
#   .\deploy.ps1 -Server root@1.2.3.4
# Первый запуск ставит всё нужное на сервер, следующие — обновляют сайт. База на сервере не трогается.
param(
  [Parameter(Mandatory = $true)][string]$Server
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .env.production)) { throw 'Нет файла .env.production — заполните его (см. README.md).' }
$baseUrl = (Get-Content .env.production -Encoding UTF8 | Where-Object { $_ -match '^BASE_URL=' }) -replace '^BASE_URL=', ''
if ($baseUrl -notmatch '^https://([^/]+)$' -or $baseUrl -match 'ВАШ-ДОМЕН') { throw "В .env.production укажите BASE_URL вида https://farm.example.com (сейчас: '$baseUrl')." }
$domain = $Matches[1]
foreach ($key in 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'OWNER_DISCORD_IDS') {
  if (-not (Get-Content .env.production -Encoding UTF8 | Where-Object { $_ -match "^$key=.+" })) { Write-Warning "$key в .env.production пустой — вход через Discord не заработает." }
}

$ssh = @('-o', 'StrictHostKeyChecking=accept-new')
Write-Host "==> Загрузка файлов на $Server"
ssh @ssh $Server 'mkdir -p /opt/farm-otdel'
scp @ssh -r -q server public deploy package.json package-lock.json "${Server}:/opt/farm-otdel/"
scp @ssh -q .env.production "${Server}:/opt/farm-otdel/.env"

Write-Host "==> Установка и перезапуск ($domain)"
ssh @ssh $Server "sed -i 's/\r$//' /opt/farm-otdel/deploy/*.sh /opt/farm-otdel/.env && bash /opt/farm-otdel/deploy/setup.sh $domain"
if ($LASTEXITCODE -ne 0) { throw 'Установка на сервере завершилась с ошибкой — см. вывод выше.' }

Write-Host ''
Write-Host "Сайт: https://$domain"
Write-Host "Redirect в Discord Developer Portal: https://$domain/auth/discord/callback"
