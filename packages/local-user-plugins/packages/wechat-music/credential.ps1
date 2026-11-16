param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$inputText=[Console]::In.ReadToEnd().Trim()
if($Mode -eq 'protect'){
  $plainBytes=[Text.Encoding]::UTF8.GetBytes($inputText)
  try{$sealed=[Security.Cryptography.ProtectedData]::Protect($plainBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write('userdpapi:'+ [Convert]::ToBase64String($sealed))}finally{[Array]::Clear($plainBytes,0,$plainBytes.Length)}
}else{
  if(-not $inputText.StartsWith('userdpapi:')){throw 'INVALID_PROTECTED_CREDENTIAL'}
  $plainBytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText.Substring(10)),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  try{[Console]::Write([Text.Encoding]::UTF8.GetString($plainBytes))}finally{[Array]::Clear($plainBytes,0,$plainBytes.Length)}
}
