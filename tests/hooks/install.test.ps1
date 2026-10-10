$ErrorActionPreference = 'Stop'
$errors = $null
$installer = Join-Path $PSScriptRoot '../../public/install/install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $installer), [ref]$null, [ref]$errors)
if ($errors) { throw "install.ps1 has $($errors.Count) parse errors" }
# Load function definitions without invoking the installer entry point.
$ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $false) | ForEach-Object { Invoke-Expression $_.Extent.Text }

function Invoke-RestMethod {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
    if ($TimeoutSec -ne 30) { throw 'Expected a bounded download' }
    if ($script:unavailable) { throw 'Network unavailable' }
    return $script:manifest
}
function Expect-RejectedManifest {
    $rejected = $false
    try { Get-VibeMonInstallerHash -DocsBaseUrl 'https://example.invalid' | Out-Null }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Unverifiable installer was accepted' }
}
$script:unavailable = $true
Expect-RejectedManifest
$script:unavailable = $false
foreach ($invalid in @($null, '', 'abc', ('g' * 64), 123)) {
    $script:manifest = @{ installer = $invalid }
    Expect-RejectedManifest
}
$script:manifest = @{ installer = 'ab' * 32 }
$hash = Get-VibeMonInstallerHash -DocsBaseUrl 'https://example.invalid'
if ($hash -cne ('AB' * 32)) { throw 'Valid installer hash was not preserved' }
Write-Host 'PASS PowerShell installer: unavailable/malformed manifests rejected, valid SHA-256 retained'
