# 前台窗口监视：常驻进程，默认每 3 秒输出一行 JSON
# 输出：{"proc":"game.exe","title":"窗口标题","pid":1234,"fullscreen":false}
param([int]$Interval = 3000)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AIPalFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

while ($true) {
  $out = '{"proc":"","title":"","pid":0,"fullscreen":false}'
  try {
    $h = [AIPalFG]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $procId = 0
      [void][AIPalFG]::GetWindowThreadProcessId($h, [ref]$procId)
      $len = [AIPalFG]::GetWindowTextLength($h)
      $sb = New-Object System.Text.StringBuilder ([Math]::Max($len + 2, 2))
      [void][AIPalFG]::GetWindowText($h, $sb, $sb.Capacity)
      $procName = ''
      try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName + '.exe' } catch { $procName = '' }
      $rect = New-Object AIPalFG+RECT
      $fullscreen = $false
      if ([AIPalFG]::GetWindowRect($h, [ref]$rect)) {
        $w = $rect.Right - $rect.Left
        $hgt = $rect.Bottom - $rect.Top
        if ($w -ge 1920 -and $hgt -ge 1080 -and $rect.Left -le 0 -and $rect.Top -le 0) { $fullscreen = $true }
      }
      $o = @{ proc = $procName; title = [string]$sb.ToString(); pid = $procId; fullscreen = $fullscreen }
      $out = ($o | ConvertTo-Json -Compress)
    }
  } catch {}
  [Console]::Out.WriteLine($out)
  Start-Sleep -Milliseconds $Interval
}