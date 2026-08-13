# Gives the loopback UI a certificate the desktop widget's policy will accept.
#
# The Codex desktop host allows `https:` subframes and refuses plain http ones, so embedding the
# real page requires TLS on 127.0.0.1. The certificate created here is a self-signed leaf: it
# vouches for 127.0.0.1 and localhost and for nothing else, so trusting it cannot be turned into
# trust for any real site. Removing it is one flag away.
[CmdletBinding()]
param(
  [switch]$Remove,
  [switch]$Status,
  # Creates and installs the certificate for the server but skips the trust prompt, so the whole
  # setup can be inspected before deciding.
  [switch]$NoTrust,
  # A self-signed leaf is the safe shape. Some Chromium builds only accept a trust anchor that is
  # marked as a CA; this is the escape hatch, and it widens what the private key could sign.
  [switch]$AsCa
)

$ErrorActionPreference = 'Stop'
$subject = 'CN=LLM Task Tree Local UI'
$tlsDir = Join-Path $env:LOCALAPPDATA 'LLMTaskTree\tls'
$pfxFile = Join-Path $tlsDir 'local.pfx'
$metaFile = Join-Path $tlsDir 'local.json'
$cerFile = Join-Path $tlsDir 'local.cer'

function Get-LocalCerts {
  @(Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $subject })
}

if ($Status) {
  $found = Get-LocalCerts
  [pscustomobject]@{
    certificates = $found.Count
    thumbprints  = @($found | ForEach-Object { $_.Thumbprint } | Sort-Object -Unique)
    trusted      = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
                     Where-Object { $_.Subject -eq $subject }).Count -gt 0
    pfx          = (Test-Path $pfxFile)
  } | ConvertTo-Json
  return
}

if ($Remove) {
  foreach ($cert in Get-LocalCerts) {
    Remove-Item -Path $cert.PSPath -Force -ErrorAction SilentlyContinue
  }
  foreach ($file in @($pfxFile, $metaFile, $cerFile)) {
    if (Test-Path $file) { Remove-Item $file -Force }
  }
  Write-Output '已移除本地 HTTPS 证书；服务重启后回到纯 http。'
  return
}

New-Item -ItemType Directory -Force -Path $tlsDir | Out-Null

# An IP address has to appear as an IP SAN; Chromium ignores the subject CN and will not accept
# 127.0.0.1 spelled as a DNS name.
$extensions = @(
  '2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1',
  '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
)
if ($AsCa) { $extensions += '2.5.29.19={critical}{text}CA=true' }

foreach ($old in Get-LocalCerts) { Remove-Item -Path $old.PSPath -Force -ErrorAction SilentlyContinue }

$cert = New-SelfSignedCertificate `
  -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(2) `
  -TextExtension $extensions

$password = [System.Guid]::NewGuid().ToString('N')
$secure = ConvertTo-SecureString -String $password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxFile -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cerFile -Type CERT | Out-Null

[pscustomobject]@{
  passphrase = $password
  thumbprint = $cert.Thumbprint
  notAfter   = $cert.NotAfter.ToString('o')
  subject    = $subject
} | ConvertTo-Json | Set-Content -Path $metaFile -Encoding UTF8

# Trust is granted by running this script, so the store is written directly rather than through the
# import wizard: a modal dialog nobody is watching would just hang an unattended run. Only the
# public certificate goes into Root; the private key stays in the personal store.
if (-not $NoTrust) {
  $public = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cerFile
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store 'Root', 'CurrentUser'
  $store.Open('ReadWrite')
  $store.Add($public)
  $store.Close()
}

[pscustomobject]@{
  thumbprint = $cert.Thumbprint
  notAfter   = $cert.NotAfter.ToString('o')
  pfx        = $pfxFile
  trusted    = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq $subject }).Count -gt 0
} | ConvertTo-Json
