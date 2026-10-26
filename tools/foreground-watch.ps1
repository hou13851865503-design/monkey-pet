# Foreground fullscreen watcher.
# Prints "1" when the foreground window covers >=95% of its monitor, else "0".
# One line per ~1.2s. Read by the Electron main process.
$ErrorActionPreference = 'SilentlyContinue'

$src = @"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
}
"@
try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
} catch {
  # 无法编译 P/Invoke（被策略限制）：告诉主进程，让它停用防打扰
  Write-Output "ERR"
  exit 0
}

while ($true) {
  $full = 0
  try {
    $h = [FgWin]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $r = New-Object 'FgWin+RECT'
      if ([FgWin]::GetWindowRect($h, [ref]$r)) {
        $mon = [FgWin]::MonitorFromWindow($h, 2)
        $mi = New-Object 'FgWin+MONITORINFO'
        $mi.cbSize = 40
        if ([FgWin]::GetMonitorInfo($mon, [ref]$mi)) {
          $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
          $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
          $ww = $r.Right - $r.Left
          $wh = $r.Bottom - $r.Top
          if (($mw -gt 0) -and ($mh -gt 0)) {
            # 必须几乎盖满整个显示器（含任务栏区域）才算全屏。
            # 普通"最大化"窗口只到工作区（差一条任务栏），不会命中，避免误隐藏。
            if (($ww -ge ($mw - 2)) -and ($wh -ge ($mh - 2))) { $full = 1 }
          }
        }
      }
    }
  } catch { $full = 0 }
  Write-Output $full
  Start-Sleep -Milliseconds 1200
}
