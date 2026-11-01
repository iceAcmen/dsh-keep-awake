param([int]$Display = 1)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshAwake
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS        = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED   = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED  = 0x00000002;

    // Persistent request: stays in force for this thread's lifetime.
    public static uint Hold(bool display)
    {
        uint f = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        if (display) f |= ES_DISPLAY_REQUIRED;
        return SetThreadExecutionState(f);
    }

    // One-shot idle-timer reset; does not change the continuous state.
    public static uint Ping(bool display)
    {
        uint f = ES_SYSTEM_REQUIRED;
        if (display) f |= ES_DISPLAY_REQUIRED;
        return SetThreadExecutionState(f);
    }
}
'@

# Exit 2 tells the plugin the request was refused outright (e.g. unsupported).
if ([DshAwake]::Hold($Display -ne 0) -eq 0) { exit 2 }

# Re-assert periodically so power-policy churn cannot silently drop the hold.
while ($true) {
    Start-Sleep -Seconds 15
    [void][DshAwake]::Ping($Display -ne 0)
}
