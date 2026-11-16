# AIPal 永久语音识别助手（本机离线，无需网络与 Key）
# 协议：stdin 每行一条命令
#   PING            -> {"ok":true,"pong":true}
#   <base64 wav>    -> {"ok":true,"text":"...","conf":0.8}
#   空行退出
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('zh-CN')
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.InitialSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
  $engine.BabbleTimeout = [TimeSpan]::FromMilliseconds(1500)
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(300)
} catch {
  $o = @{ ok = $false; fatal = $true; error = $_.Exception.Message }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  exit 1
}

[Console]::Out.WriteLine('{"ok":true,"ready":true}')

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { break }
  if ($line -eq 'PING') {
    [Console]::Out.WriteLine('{"ok":true,"pong":true}')
    continue
  }
  $ms = $null
  try {
    $bytes = [Convert]::FromBase64String($line)
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $engine.SetInputToWaveStream($ms)
    $r = $engine.Recognize()
    if ($r) {
      $o = @{ ok = $true; text = [string]$r.Text; conf = [double]$r.Confidence }
    } else {
      $o = @{ ok = $true; text = ''; conf = 0 }
    }
  } catch {
    $o = @{ ok = $false; error = $_.Exception.Message }
  } finally {
    if ($ms) { try { $ms.Dispose() } catch {} }
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
}