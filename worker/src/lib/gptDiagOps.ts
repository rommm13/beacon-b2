// ── Classification ───────────────────────────────────────────────────────────
// SECURITY MODEL (post-bypass redesign, 2026-11-07): NO arbitrary script ever
// auto-executes. Static analysis of PowerShell is unwinnable — bare commands
// (cmd /c …), aliases (iex), .NET calls and script blocks evade token
// scanning, and a two-line `hostname\ncmd /c echo …` bypass proved it live.
// Instead:
//   kind='diag'       → op name validated against DIAG_OPS; the PowerShell that
//                       runs is worker-owned catalog text, ChatGPT only picks
//                       an op name. Auto-approved.
//   kind='powershell' → ALWAYS pending_confirm. The human is the reviewer.
//   anything else     → dangerous.
// The D:\ChatGPT-Disk scan stays as a fast-fail convenience; for arbitrary
// scripts it is NOT a security boundary (variables/concat can hide paths) —
// the human confirmation is the boundary there.
export const DIAG_OPS: Record<string, { description: string; script: string }> = {
  system_info: {
    description: 'Hostname, whoami, OS version, CPU load, RAM',
    script: `hostname; whoami
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime | Format-List
Get-CimInstance Win32_Processor | Select-Object Name,LoadPercentage | Format-List`,
  },
  disk: {
    description: 'Logical disks, free space, physical disk health',
    script: `Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace | Format-Table -AutoSize
Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus | Format-Table -AutoSize`,
  },
  battery: {
    description: 'Battery charge, status, estimated runtime',
    script: `Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus,EstimatedRunTime | Format-List`,
  },
  network: {
    description: 'IP configuration, active TCP connections, listening ports',
    script: `Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress | Format-Table -AutoSize
Get-NetTCPConnection -State Established,Listen | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess | Format-Table -AutoSize`,
  },
  processes: {
    description: 'Top 25 processes by CPU, plus total count',
    script: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name,Id,CPU,WorkingSet | Format-Table -AutoSize
"ProcessCount: " + (Get-Process).Count`,
  },
  services: {
    description: 'Running services',
    script: `Get-Service | Where-Object Status -eq 'Running' | Select-Object Name,DisplayName | Format-Table -AutoSize`,
  },
  startup: {
    description: 'Autostart entries (registry Run keys + Startup folder)',
    script: `Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location | Format-Table -Wrap`,
  },
  installed_apps: {
    description: 'Installed applications (registry uninstall keys)',
    script: `Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName | Select-Object DisplayName,DisplayVersion,Publisher | Sort-Object DisplayName | Format-Table -Wrap`,
  },
  recent_errors: {
    description: 'Last 20 Error events from the System event log',
    script: `Get-WinEvent -FilterHashtable @{LogName='System';Level=2} -MaxEvents 20 -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,ProviderName,Message | Format-Table -Wrap`,
  },
  security_summary: {
    description: 'Defender status, firewall profiles, pending reboot marker',
    script: `Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureLastUpdated | Format-List
Get-NetFirewallProfile | Select-Object Name,Enabled | Format-Table -AutoSize`,
  },
};

export type GptClassification = 'readonly' | 'operational' | 'dangerous' | 'blocked';

// Protected paths: fast-fail deny for ANY task (diag op name or script text)
// mentioning them. For arbitrary scripts this is convenience hardening, not
// the security boundary — variables/concat can hide paths, which is exactly
// why arbitrary scripts always need a human regardless.
export const GPT_BRIDGE_DENY_PREFIXES = ['d:\\chatgpt-disk', 'd:/chatgpt-disk'];

function mentionsProtectedPath(script: string): boolean {
  const lower = script.toLowerCase();
  return GPT_BRIDGE_DENY_PREFIXES.some(p => lower.includes(p));
}

// `script` for kind='diag' is the op NAME, not PowerShell text.
export function classifyGptTask(kind: string, script: string): GptClassification {
  if (mentionsProtectedPath(script)) return 'blocked';
  if (kind === 'diag') {
    return Object.hasOwn(DIAG_OPS, script.trim().toLowerCase()) ? 'readonly' : 'dangerous';
  }
  // Arbitrary PowerShell and system actions: never auto-approved.
  return 'operational';
}
