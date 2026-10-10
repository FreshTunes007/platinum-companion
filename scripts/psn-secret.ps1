param([ValidateSet('Context','Read','Write','Clear','ClipboardBootstrap','LegacyBootstrap','DeleteLegacy')][string]$Action,[string]$ExpectedSid,[string]$LegacyPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$storageDirectory=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PlatinumCompanion\Credentials'
$vaultPath=Join-Path $storageDirectory 'psn-refresh.dpapi'
$entropy=[Text.Encoding]::UTF8.GetBytes('Platinum Companion PSN refresh credential v2')
try{
  if($Action -eq 'Context'){
    @{userName=$identity.Name;userSid=$identity.User.Value;storageDirectory=$storageDirectory;configured=[IO.File]::Exists($vaultPath)}|ConvertTo-Json -Compress
    exit 0
  }
  if($identity.User.Value -ne $ExpectedSid){throw 'execution_context_mismatch'}
  if($Action -eq 'Write'){
    $body=[Console]::In.ReadToEnd();$payload=$body|ConvertFrom-Json
    if($payload.ownerSid -ne $ExpectedSid -or -not $payload.refreshToken -or $payload.npsso -or $payload.accessToken){throw 'invalid_refresh_payload'}
    $allowed=@('schemaVersion','ownerSid','accountKey','refreshToken','refreshExpiresAt','requiresUserReauth','lastSuccessfulAuth','lastSuccessfulTrophySync')
    foreach($property in $payload.PSObject.Properties.Name){if($property -notin $allowed){throw 'invalid_refresh_payload'}}
    [IO.Directory]::CreateDirectory($storageDirectory)|Out-Null
    $bytes=[Text.Encoding]::UTF8.GetBytes($body)
    $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $tempPath=Join-Path $storageDirectory ([Guid]::NewGuid().ToString()+'.tmp')
    [IO.File]::WriteAllBytes($tempPath,$protected)
    try{
      if([IO.File]::Exists($vaultPath)){[IO.File]::Replace($tempPath,$vaultPath,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($tempPath,$vaultPath)}
    }finally{if([IO.File]::Exists($tempPath)){[IO.File]::Delete($tempPath)}}
    [Array]::Clear($bytes,0,$bytes.Length);$body=$null;$payload=$null
    Write-Output '{"ok":true}'
  }elseif($Action -eq 'Read'){
    if(-not [IO.File]::Exists($vaultPath)){Write-Output 'null';exit 0}
    $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vaultPath),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    # A private child-process pipe into the owning Node process; never console logs.
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));[Array]::Clear($bytes,0,$bytes.Length)
  }elseif($Action -eq 'Clear'){
    if([IO.File]::Exists($vaultPath)){[IO.File]::Delete($vaultPath)}
    Write-Output '{"ok":true}'
  }elseif($Action -eq 'ClipboardBootstrap'){
    $secret=(Get-Clipboard -Raw).Trim();if($secret.StartsWith('{')){$secret=($secret|ConvertFrom-Json).npsso}
    if($secret -notmatch '^[A-Za-z0-9_-]{64}$'){throw 'clipboard_not_npsso'}
    @{npsso=$secret}|ConvertTo-Json -Compress;$secret=$null
  }elseif($Action -eq 'LegacyBootstrap' -or $Action -eq 'DeleteLegacy'){
    if(-not $LegacyPath -or [IO.Path]::GetFileName($LegacyPath) -ne 'psn-auth.dpapi'){throw 'invalid_legacy_path'}
    if($Action -eq 'DeleteLegacy'){if([IO.File]::Exists($LegacyPath)){[IO.File]::Delete($LegacyPath)};Write-Output '{"ok":true}'}
    else{
      $legacyEntropy=[Text.Encoding]::UTF8.GetBytes('Platinum Companion local PSN credential v1')
      $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($LegacyPath),$legacyEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      @{npsso=[Text.Encoding]::UTF8.GetString($bytes)}|ConvertTo-Json -Compress
      [Array]::Clear($bytes,0,$bytes.Length)
    }
  }
}catch{
  [Console]::Error.Write('credential_operation_failed');exit 2
}
