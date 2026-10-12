$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try { $request = [Console]::In.ReadToEnd() | ConvertFrom-Json }
catch { [Console]::Error.WriteLine('Invalid native launch request.'); exit 1 }
$launcherSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class DafeiyuDesktopLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int cb;
        public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(c); slashes = 0;
        }
        text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    public static int Launch(int desktopPid, string desktopExecutable, int parentPid, string parentExecutable, string executable,
        string[] args, string cwd, Dictionary<string, string> environment) {
        // The desktop's native app-server job is inherited, never the temporary MCP job.
        // The unpackaged native host also preserves the plugin's existing user data paths.
        // No MCP pipe or temporary transport handle is inherited by the GUI.
        IntPtr parent = OpenProcess(0x1080, false, parentPid);
        if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr desktop = IntPtr.Zero, list = IntPtr.Zero, parentValue = IntPtr.Zero, environmentBlock = IntPtr.Zero;
        bool initialized = false;
        try {
            var parentPath = new StringBuilder(32768); int pathSize = parentPath.Capacity;
            if (!QueryFullProcessImageName(parent, 0, parentPath, ref pathSize))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!String.Equals(parentPath.ToString(), parentExecutable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Codex native host identity changed before launch.");
            desktop = OpenProcess(0x1000, false, desktopPid);
            if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var desktopPath = new StringBuilder(32768); int desktopPathSize = desktopPath.Capacity;
            if (!QueryFullProcessImageName(desktop, 0, desktopPath, ref desktopPathSize))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!String.Equals(desktopPath.ToString(), desktopExecutable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Codex desktop identity changed before launch.");
            IntPtr bytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
            list = Marshal.AllocHGlobal(bytes);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref bytes))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            initialized = true;
            parentValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(parentValue, parent);
            if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20000), parentValue,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var names = new List<string>(environment.Keys); names.Sort(StringComparer.OrdinalIgnoreCase);
            var block = new StringBuilder();
            foreach (string name in names) {
                string value = environment[name];
                if (name.IndexOf('=') >= 0 || name.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0)
                    throw new ArgumentException("Invalid environment variable.");
                block.Append(name).Append('=').Append(value).Append('\0');
            }
            block.Append('\0'); environmentBlock = Marshal.StringToHGlobalUni(block.ToString());
            var command = new StringBuilder(Quote(executable));
            foreach (string arg in args) command.Append(' ').Append(Quote(arg));
            var startup = new StartupInfoEx(); startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.attributes = list; ProcessInfo process;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
                0x08080400, environmentBlock, cwd, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            try { return (int)process.pid; }
            finally { CloseHandle(process.thread); CloseHandle(process.process); }
        } finally {
            if (initialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (parentValue != IntPtr.Zero) Marshal.FreeHGlobal(parentValue);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            if (desktop != IntPtr.Zero) CloseHandle(desktop);
            CloseHandle(parent);
        }
    }
}
'@

$cacheDirectory = [string]$request.cacheDirectory
if ($cacheDirectory) {
    try {
        New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($launcherSource + [Environment]::Version.ToString()))).Replace('-', '').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        $assembly = Join-Path $cacheDirectory ('desktop-launcher-' + $digest + '.dll')
        if (Test-Path -LiteralPath $assembly) { Add-Type -Path $assembly }
        else {
            $temporaryAssembly = Join-Path $cacheDirectory ('desktop-launcher-' + [Guid]::NewGuid().ToString('N') + '.dll')
            Add-Type -TypeDefinition $launcherSource -OutputAssembly $temporaryAssembly
            try { Move-Item -LiteralPath $temporaryAssembly -Destination $assembly -ErrorAction Stop }
            catch { Remove-Item -LiteralPath $temporaryAssembly -ErrorAction SilentlyContinue }
            if (-not ('DafeiyuDesktopLauncher' -as [type])) { Add-Type -Path $assembly }
        }
    } catch { }
}
if (-not ('DafeiyuDesktopLauncher' -as [type])) { Add-Type -TypeDefinition $launcherSource }
$launchEnvironment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($property in $request.environment.PSObject.Properties) { $launchEnvironment[$property.Name] = [string]$property.Value }
$petProcessId = [DafeiyuDesktopLauncher]::Launch([int]$request.desktopPid, [string]$request.desktopExecutable,
    [int]$request.parentPid, [string]$request.parentExecutable, [string]$request.executable,
    [string[]]$request.args, [string]$request.cwd, $launchEnvironment)
@{ pid=$petProcessId; desktopPid=[int]$request.desktopPid; parentPid=[int]$request.parentPid } | ConvertTo-Json -Compress
