import { describe, it, expect } from 'vitest';
import { classifyGptTask, DIAG_OPS } from '../src/lib/gptDiagOps';
import { signCommandOrigin, verifyCommandOrigin, SIGNED_COMMAND_TYPES, withUtf8Console, decodeBeacon64Stdout } from '../src/lib/gptBridge';

const SECRET = 'test-secret-0123456789abcdef';

describe('gpt task classification — no arbitrary auto-exec', () => {
  it('auto-approves only known diag op names', () => {
    for (const op of Object.keys(DIAG_OPS)) {
      expect(classifyGptTask('diag', op)).toBe('readonly');
      expect(classifyGptTask('diag', op.toUpperCase())).toBe('readonly');
    }
  });

  it('rejects unknown diag op names as dangerous', () => {
    expect(classifyGptTask('diag', 'remove_everything')).toBe('dangerous');
    expect(classifyGptTask('diag', 'system_info; Remove-Item C:\\')).toBe('dangerous');
    expect(classifyGptTask('diag', '')).toBe('dangerous');
  });

  it('the live bypass reproduces as operational, not readonly', () => {
    // The exact script that bypassed the old token-scanning classifier.
    expect(classifyGptTask('powershell', 'hostname\ncmd /c echo BEACON_BYPASS_SAFETY_PROBE')).toBe('operational');
  });

  it('arbitrary PowerShell is ALWAYS operational (pending_confirm)', () => {
    expect(classifyGptTask('powershell', 'hostname')).toBe('operational');
    expect(classifyGptTask('powershell', 'whoami')).toBe('operational');
    expect(classifyGptTask('powershell', 'Get-Process')).toBe('operational');
    expect(classifyGptTask('powershell', '# just a comment')).toBe('operational');
  });

  it('cmd.exe, aliases, iex, .NET are operational', () => {
    expect(classifyGptTask('powershell', 'cmd /c echo hi')).toBe('operational');
    expect(classifyGptTask('powershell', 'iex "Get-Date"')).toBe('operational');
    expect(classifyGptTask('powershell', 'Invoke-Expression (Get-Content .\\x.ps1)')).toBe('operational');
    expect(classifyGptTask('powershell', '[System.IO.File]::Delete("C:\\x")')).toBe('operational');
    expect(classifyGptTask('powershell', 'rmdir C:\\x')).toBe('operational');
    expect(classifyGptTask('powershell', 'ri C:\\x')).toBe('operational');
  });

  it('multi-line and pipeline mutators are operational', () => {
    expect(classifyGptTask('powershell', 'Get-ChildItem C:\\ | Remove-Item')).toBe('operational');
    expect(classifyGptTask('powershell', 'Get-Process\nStop-Process -Name notepad')).toBe('operational');
    expect(classifyGptTask('powershell', 'ForEach-Object { Remove-Item $_ }')).toBe('operational');
  });

  it('kind=system is operational (needs token), not readonly', () => {
    expect(classifyGptTask('system', 'reboot')).toBe('operational');
  });

  it('protected path mention is blocked regardless of kind', () => {
    expect(classifyGptTask('powershell', 'Remove-Item D:\\ChatGPT-Disk\\x')).toBe('blocked');
    expect(classifyGptTask('powershell', '$p = "d:/chatgpt-disk"; Remove-Item $p')).toBe('blocked');
    expect(classifyGptTask('diag', 'system_info') === 'blocked').toBe(false);
  });
});

describe('command origin signatures', () => {
  it('signs and verifies a command payload round-trip', async () => {
    const payload = { shell: 'powershell', script: 'hostname' };
    const sig = await signCommandOrigin('cmd-1', 'dev-1', payload, SECRET);
    const stored = JSON.stringify({ ...payload, origin_sig: sig });
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'run_script', stored, SECRET)).toBe(true);
  });

  it('fails verification when any signed field is tampered', async () => {
    const payload = { shell: 'powershell', script: 'hostname' };
    const sig = await signCommandOrigin('cmd-1', 'dev-1', payload, SECRET);
    const tampered = JSON.stringify({ ...payload, script: 'Remove-Item C:\\', origin_sig: sig });
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'run_script', tampered, SECRET)).toBe(false);
    expect(await verifyCommandOrigin('cmd-OTHER', 'dev-1', 'run_script', JSON.stringify({ ...payload, origin_sig: sig }), SECRET)).toBe(false);
    expect(await verifyCommandOrigin('cmd-1', 'dev-OTHER', 'run_script', JSON.stringify({ ...payload, origin_sig: sig }), SECRET)).toBe(false);
  });

  it('fails closed: unsigned, unparseable, or missing key', async () => {
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'run_script', '{"shell":"powershell"}', SECRET)).toBe(false);
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'run_script', 'not json', SECRET)).toBe(false);
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'run_script', '{"origin_sig":"x"}', undefined)).toBe(false);
  });

  it('non-executing command types do not require a signature', async () => {
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'open_session', '{"session_id":"x"}', SECRET)).toBe(true);
    expect(await verifyCommandOrigin('cmd-1', 'dev-1', 'open_session', '{"session_id":"x"}', undefined)).toBe(true);
    expect(SIGNED_COMMAND_TYPES.has('run_script')).toBe(true);
    expect(SIGNED_COMMAND_TYPES.has('open_session')).toBe(false);
  });

  it('origin_sig inside the signed material cannot be re-signed by a caller', async () => {
    // A direct D1 writer can read an existing signed payload and try to copy
    // the signature onto a new command row — the command_id is part of the
    // signed material, so the copy fails.
    const payload = { shell: 'powershell', script: 'hostname' };
    const sig = await signCommandOrigin('cmd-1', 'dev-1', payload, SECRET);
    const stolen = JSON.stringify({ shell: 'powershell', script: 'shutdown /r /t 0', origin_sig: sig });
    expect(await verifyCommandOrigin('cmd-2', 'dev-1', 'run_script', stolen, SECRET)).toBe(false);
  });
});

describe('BEACON64 encoding-safe dispatch', () => {
  it('wraps arbitrary scripts to emit base64-only output', () => {
    const wrapped = withUtf8Console('whoami');
    expect(wrapped).toContain('BEACON64:');
    expect(wrapped).toContain('ToBase64String');
    expect(wrapped).toContain('whoami'); // original script preserved inside the wrapper
  });

  it('passes through stdout without BEACON64 lines untouched', () => {
    expect(decodeBeacon64Stdout('plain output\r\n')).toBe('plain output\r\n');
  });

  it('diag catalog scripts go through the same wrapper at dispatch (spot-check source)', () => {
    // The catalog itself stays raw; wrapping happens in dispatch. Sanity:
    // every catalog script is non-empty PowerShell text.
    for (const op of Object.values(DIAG_OPS)) {
      expect(op.script.length).toBeGreaterThan(10);
      expect(op.script).not.toMatch(/Remove-Item|Invoke-Expression|Start-Process/i);
    }
  });
});
