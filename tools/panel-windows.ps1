# List top-level windows owned by a process id (ASCII only).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File panel-windows.ps1 -ProcessId 1234
param([int]$ProcessId = 0)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class W {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    public static List<string> List(uint want) {
        List<string> rows = new List<string>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (want != 0 && pid != want) return true;
            RECT r; GetWindowRect(hWnd, out r);
            StringBuilder sb = new StringBuilder(256);
            GetWindowTextW(hWnd, sb, sb.Capacity);
            int ex = GetWindowLong(hWnd, -20);
            bool topmost = (ex & 0x8) != 0;
            bool transparent = (ex & 0x20) != 0;
            bool toolwindow = (ex & 0x80) != 0;
            bool noactivate = (ex & 0x08000000) != 0;
            rows.Add(string.Format("pid={0} hwnd=0x{1:X} visible={2} topmost={3} clickthrough={4} toolwindow={5} noactivate={6} rect={7},{8},{9},{10} title={11}",
                pid, hWnd.ToInt64(), IsWindowVisible(hWnd), topmost, transparent, toolwindow, noactivate, r.L, r.T, r.R, r.B, sb.ToString()));
            return true;
        }, IntPtr.Zero);
        return rows;
    }
}
"@ -Language CSharp

$rows = [W]::List([uint32]$ProcessId)
if ($rows.Count -eq 0) { "no windows for pid $ProcessId" } else { $rows }
