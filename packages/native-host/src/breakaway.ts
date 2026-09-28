/**
 * Starting the daemon outside Firefox's job object (Windows only).
 *
 * On Windows, Firefox runs the Native Host inside a job object and kills
 * the whole job when it shuts down or disconnects the host. A daemon started
 * with Node's spawn({ detached: true }) stays in that job, so closing Firefox
 * killed it -- together with the Claude Code sessions (relays) using it.
 * Firefox allows breakaway (MDN, Native messaging: "the native application
 * must launch the additional process with the CREATE_BREAKAWAY_FROM_JOB
 * flag"), but Node cannot set that flag, so a short PowerShell script calls
 * CreateProcess itself.
 *
 * The daemon inherits the Native Host's environment (FOX_* settings) through
 * PowerShell. Paths go through environment variables, never through the
 * command line, so no quoting is involved.
 */

import { spawn } from 'node:child_process';

/** C#: CreateProcess(node entry --daemon) with breakaway, stderr → log file. */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class KitsuneBreakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
    IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);

  const uint FILE_APPEND_DATA = 0x4, SYNCHRONIZE = 0x100000, OPEN_ALWAYS = 4;
  const uint CREATE_NEW_PROCESS_GROUP = 0x200, EXTENDED_STARTUPINFO_PRESENT = 0x80000,
    CREATE_BREAKAWAY_FROM_JOB = 0x01000000, CREATE_NO_WINDOW = 0x08000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x20002);

  public static int Start(string node, string entry, string logPath) {
    var sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = true;
    IntPtr log = CreateFile(logPath, FILE_APPEND_DATA | SYNCHRONIZE, 3, ref sa, OPEN_ALWAYS, 0x80, IntPtr.Zero);
    if (log == new IntPtr(-1)) log = IntPtr.Zero;   // logging is best-effort

    var si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.dwFlags = 0x100;   // STARTF_USESTDHANDLES: stdin/stdout none, stderr → log
    si.StartupInfo.hStdError = log;
    uint flags = CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;

    // Inherit the log file and nothing else: our own std handles are pipes to
    // the Native Host, and a daemon holding them would keep them open.
    IntPtr list = IntPtr.Zero, handles = IntPtr.Zero;
    try {
      if (log != IntPtr.Zero) {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        handles = Marshal.AllocHGlobal(IntPtr.Size);
        Marshal.WriteIntPtr(handles, log);
        if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles,
            new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        si.lpAttributeList = list;
        flags |= EXTENDED_STARTUPINFO_PRESENT;
      }
      var cmd = new StringBuilder("\"" + node + "\" \"" + entry + "\" --daemon");
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, log != IntPtr.Zero, flags,
          IntPtr.Zero, null, ref si, out pi)) throw new Win32Exception(Marshal.GetLastWin32Error());
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return pi.dwProcessId;
    } finally {
      if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (log != IntPtr.Zero) CloseHandle(log);
    }
  }
}
'@
[Console]::Out.Write([KitsuneBreakaway]::Start($env:KITSUNE_DAEMON_NODE, $env:KITSUNE_DAEMON_ENTRY, $env:KITSUNE_DAEMON_LOG))
`;

/** PowerShell compiles the C# first, which takes a second or two. */
const BREAKAWAY_TIMEOUT_MS = 20_000;

/**
 * Start `node <entry> --daemon` outside the current job object.
 * Resolves with the daemon's PID; rejects when PowerShell or CreateProcess
 * fails (e.g. a job that does not allow breakaway), so the caller can fall
 * back to a plain detached spawn.
 */
export function spawnDaemonBreakaway(entry: string, logPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        // The daemon inherits only its log file (PROC_THREAD_ATTRIBUTE_HANDLE_LIST),
        // so 'close' comes when PowerShell exits, not when the daemon does.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          KITSUNE_DAEMON_NODE: process.execPath,
          KITSUNE_DAEMON_ENTRY: entry,
          KITSUNE_DAEMON_LOG: logPath,
        },
      },
    );

    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    ps.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('PowerShell did not finish in time'));
    }, BREAKAWAY_TIMEOUT_MS);

    ps.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      const pid = Number(stdout.trim());
      if (code === 0 && Number.isInteger(pid) && pid > 0) {
        resolve(pid);
      } else {
        const detail = stderr.trim().split(/\r?\n/).slice(0, 3).join(' ');
        reject(new Error(`exit code ${code ?? 'null'}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}
