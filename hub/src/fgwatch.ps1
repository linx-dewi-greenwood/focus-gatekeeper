# Focus hub - foreground window watcher (Windows only).
# Prints one JSON line whenever the foreground window or its title changes:
#   {"type":"fg","hwnd":123,"pid":456,"app":"WINWORD","title":"report.docx - Word"}
# Reads commands from stdin (id echoes back in {"type":"done","id":...,"ok":...}):
#   activate <id> <hwnd>   bring that window to the foreground
#   minimize <id> <hwnd>   minimize that window
#   quit
# Keep this file ASCII-only: it is passed to powershell.exe via -EncodedCommand.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class FocusWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

  static readonly object OutLock = new object();

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s ?? "") {
      switch (c) {
        case '"': b.Append("\\\""); break;
        case '\\': b.Append("\\\\"); break;
        case '\n': b.Append("\\n"); break;
        case '\r': b.Append("\\r"); break;
        case '\t': b.Append("\\t"); break;
        default:
          if (c < 0x20) b.Append("\\u" + ((int)c).ToString("x4"));
          else b.Append(c);
          break;
      }
    }
    return b.ToString();
  }

  static void Emit(string json) {
    lock (OutLock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
  }

  // IMPORTANT: never block on another process's window here.
  //  - Do NOT use AttachThreadInput: sharing input queues with other apps can freeze them
  //    (that froze VS Code / Claude in v0.1).
  //  - Use ShowWindowAsync instead of ShowWindow: ShowWindow waits for the target window's thread,
  //    and a busy or hung app would block us.
  // Windows only lets the process that received the last input change the foreground window,
  // so we synthesize one Alt key tap first, then ask for the switch.
  static bool Activate(IntPtr hwnd) {
    if (!IsWindow(hwnd)) return false;
    if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9); // SW_RESTORE
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hwnd);
    Thread.Sleep(80);
    if (GetForegroundWindow() == hwnd) return true;
    SwitchToThisWindow(hwnd, true); // fallback; also non-blocking
    Thread.Sleep(80);
    return GetForegroundWindow() == hwnd;
  }

  static bool Minimize(IntPtr hwnd) {
    if (!IsWindow(hwnd)) return false;
    return ShowWindowAsync(hwnd, 6); // SW_MINIMIZE, does not wait for the target app
  }

  // Each command runs on its own background thread, so one slow window can never stall the watcher.
  static void RunCommand(string name, long id, long h) {
    Thread t = new Thread(delegate () {
      bool ok = false;
      try {
        if (name == "activate") ok = Activate(new IntPtr(h));
        else if (name == "minimize") ok = Minimize(new IntPtr(h));
      } catch (Exception) { ok = false; }
      Emit("{\"type\":\"done\",\"id\":" + id + ",\"ok\":" + (ok ? "true" : "false") + "}");
    });
    t.IsBackground = true;
    t.Start();
  }

  static void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] parts = line.Trim().Split(' ');
      if (parts.Length == 1 && parts[0] == "quit") Environment.Exit(0);
      if (parts.Length != 3) continue;
      long id, h;
      if (!long.TryParse(parts[1], out id) || !long.TryParse(parts[2], out h)) continue;
      RunCommand(parts[0], id, h);
    }
    Environment.Exit(0); // parent process closed stdin
  }

  public static void Run(int intervalMs) {
    Thread reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();
    IntPtr last = IntPtr.Zero;
    string lastTitle = null;
    StringBuilder sb = new StringBuilder(512);
    while (true) {
      try {
        IntPtr h = GetForegroundWindow();
        sb.Length = 0;
        GetWindowText(h, sb, 512);
        string title = sb.ToString();
        if (h != last || title != lastTitle) {
          last = h;
          lastTitle = title;
          uint pid;
          GetWindowThreadProcessId(h, out pid);
          string name = "";
          try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
          Emit("{\"type\":\"fg\",\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"app\":\"" + Esc(name) + "\",\"title\":\"" + Esc(title) + "\"}");
        }
      } catch (Exception e) {
        Emit("{\"type\":\"error\",\"message\":\"" + Esc(e.Message) + "\"}");
      }
      Thread.Sleep(intervalMs);
    }
  }
}
'@

Write-Output '{"type":"ready"}'
[FocusWatch]::Run(400)
