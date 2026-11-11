# 鸿蒙（HarmonyOS NEXT）命令行构建脚本
#
# 用法：
#   pwsh -File tools/harmony/build.ps1                  # 构建 debug 签名 HAP
#   pwsh -File tools/harmony/build.ps1 -Mode release    # 构建 release
#   pwsh -File tools/harmony/build.ps1 -Task clean      # 清理
#
# 依赖（见 docs/build.md「鸿蒙端」）：
#   - .tools/harmony/sdk-7.0/             HarmonyOS SDK（DEVECO_SDK_HOME 指向这里）
#   - apps/harmonyos/node_modules/@ohos/  hvigor 与 hvigor-ohos-plugin（手工复制，npm 源无此包）
#   - apps/harmonyos/signing/             本地签名材料（gen-sign-material.cjs 生成）
param(
    [ValidateSet('debug', 'release')]
    [string]$Mode = 'debug',
    [string]$Task = 'assembleHap',
    [switch]$NoDaemon
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Join-Path $repo 'apps\harmonyos'
$sdk = Join-Path $repo '.tools\harmony\sdk-7.0'

if (-not (Test-Path $sdk)) {
    throw "未找到 HarmonyOS SDK：$sdk（见 docs/build.md 的安装步骤）"
}
if (-not (Test-Path (Join-Path $project 'node_modules\@ohos\hvigor\bin\hvigor.js'))) {
    throw "未找到 hvigor：$project\node_modules\@ohos\hvigor（见 docs/build.md 的装配步骤）"
}

$env:DEVECO_SDK_HOME = $sdk
Push-Location $project
try {
    $args = @('node_modules\@ohos\hvigor\bin\hvigor.js', $Task, '-p', "buildMode=$Mode")
    if ($NoDaemon -or $true) { $args += '--no-daemon' }
    & node @args
    if ($LASTEXITCODE -ne 0) { throw "hvigor 构建失败（exit $LASTEXITCODE）" }
}
finally {
    Pop-Location
}

$out = Join-Path $project 'entry\build\default\outputs\default'
Get-ChildItem $out -Filter '*.hap' -ErrorAction SilentlyContinue |
    ForEach-Object { "{0}  {1:N0} 字节" -f $_.Name, $_.Length }
