$ErrorActionPreference = 'Stop'

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [Convert]::FromBase64String($env:WINDOWS_CERTS),
  $env:WINDOWS_CERTS_PASSWORD,
  [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
try {
  $installers = @(Get-ChildItem dist -Filter *.exe)
  if ($installers.Count -ne 2) { throw 'Expected NSIS and portable Windows packages' }
  foreach ($installer in $installers) {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
    if ($signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
      throw "Configured signer does not match $($installer.Name)"
    }
    Write-Host "$($installer.Name): Windows trust status=$($signature.Status); signer matches configured certificate"
  }
  $publicBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($publicBytes, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
  [IO.File]::WriteAllText((Join-Path $PWD 'dist/signing-certificate.pem'), $pem)
} finally {
  $certificate.Dispose()
}
