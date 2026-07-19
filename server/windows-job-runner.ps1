$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CodebateJob {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public UInt64 ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMIT_INFORMATION {
    public BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);

  public static IntPtr EnterKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var info = new EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x00002000;
    int size = Marshal.SizeOf(info);
    IntPtr pointer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, pointer, false);
      if (!SetInformationJobObject(job, 9, pointer, (uint)size)) throw new System.ComponentModel.Win32Exception();
      if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new System.ComponentModel.Win32Exception();
      return job;
    } catch { CloseHandle(job); throw; }
    finally { Marshal.FreeHGlobal(pointer); }
  }
}

// AppContainer confinement for the model-run child (Codex execute). The child is launched into a
// per-app AppContainer whose token denies, by default, the filesystem (only paths explicitly granted
// to the container SID are reachable) and the network (no internetClient capability). Codebate grants
// the container SID only the disposable clone and the isolated Codex home — dirs it owns and deletes
// after the run — so a prompt-injected model-run command can neither read host secrets (SSH keys, the
// user's real Codex token) nor exfiltrate over the network. Setup failures fail CLOSED (see the wrapper
// body): the child is never launched unconfined.
public static class CodebateConfine {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid, Capabilities; public uint CapabilityCount, Reserved; }

  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string n, string d, string desc, IntPtr caps, uint cc, out IntPtr sid);
  [DllImport("userenv.dll", CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string n, out IntPtr sid);
  [DllImport("advapi32.dll")] public static extern bool FreeSid(IntPtr sid);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr s);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr l, int c, int f, ref IntPtr s);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr l, uint f, IntPtr a, IntPtr v, IntPtr s, IntPtr p, IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern void DeleteProcThreadAttributeList(IntPtr l);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint fl, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 1;
  static readonly IntPtr ATTR_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
  static readonly IntPtr ATTR_HANDLE_LIST = (IntPtr)0x00020002;

  // Create the app container profile, or derive its SID if it already exists (stable name -> stable
  // SID, reused across runs). The caller frees the returned SID.
  public static IntPtr EnsureContainer(string name) {
    IntPtr sid;
    int hr = CreateAppContainerProfile(name, name, name, IntPtr.Zero, 0, out sid);
    if (hr == 0) return sid;
    // Only fall back to deriving the SID when the profile ALREADY EXISTS; any other create failure is a
    // real error and must surface (not be masked by a derive that returns a SID for a never-registered
    // profile — CreateProcess would then refuse to launch anyway, but a clear error is better).
    const int E_ALREADY_EXISTS = unchecked((int)0x800700B7);
    if (hr != E_ALREADY_EXISTS) throw new Exception("AppContainer profile create failed (0x" + hr.ToString("X8") + ")");
    int d = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (d != 0) throw new Exception("AppContainer profile derive failed (0x" + d.ToString("X8") + ")");
    return sid;
  }
  public static string SidString(IntPtr sid) { IntPtr s; if (!ConvertSidToStringSid(sid, out s)) throw new System.ComponentModel.Win32Exception(); string r = Marshal.PtrToStringUni(s); LocalFree(s); return r; }
  public static void ReleaseSid(IntPtr sid) { if (sid != IntPtr.Zero) FreeSid(sid); }

  // Launch app under the AppContainer token, inheriting exactly the wrapper's three standard handles
  // (so the child streams directly to the Node pipes) and nothing else. Returns the child exit code.
  public static int Launch(string app, string cmdline, string cwd, IntPtr sid) {
    IntPtr hIn = GetStdHandle(-10), hOut = GetStdHandle(-11), hErr = GetStdHandle(-12);
    foreach (IntPtr h in new IntPtr[]{hIn, hOut, hErr}) { if (h != IntPtr.Zero && h != (IntPtr)(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT); }
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) throw new System.ComponentModel.Win32Exception();
    SECURITY_CAPABILITIES sc = new SECURITY_CAPABILITIES(); sc.AppContainerSid = sid;
    IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))); Marshal.StructureToPtr(sc, scPtr, false);
    IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
    Marshal.WriteIntPtr(handles, 0, hIn); Marshal.WriteIntPtr(handles, IntPtr.Size, hOut); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, hErr);
    try {
      if (!UpdateProcThreadAttribute(list, 0, ATTR_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      if (!UpdateProcThreadAttribute(list, 0, ATTR_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = hIn; si.StartupInfo.hStdOutput = hOut; si.StartupInfo.hStdError = hErr;
      si.lpAttributeList = list;
      PROCESS_INFORMATION pi;
      // bInheritHandles=true is required for the std-handle inheritance; the HANDLE_LIST attribute
      // restricts inheritance to exactly those three, so no other inheritable handle leaks in.
      if (!CreateProcess(app, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi)) throw new System.ComponentModel.Win32Exception();
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      return unchecked((int)code);
    } finally {
      Marshal.FreeHGlobal(scPtr); Marshal.FreeHGlobal(handles);
      DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list);
    }
  }
}
"@

function Quote-NativeArgument([string]$value) {
  if ($value.Length -eq 0) { return '""' }
  if ($value -notmatch '[\s"]') { return $value }
  $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

if ($args.Count -ne 1) { throw "Expected one encoded launch payload" }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0])) | ConvertFrom-Json
$job = [CodebateJob]::EnterKillOnCloseJob()

# Confined path (Codex execute): the payload carries a confinement descriptor. Any failure to set up
# the AppContainer or launch the child into it exits with a distinct marker + code, so the caller fails
# CLOSED — the model-run child is NEVER launched outside the container as a fallback.
if ($payload.confinement) {
  $sid = [IntPtr]::Zero
  try {
    $sid = [CodebateConfine]::EnsureContainer([string]$payload.confinement.containerName)
    $sidStr = [CodebateConfine]::SidString($sid)
    $sidObj = New-Object System.Security.Principal.SecurityIdentifier($sidStr)
    foreach ($grant in @($payload.confinement.grants)) {
      $dir = [string]$grant
      $acl = Get-Acl -LiteralPath $dir
      # Modify (read/write/execute/delete), NOT FullControl — the container never needs to change the
      # ACL or take ownership of the disposable clone/temp it is granted (least privilege).
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sidObj, "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $dir -AclObject $acl
    }
    $exe = [string]$payload.command
    $cmdline = ((@($exe) + @($payload.args | ForEach-Object { [string]$_ })) | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $cwd = if ($payload.cwd) { [string]$payload.cwd } else { (Get-Location).Path }
    $exit = [CodebateConfine]::Launch($exe, $cmdline, $cwd, $sid)
    exit $exit
  } catch {
    # Fail closed: name the failure with a stable marker the server recognizes, and never fall back to
    # an unconfined launch.
    [Console]::Error.WriteLine("CODEBATE_CONFINEMENT_SETUP_FAILED: " + $_.Exception.Message)
    exit 8086
  } finally {
    if ($sid -ne [IntPtr]::Zero) { [CodebateConfine]::ReleaseSid($sid) }
  }
}

$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = [string]$payload.command
$info.Arguments = (($payload.args | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' ')
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw "Failed to start contained process" }
# Copy raw streams as they arrive. ReadToEndAsync would buffer an agent's full
# response inside PowerShell and would hide progress until the process exits.
$stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$stderr = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$stdin = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
[void]$stdin.GetAwaiter().GetResult()
$process.StandardInput.Close()
$process.WaitForExit()
[void]$stdout.GetAwaiter().GetResult()
[void]$stderr.GetAwaiter().GetResult()
$exitCode = $process.ExitCode
# Keep the last Job Object handle open until this wrapper exits. Closing it while
# the wrapper is still a member would terminate the wrapper before it can report
# the contained process's exit code.
exit $exitCode
