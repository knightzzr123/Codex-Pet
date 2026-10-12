param([long]$WindowHandle = 0, [switch]$Once, [long]$ProbeTarget = 0, [switch]$Diagnose, [string]$CacheDirectory)
$ErrorActionPreference = 'Stop'
$scopeTypeDefinition = @'
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class CodexWindowScope {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    delegate bool EnumWindowCallback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)]
    static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    static readonly Dictionary<uint, bool> Eligible = new Dictionary<uint, bool>();

    static bool IsCodex(IntPtr hwnd) {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        bool eligible;
        if (Eligible.TryGetValue(pid, out eligible)) return eligible;
        eligible = false;
        try {
            using (var process = Process.GetProcessById((int)pid)) {
                string file = process.MainModule.FileName;
                bool storeApp = file.IndexOf("\\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0;
                bool desktopApp = file.IndexOf("\\OpenAI\\Codex\\", StringComparison.OrdinalIgnoreCase) >= 0
                    && file.IndexOf("\\bin\\", StringComparison.OrdinalIgnoreCase) < 0;
                eligible = storeApp || desktopApp;
            }
        } catch { return false; }
        Eligible[pid] = eligible;
        return eligible;
    }
    static bool IsOverlayWindow(IntPtr hwnd, IntPtr overlay) {
        if (hwnd == IntPtr.Zero || overlay == IntPtr.Zero) return false;
        uint foregroundPid, overlayPid;
        GetWindowThreadProcessId(hwnd, out foregroundPid);
        GetWindowThreadProcessId(overlay, out overlayPid);
        return overlayPid != 0 && foregroundPid == overlayPid;
    }
    static bool IsCodexContentWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || !IsCodex(hwnd)) return false;
        Rect rect;
        // Tooltips and transient Chromium helper windows share Codex's PID.
        // They cannot own a desktop pet or replace the actual content window.
        return GetClientRect(hwnd, out rect) && rect.Right - rect.Left >= 240 && rect.Bottom - rect.Top >= 180;
    }
    static IntPtr ResolveTarget(IntPtr foreground, IntPtr overlay, IntPtr lastCodex) {
        IntPtr current = GetAncestor(foreground, 3);
        if (IsCodexContentWindow(current)) return current;
        // Keep following the same Codex window while another app is foreground.
        // Its explicit owner also handles focus on frameless Electron windows.
        IntPtr owner = overlay != IntPtr.Zero ? GetWindowLongPtr(overlay, -8) : IntPtr.Zero;
        if (IsCodexContentWindow(owner)) return owner;
        if (IsCodexContentWindow(lastCodex)) return lastCodex;
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, data) => {
            if (IsWindowVisible(hwnd) && IsCodexContentWindow(hwnd)) {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static string Probe(long foregroundRaw, long overlayRaw) {
        IntPtr foreground = new IntPtr(foregroundRaw), overlay = new IntPtr(overlayRaw);
        IntPtr target = ResolveTarget(foreground, overlay, IntPtr.Zero);
        return "{\"foreground\":\"" + foreground.ToInt64()
            + "\",\"foregroundIsPet\":" + (IsOverlayWindow(foreground, overlay) ? "true" : "false")
            + ",\"target\":\"" + target.ToInt64()
            + "\",\"eligible\":" + (target != IntPtr.Zero && IsCodex(target) ? "true" : "false") + "}";
    }
    public static string Diagnose(long raw) {
        IntPtr hwnd = new IntPtr(raw); IntPtr owner = GetAncestor(hwnd, 3);
        return "hwnd=" + hwnd + "; eligible=" + IsCodex(hwnd) + "; visible=" + IsWindowVisible(hwnd)
            + "; minimized=" + IsIconic(hwnd) + "; rootOwner=" + owner + "; ownerVisible=" + IsWindowVisible(owner)
            + "; ownerEligible=" + IsCodex(owner);
    }
    public static void Run(long rawHandle, bool once, long probeTarget) {
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        var overlay = new IntPtr(rawHandle);
        IntPtr lastCodex = IntPtr.Zero;
        string previous = null;
        var heartbeat = Stopwatch.StartNew();
        do {
            IntPtr foreground = once && probeTarget != 0 ? new IntPtr(probeTarget) : GetForegroundWindow();
            bool foregroundIsPet = IsOverlayWindow(foreground, overlay);
            IntPtr target = ResolveTarget(foreground, overlay, lastCodex);
            bool targetExists = target != IntPtr.Zero && IsWindow(target) && IsCodex(target);
            bool bound = true;
            if (targetExists) {
                lastCodex = target;
                if (overlay != IntPtr.Zero) {
                    if (GetWindowLongPtr(overlay, -8) != target) SetWindowLongPtr(overlay, -8, target);
                    bound = GetWindowLongPtr(overlay, -8) == target;
                }
            }
            Rect rect = new Rect(); Point origin = new Point();
            bool visible = targetExists && IsWindowVisible(target);
            bool minimized = targetExists && IsIconic(target);
            bool active = visible && !minimized && GetClientRect(target, out rect)
                && ClientToScreen(target, ref origin) && rect.Right > rect.Left && rect.Bottom > rect.Top;
            uint codexPid = 0;
            if (targetExists) GetWindowThreadProcessId(target, out codexPid);
            string reason = active ? "visible" : !targetExists ? "closed" : minimized ? "minimized" : !visible ? "hidden" : "geometry-unavailable";
            string payload = "{\"active\":" + (active ? "true" : "false")
                + ",\"targetExists\":" + (targetExists ? "true" : "false")
                + ",\"codexPid\":" + codexPid + ",\"reason\":\"" + reason + "\""
                + ",\"hwnd\":\"" + target.ToInt64() + "\",\"ownerBound\":" + (bound && targetExists ? "true" : "false");
            if (active) {
                payload += ",\"foreground\":\"" + foreground.ToInt64()
                    + "\",\"foregroundIsPet\":" + (foregroundIsPet ? "true" : "false")
                    + ",\"foregroundIsCodex\":" + (IsCodex(GetAncestor(foreground, 3)) ? "true" : "false")
                    + ",\"rect\":{\"x\":" + origin.X + ",\"y\":" + origin.Y
                    + ",\"width\":" + (rect.Right - rect.Left) + ",\"height\":" + (rect.Bottom - rect.Top) + "}}";
            } else {
                payload += "}";
                if (reason != "geometry-unavailable" && overlay != IntPtr.Zero && IsWindowVisible(overlay)) {
                // Other foreground apps do not hide the pet. Hide only when
                // the tracked Codex window is closed, hidden, or minimized.
                    ShowWindow(overlay, 0);
                }
            }
            if (payload != previous || heartbeat.ElapsedMilliseconds >= 1000 || once) {
                Console.WriteLine(payload); Console.Out.Flush(); previous = payload; heartbeat.Restart();
            }
            if (once) return;
            Thread.Sleep(75);
        } while (IsWindow(overlay));
    }
}
'@
if ($CacheDirectory) {
    $temporaryAssembly = $null
    try {
        $nativeCache = [IO.Path]::GetFullPath($CacheDirectory)
        New-Item -ItemType Directory -Path $nativeCache -Force | Out-Null
        $hash = [Security.Cryptography.SHA256]::Create()
        try {
            $sourceKey = $scopeTypeDefinition + [Environment]::Version.ToString() + $PSVersionTable.PSVersion.Major
            $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($sourceKey))).Replace('-', '').ToLowerInvariant()
        } finally { $hash.Dispose() }
        $assembly = Join-Path $nativeCache ('codex-scope-' + $digest + '.dll')
        if (Test-Path -LiteralPath $assembly) { Add-Type -Path $assembly }
        else {
            $temporaryAssembly = Join-Path $nativeCache ('codex-scope-' + [Guid]::NewGuid().ToString('N') + '.dll')
            Add-Type -TypeDefinition $scopeTypeDefinition -OutputAssembly $temporaryAssembly
            if (-not ('CodexWindowScope' -as [type])) { Add-Type -Path $temporaryAssembly }
            if (-not (Test-Path -LiteralPath $assembly)) { [IO.File]::Move($temporaryAssembly, $assembly) }
        }
    } catch {
        # Cache problems cannot prevent the native window binding from working.
    } finally {
        if ($temporaryAssembly -and (Test-Path -LiteralPath $temporaryAssembly)) { Remove-Item -LiteralPath $temporaryAssembly -Force }
    }
}
if (-not ('CodexWindowScope' -as [type])) { Add-Type -TypeDefinition $scopeTypeDefinition }
if ($Diagnose) { [CodexWindowScope]::Diagnose($ProbeTarget) }
else { [CodexWindowScope]::Run($WindowHandle, $Once.IsPresent, $ProbeTarget) }
