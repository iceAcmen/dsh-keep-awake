# hold.ps1 —— 真正持有电源请求的子进程
#
# 由 dsh-keep-awake 插件以 powershell.exe -File 方式启动，
# 每 15 秒重申一次请求，直到进程被杀死为止。进程一死，请求立即消失。
#
# 参数 -Display：1 表示同时防息屏（DISPLAY + SYSTEM），0 表示只防睡眠（仅 SYSTEM）。

param([int]$Display = 1)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public class DshAwake
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS        = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED   = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED  = 0x00000002;

    public static uint Hold(bool display)
    {
        uint f = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        if (display) f |= ES_DISPLAY_REQUIRED;
        return SetThreadExecutionState(f);
    }

    public static uint Ping(bool display)
    {
        uint f = ES_SYSTEM_REQUIRED;
        if (display) f |= ES_DISPLAY_REQUIRED;
        return SetThreadExecutionState(f);
    }
}
'@

Add-Type -TypeDefinition $source

if ([DshAwake]::Hold($Display -ne 0) -eq 0) { exit 2 }

while ($true) {
    Start-Sleep -Seconds 15
    [void][DshAwake]::Ping($Display -ne 0)
}
