param(
    [Parameter(Mandatory=$true)][long]$WindowHandle,
    [Parameter(Mandatory=$true)][ValidateSet('true','false','inspect')][string]$Topmost
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PetWindowInterop {
    [DllImport("user32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hwnd);
}
'@
$handle = [IntPtr]::new($WindowHandle)
if ($Topmost -ne 'inspect') {
    $order = if ($Topmost -eq 'true') { [IntPtr]::new(-1) } else { [IntPtr]::new(-2) }
    # Only changes this app's window ordering; no activation, movement, or resizing.
    if (-not [PetWindowInterop]::SetWindowPos($handle, $order, 0, 0, 0, 0, 0x213)) {
        throw 'Could not update desktop pet window ordering.'
    }
}
$style = [PetWindowInterop]::GetWindowLongPtr($handle, -20).ToInt64()
@{ topmost = (($style -band 8) -ne 0); clickThrough = (($style -band 0x20) -ne 0);
   visible = [PetWindowInterop]::IsWindowVisible($handle);
   owner = [PetWindowInterop]::GetWindowLongPtr($handle, -8).ToInt64().ToString()
} | ConvertTo-Json -Compress
