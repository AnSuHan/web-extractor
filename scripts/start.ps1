# web-extractor 부트스트랩 (Windows)
#
# 사용자가 미리 설치해 둬야 하는 것이 없도록 한다.
# Node 가 시스템에 있으면 그걸 쓰고, 없으면 이 폴더 안의 .tools 에 내려받아 쓴다.
# 시스템 PATH 나 레지스트리는 건드리지 않는다.

# 콘솔 코드페이지가 cp949 여도 한글이 깨지지 않게 한다.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$NODE_VERSION = "v22.20.0"   # LTS
$toolsDir = Join-Path $root ".tools"
$nodeDir = Join-Path $toolsDir "node-$NODE_VERSION-win-x64"

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "      OK  $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "      $text" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  web-extractor" -ForegroundColor White

# ---------------------------------------------------------------- Node 확보

$nodeExe = $null

$systemNode = Get-Command node -ErrorAction SilentlyContinue
if ($systemNode) {
    $version = (& $systemNode.Source --version) 2>$null
    # Vite 7 은 Node 20.19+ 를 요구한다. 그보다 낮으면 휴대용 Node 를 쓴다.
    $major = 0
    if ($version -match '^v(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 20) {
        $nodeExe = $systemNode.Source
        Write-Step "Node 확인"
        Write-Ok "$version (시스템에 설치된 것을 씁니다)"
    }
    else {
        Write-Step "Node 확인"
        Write-Note "$version 은 너무 낮습니다. 휴대용 Node 를 씁니다."
    }
}

if (-not $nodeExe) {
    $portable = Join-Path $nodeDir "node.exe"
    if (Test-Path $portable) {
        $nodeExe = $portable
        Write-Step "Node 확인"
        Write-Ok "$NODE_VERSION (이 폴더 안의 휴대용 Node)"
    }
    else {
        Write-Step "Node 내려받기 (시스템에는 설치하지 않습니다)"
        $zipName = "node-$NODE_VERSION-win-x64.zip"
        $url = "https://nodejs.org/dist/$NODE_VERSION/$zipName"
        $zipPath = Join-Path $toolsDir $zipName

        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        Write-Note $url
        try {
            $ProgressPreference = "SilentlyContinue"
            Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
            Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
            Remove-Item $zipPath -Force
        }
        catch {
            Write-Host ""
            Write-Host "  Node 를 내려받지 못했습니다: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "  네트워크를 확인하시거나, https://nodejs.org 에서 LTS 를 설치한 뒤 다시 실행해 주세요." -ForegroundColor Red
            exit 1
        }
        $nodeExe = $portable
        if (-not (Test-Path $nodeExe)) {
            Write-Host "  압축을 풀었지만 node.exe 를 찾지 못했습니다: $nodeDir" -ForegroundColor Red
            exit 1
        }
        Write-Ok "준비 완료"
    }
}

# 이 프로세스 안에서만 PATH 앞에 Node 를 붙인다 (npm 이 같은 Node 를 쓰도록).
$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"

# ---------------------------------------------------------------- 실행

& $nodeExe (Join-Path $root "scripts\launch.mjs")
exit $LASTEXITCODE
