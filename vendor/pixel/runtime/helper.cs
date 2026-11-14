// dsh-click-matrix native helper (protocol v1, v2/v4/v6/v7/v8 capabilities).
// Long-lived Windows helper process: NDJSON over stdin/stdout, worker thread
// serial, immediate abort on the reader thread. Mouse injection plus the v2
// keyboard commands (type_text / press_keys) and the Esc/polling watchdog.
// v4 adds the focus command: raise an existing window to the foreground
// without injecting mouse/keyboard input or resizing/moving it.
// v6 adds an independent Ctrl+Alt+F11 global abort hotkey: it fires an "abort"
// event, releases held buttons and stops in-flight injection regardless of the
// Ctrl+Alt+F12 arm state, without injecting any input itself.
// v7 adds capture clientOnly (PrintWindow PW_CLIENTONLY) and clipboard_get
// requireText/hasText/reason with a short internal wait for a racing clipboard.
// v8 adds physicalButtonsDown (real OS button state), overlay hit-test flags,
// focus diagnostics plus a stronger SetForegroundWindow retry, and click
// foreground/physical-button diagnostics. All read-only probes, no new input.
// v9 makes abort/exit release buttons from the union of tracked and real OS
// state. A button can stay physically down if the helper is killed between
// SendButton(down) and SetTrackedButton(true); the old tracking-only release
// then missed it, leaving Windows/touchpad click state stuck.
// The watchdog only ever reads key state, it never records key content.
// ASCII source only, C# 5 / .NET Framework 4.8 compatible, /target:winexe.

using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ClickMatrixHelper
{
    internal static class Program
    {
        internal const int HelperVersion = 11;
        internal const int ProtocolVersion = 1;
        internal const string HotkeyCombo = "Ctrl+Alt+F12";
        internal const string AbortHotkeyCombo = "Ctrl+Alt+F11";
        internal const string SoftHotkeyCombo = "Ctrl+Shift+F11";

        private const int HOTKEY_ID = 0xC1;
        private const int ABORT_HOTKEY_ID = 0xC2;
        private const int SOFT_HOTKEY_ID = 0xC3;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_SHIFT = 0x0004;
        private const uint VK_F11 = 0x7A;
        private const uint VK_F12 = 0x7B;
        private const int WM_HOTKEY = 0x0312;
        // The previous helper instance may still own a hotkey for a moment
        // while it exits, so the first start after a kill/restart can lose the
        // RegisterHotKey race. Retry for ~5 s per hotkey before giving up.
        private const int HOTKEY_REGISTER_ATTEMPTS = 10;
        private const int HOTKEY_REGISTER_RETRY_MS = 500;

        private const uint VK_ESCAPE = 0x1B;
        private const uint VK_RETURN = 0x0D;
        private const uint VK_TAB = 0x09;

        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        private const int PW_CLIENTONLY = 1;
        private const int PW_RENDERFULLCONTENT = 2;

        private const int CLIPBOARD_ATTEMPTS = 3;
        private const int CLIPBOARD_RETRY_MS = 70;

        private const int ESC_WATCH_INTERVAL_MS = 33;
        private const int KEYBOARD_INJECT_GRACE_MS = 700;
        private const int MOUSE_INJECT_GRACE_MS = 300;
        private const int HUMAN_MOUSE_EVENT_INTERVAL_MS = 250;
        private const int EVENT_DEBOUNCE_MS = 250;
        private const int CURSOR_TOLERANCE_PX = 4;
        private const int TYPE_TEXT_MAX_CHARS = 20000;
        private const int CLIPBOARD_MAX_CHARS = 100000;

        private const int GA_ROOT = 2;
        private const int GWL_EXSTYLE = -20;
        private const long WS_EX_TRANSPARENT = 0x00000020L;
        private const long WS_EX_TOOLWINDOW = 0x00000080L;
        private const long WS_EX_NOACTIVATE = 0x08000000L;

        private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
        private const int DWMWA_CLOAKED = 14;

        private const uint INPUT_MOUSE = 0;
        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private const int SW_RESTORE = 9;
        private static readonly IntPtr HWND_TOP = IntPtr.Zero;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

        private const int CURSOR_SHOWING = 0x0001;
        private const int DI_NORMAL = 0x0003;

        private const int UOI_FLAGS = 1;
        private const int WSF_VISIBLE = 0x0001;

        // ---------------- shared state ----------------

        internal static readonly object OutLock = new object();
        internal static readonly object ButtonLock = new object();
        internal static readonly object DenyLock = new object();
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        internal static readonly BlockingCollection<Dictionary<string, object>> Queue = new BlockingCollection<Dictionary<string, object>>();

        internal static volatile bool AbortRequested = false;
        internal static volatile bool Armed = false;
        internal static volatile bool QuitRequested = false;

        internal static PumpForm Pump;
        internal static LatticeForm LatticeWin;
        internal static PillForm PillWin;
        internal static StopForm StopWin;

        internal static IntPtr PumpHandle = IntPtr.Zero;
        internal static IntPtr LatticeHandle = IntPtr.Zero;
        internal static IntPtr PillHandle = IntPtr.Zero;
        internal static IntPtr StopHandle = IntPtr.Zero;

        internal static bool HotkeyRegistered = false;
        internal static bool AbortHotkeyRegistered = false;
        internal static bool SoftHotkeyRegistered = false;
        // D-08: why the last hotkey registration failed (surfaced in status so
        // a missing emergency stop is never silent).
        internal static string HotkeyLastError = "";
        internal static bool DpiAware = false;
        internal static bool LatticeVisible = false;
        internal static bool PillVisible = false;
        internal static bool LatticeExcluded = false;
        internal static bool PillExcluded = false;
        // D-12: the pill is two windows. PillWin paints the label and is
        // click-through (WS_EX_TRANSPARENT | WS_EX_LAYERED); StopWin is a
        // small opaque window that carries ONLY the STOP button. Before this
        // split the single pill window swallowed clicks on the window title
        // bar underneath it (the user could not start a drag while armed).
        internal static bool StopVisible = false;
        internal static bool StopExcluded = false;
        // Whether the overlay window currently swallows clicks (it loses
        // WS_EX_TRANSPARENT). Recomputed from the real ex-style in DoOverlay
        // right after the window is shown or hidden.
        internal static bool LatticeHitTestable = false;
        internal static bool PillHitTestable = false;
        internal static bool StopHitTestable = false;
        internal static bool? OverlayAvailableCache = null;

        internal static volatile bool EscWatchEnabled = false;
        private static Thread EscWatchThread;
        private static readonly object EscWatchLock = new object();
        private static volatile bool EscWatchStop = false;
        // Tick count of the last keyboard event we injected ourselves. The Esc
        // watchdog ignores key state inside this grace window so its own
        // type_text/press_keys output never looks like physical human input.
        private static volatile int LastKeyboardInjectTick = Environment.TickCount - 60000;
        private static volatile int LastEscapeEventTick = 0;
        private static volatile int LastHumanInputEventTick = 0;
        // Physical-cursor watchdog (v3): while armed, a cursor move that is not our
        // own injection means the human grabbed the mouse; the host suspends
        // injection and auto-resumes after an idle grace period.
        private static volatile int LastMouseInjectTick = Environment.TickCount - 60000;
        private static volatile int LastHumanMouseEventTick = 0;
        private static int WatchLastX = int.MinValue;
        private static int WatchLastY = int.MinValue;

        // Transition baseline so keys already held when the watch is enabled
        // (e.g. the Ctrl+Alt+F12 arm chord itself) never look like human typing.
        private static readonly bool[] WatchDownBase = new bool[256];
        private static volatile int WatchEnabledAt = 0;
        private const int WATCH_ARM_GRACE_MS = 300;

        internal static bool ButtonLeftDown = false;
        internal static bool ButtonRightDown = false;
        internal static bool ButtonMiddleDown = false;

        internal static List<string> DenyProcesses = new List<string>();
        internal static List<string> DenyClasses = new List<string>();

        private static readonly string[] BaseDenyClasses = new string[]
        {
            "ConsentUI", "LogonUI", "LockApp", "Windows Security", "User Account Control"
        };

        private static StreamWriter StdOut;
        private static StreamWriter StdErr;
        private static StreamReader StdIn;

        private static List<object> WindowCollector;
        private static POINT ProbePoint;
        private static IntPtr ProbeResult;
        private static List<object> MonitorCollector;

        // ------------------------------------------------------------------
        // Entry point
        // ------------------------------------------------------------------

        [STAThread]
        private static void Main()
        {
            try
            {
                DpiAware = SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch
            {
                try { DpiAware = SetProcessDPIAware(); }
                catch { DpiAware = false; }
            }

            try
            {
                StdOut = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 16384);
                StdOut.NewLine = "\n";
                StdOut.AutoFlush = false;
            }
            catch { StdOut = null; }
            try
            {
                StdErr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false), 4096);
                StdErr.AutoFlush = true;
            }
            catch { StdErr = null; }
            try
            {
                StdIn = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 16384);
            }
            catch { StdIn = null; }

            AppDomain.CurrentDomain.ProcessExit += delegate
            {
                try { ReleaseAllButtons(); } catch { }
                try { FlushOut(); } catch { }
            };
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
            {
                LogErr("ui exception: " + Describe(e.Exception));
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                LogErr("unhandled exception: " + (e.ExceptionObject == null ? "?" : e.ExceptionObject.ToString()));
                try { ReleaseAllButtons(); } catch { }
                try { FlushOut(); } catch { }
            };

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Pump = new PumpForm();
            PumpHandle = Pump.Handle;
            // dsh-dexter patch (2026-11-14): when the host owns the global hotkeys itself
            // (DSH_DEXTER_HOTKEYS=external) this helper must not claim them, or the host's
            // listener would lose the registration race. "arm" releases only the arm combo,
            // which keeps the helper's emergency stop (Ctrl+Alt+F11) intact. Everything else
            // is unchanged.
            string sharedHotkeys = Environment.GetEnvironmentVariable("DSH_DEXTER_HOTKEYS") ?? "";
            bool releaseAll = string.Equals(sharedHotkeys, "external", StringComparison.OrdinalIgnoreCase);
            bool releaseArm = releaseAll || string.Equals(sharedHotkeys, "arm", StringComparison.OrdinalIgnoreCase);
            if (releaseAll)
            {
                HotkeyRegistered = false;
                AbortHotkeyRegistered = false;
                SoftHotkeyRegistered = false;
                LogErr("hotkeys released to the host (DSH_DEXTER_HOTKEYS=external)");
            }
            else
            {
                HotkeyRegistered = releaseArm
                    ? false
                    : RegisterHotkeyWithRetry(PumpHandle, HOTKEY_ID, VK_F12, HotkeyCombo);
                if (releaseArm) LogErr("arm hotkey released to the host (DSH_DEXTER_HOTKEYS=arm)");
                AbortHotkeyRegistered = RegisterHotkeyWithRetry(PumpHandle, ABORT_HOTKEY_ID, VK_F11, AbortHotkeyCombo);
                SoftHotkeyRegistered = RegisterSoftHotkey();
            }

            Pump.BeginInvoke(new Action(StartIo));
            try
            {
                Application.Run(Pump);
            }
            finally
            {
                try { ReleaseAllButtons(); } catch { }
                try { FlushOut(); } catch { }
            }
            Environment.Exit(0);
        }

        // Registers one global hotkey with a bounded retry. The previous helper
        // instance can still own the combo for a short while after it is killed
        // or exits, which used to leave a freshly started helper without its
        // hotkey until the next restart. The retry runs before Application.Run
        // and pumps the thread queue with DoEvents, so pending window messages
        // keep flowing while we wait. The two hotkeys are registered
        // independently: a busy/held combo only disables that one hotkey.
        private static bool RegisterHotkeyWithRetry(IntPtr handle, int hotkeyId, uint virtualKey, string combo)
        {
            for (int attempt = 1; attempt <= HOTKEY_REGISTER_ATTEMPTS; attempt++)
            {
                bool registered = false;
                try
                {
                    registered = RegisterHotKey(handle, hotkeyId, MOD_CONTROL | MOD_ALT, virtualKey);
                }
                catch
                {
                    registered = false;
                }
                if (registered)
                {
                    if (attempt > 1)
                        LogErr("hotkey " + combo + " registered after " + attempt + " attempts");
                    return true;
                }
                if (attempt >= HOTKEY_REGISTER_ATTEMPTS) break;
                if (attempt == 1)
                {
                    LogErr("hotkey " + combo + " registration attempt 1 failed; retrying for up to " +
                           ((HOTKEY_REGISTER_ATTEMPTS - 1) * HOTKEY_REGISTER_RETRY_MS) + "ms");
                }
                try { Application.DoEvents(); } catch { }
                try { Thread.Sleep(HOTKEY_REGISTER_RETRY_MS); } catch { }
                try { Application.DoEvents(); } catch { }
            }
            HotkeyLastError = "hotkey " + combo + " registration failed after " + HOTKEY_REGISTER_ATTEMPTS +
                " attempts (the combo is probably owned by another process)";
            LogErr(HotkeyLastError + "; that emergency stop is unavailable");
            return false;
        }

        // ⑥ 软停热键 Ctrl+Shift+F11（MOD_CONTROL|MOD_SHIFT）：注册失败不阻塞启动，只记状态。
        private static bool RegisterSoftHotkey()
        {
            for (int attempt = 1; attempt <= HOTKEY_REGISTER_ATTEMPTS; attempt++)
            {
                bool registered = false;
                try
                {
                    registered = RegisterHotKey(PumpHandle, SOFT_HOTKEY_ID, MOD_CONTROL | MOD_SHIFT, VK_F11);
                }
                catch
                {
                    registered = false;
                }
                if (registered)
                {
                    if (attempt > 1) LogErr("hotkey " + SoftHotkeyCombo + " registered after " + attempt + " attempts");
                    return true;
                }
                if (attempt >= HOTKEY_REGISTER_ATTEMPTS) break;
                try { Application.DoEvents(); } catch { }
                try { Thread.Sleep(HOTKEY_REGISTER_RETRY_MS); } catch { }
                try { Application.DoEvents(); } catch { }
            }
            LogErr("hotkey " + SoftHotkeyCombo + " registration failed (soft stop unavailable)");
            return false;
        }

        private static void StartIo()
        {
            Thread reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Name = "stdin-reader";
            reader.Start();

            SendEvent("ready", BuildStatus());
            FlushOut();

            Thread worker = new Thread(WorkLoop);
            worker.IsBackground = true;
            worker.Name = "command-worker";
            worker.Start();
        }

        // ------------------------------------------------------------------
        // NDJSON IO
        // ------------------------------------------------------------------

        internal static string Describe(Exception ex)
        {
            if (ex == null) return "unknown error";
            return ex.GetType().Name + ": " + ex.Message;
        }

        private static void WriteLine(string line)
        {
            try
            {
                lock (OutLock)
                {
                    if (StdOut == null) return;
                    StdOut.Write(line);
                    StdOut.Write("\n");
                    StdOut.Flush();
                }
            }
            catch { }
        }

        private static void FlushOut()
        {
            try
            {
                lock (OutLock)
                {
                    if (StdOut != null) StdOut.Flush();
                }
            }
            catch { }
        }

        internal static void LogErr(string message)
        {
            try
            {
                if (StdErr == null) return;
                StdErr.WriteLine("[helper] " + message);
                StdErr.Flush();
            }
            catch { }
        }

        private static void SendEvent(string name, Dictionary<string, object> data)
        {
            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["event"] = name;
            if (data != null) msg["data"] = data;
            WriteLine(Json.Serialize(msg));
        }

        private static void Respond(Dictionary<string, object> request, bool ok, Dictionary<string, object> data, string error)
        {
            Dictionary<string, object> msg = new Dictionary<string, object>();
            if (request != null && request.ContainsKey("id")) msg["id"] = request["id"];
            msg["ok"] = ok;
            if (ok) msg["data"] = data != null ? (object)data : new Dictionary<string, object>();
            else msg["error"] = error != null ? error : "unknown error";
            WriteLine(Json.Serialize(msg));
        }

        private static void WriteRawError(string error)
        {
            Dictionary<string, object> msg = new Dictionary<string, object>();
            msg["ok"] = false;
            msg["error"] = error;
            WriteLine(Json.Serialize(msg));
        }

        private static void ReadLoop()
        {
            try
            {
                if (StdIn == null) return;
                string line;
                while ((line = StdIn.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    Dictionary<string, object> request;
                    try
                    {
                        request = Json.Deserialize<Dictionary<string, object>>(line);
                    }
                    catch (Exception ex)
                    {
                        WriteRawError("bad json: " + ex.Message);
                        continue;
                    }
                    if (request == null)
                    {
                        WriteRawError("bad json: empty request");
                        continue;
                    }
                    string cmd = request.ContainsKey("cmd") && request["cmd"] != null
                        ? Convert.ToString(request["cmd"], CultureInfo.InvariantCulture)
                        : "";
                    if (cmd == "abort")
                    {
                        HandleAbortImmediate(request);
                        continue;
                    }
                    try
                    {
                        Queue.Add(request);
                    }
                    catch (InvalidOperationException)
                    {
                        break;
                    }
                }
            }
            catch (Exception ex)
            {
                LogErr("reader stopped: " + Describe(ex));
            }
            QuitRequested = true;
            try { Queue.CompleteAdding(); } catch { }
            try { Pump.BeginInvoke(new Action(Shutdown)); } catch { }
        }

        private static void HandleAbortImmediate(Dictionary<string, object> request)
        {
            AbortRequested = true;
            // v1.1 (D-13): human-activity suspends must stop injection WITHOUT
            // synthesizing UP for a button the human is physically holding
            // (that was breaking real mouse/touchpad drags while armed).
            bool release = BoolArg(request, "release", true);
            bool released = false;
            if (release)
            {
                try { released = ReleaseAllButtons(); } catch { }
            }
            Dictionary<string, object> data = new Dictionary<string, object>();
            data["aborted"] = true;
            data["released"] = released;
            Respond(request, true, data, null);
        }

        private static void WorkLoop()
        {
            foreach (Dictionary<string, object> request in Queue.GetConsumingEnumerable())
            {
                string cmd = request.ContainsKey("cmd") && request["cmd"] != null
                    ? Convert.ToString(request["cmd"], CultureInfo.InvariantCulture)
                    : "";
                if (cmd == "quit")
                {
                    try
                    {
                        Dictionary<string, object> bye = new Dictionary<string, object>();
                        bye["bye"] = true;
                        Respond(request, true, bye, null);
                    }
                    catch { }
                    try { Pump.BeginInvoke(new Action(Shutdown)); } catch { }
                    break;
                }
                try
                {
                    Dictionary<string, object> data = Dispatch(request, cmd);
                    Respond(request, true, data, null);
                }
                catch (Exception ex)
                {
                    Respond(request, false, null, Describe(ex));
                }
            }
        }

        private static void Shutdown()
        {
            try { StopEscWatch(); } catch { }
            try { ReleaseAllButtons(); } catch { }
            try
            {
                if (PumpHandle != IntPtr.Zero)
                {
                    UnregisterHotKey(PumpHandle, HOTKEY_ID);
                    UnregisterHotKey(PumpHandle, ABORT_HOTKEY_ID);
                    if (SoftHotkeyRegistered) { try { UnregisterHotKey(PumpHandle, SOFT_HOTKEY_ID); } catch { } }
                }
            }
            catch { }
            try
            {
                if (LatticeWin != null) { LatticeWin.Hide(); LatticeVisible = false; }
            }
            catch { }
            try
            {
                if (PillWin != null) { PillWin.Hide(); PillVisible = false; }
                if (StopWin != null) { StopWin.Hide(); StopVisible = false; }
            }
            catch { }
            try { FlushOut(); } catch { }
            try { Application.Exit(); } catch { }
        }

        // ------------------------------------------------------------------
        // Dispatch
        // ------------------------------------------------------------------

        private static Dictionary<string, object> Dispatch(Dictionary<string, object> req, string cmd)
        {
            switch (cmd)
            {
                case "hello": return BuildStatus();
                case "status": return BuildStatus();
                case "windows": return DoWindows();
                case "probe_at": return DoProbeAt(req);
                case "focus": return DoFocus(req);
                case "capture": return DoCapture(req);
                case "zoom": return DoZoom(req);
                case "move": return DoMove(req);
                case "click": return DoClick(req);
                case "drag": return DoDrag(req);
                case "scroll": return DoScroll(req);
                case "overlay": return DoOverlay(req);
                case "retry_hotkeys": return DoRetryHotkeys();
                case "process_tree": return DoProcessTree(req);
                case "abort":
                    {
                        HandleAbortImmediate(req);
                        Dictionary<string, object> d = new Dictionary<string, object>();
                        d["aborted"] = true;
                        d["released"] = true;
                        return d;
                    }
                case "doctor": return DoDoctor();
                case "set_deny": return DoSetDeny(req);
                case "set_esc_watch": return DoSetEscWatch(req);
                case "type_text": return DoTypeText(req);
                case "press_keys": return DoPressKeys(req);
                case "clipboard_get": return DoClipboardGet(req);
                case "clipboard_set": return DoClipboardSet(req);
                default:
                    throw new InvalidOperationException("unknown command: " + cmd);
            }
        }

        // ------------------------------------------------------------------
        // Argument helpers
        // ------------------------------------------------------------------

        private static bool HasArg(Dictionary<string, object> req, string name)
        {
            return req != null && req.ContainsKey(name) && req[name] != null;
        }

        private static int IntArg(Dictionary<string, object> req, string name, int fallback)
        {
            if (!HasArg(req, name)) return fallback;
            object v = req[name];
            try
            {
                if (v is int) return (int)v;
                if (v is long) return (int)(long)v;
                if (v is double) return (int)Math.Round((double)v);
                if (v is float) return (int)Math.Round((double)(float)v);
                if (v is decimal) return (int)Math.Round((double)(decimal)v);
                if (v is bool) return ((bool)v) ? 1 : 0;
                return Convert.ToInt32(v, CultureInfo.InvariantCulture);
            }
            catch
            {
                throw new InvalidOperationException("invalid integer argument: " + name);
            }
        }

        private static int IntArgRequired(Dictionary<string, object> req, string name)
        {
            if (!HasArg(req, name)) throw new InvalidOperationException("missing argument: " + name);
            return IntArg(req, name, 0);
        }

        private static double DoubleArg(Dictionary<string, object> req, string name, double fallback)
        {
            if (!HasArg(req, name)) return fallback;
            object v = req[name];
            try
            {
                if (v is double) return (double)v;
                if (v is int) return (double)(int)v;
                if (v is long) return (double)(long)v;
                if (v is float) return (double)(float)v;
                if (v is decimal) return (double)(decimal)v;
                return Convert.ToDouble(v, CultureInfo.InvariantCulture);
            }
            catch
            {
                throw new InvalidOperationException("invalid number argument: " + name);
            }
        }

        private static bool BoolArg(Dictionary<string, object> req, string name, bool fallback)
        {
            if (!HasArg(req, name)) return fallback;
            object v = req[name];
            try
            {
                if (v is bool) return (bool)v;
                if (v is int) return ((int)v) != 0;
                if (v is long) return ((long)v) != 0;
                return Convert.ToBoolean(v, CultureInfo.InvariantCulture);
            }
            catch
            {
                throw new InvalidOperationException("invalid boolean argument: " + name);
            }
        }

        private static string StrArg(Dictionary<string, object> req, string name, string fallback)
        {
            if (!HasArg(req, name)) return fallback;
            try { return Convert.ToString(req[name], CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        private static void ForEachItem(object value, Action<object> action)
        {
            if (value == null || action == null) return;
            object[] arr = value as object[];
            if (arr != null)
            {
                for (int i = 0; i < arr.Length; i++) action(arr[i]);
                return;
            }
            ArrayList al = value as ArrayList;
            if (al != null)
            {
                for (int i = 0; i < al.Count; i++) action(al[i]);
                return;
            }
            IEnumerable en = value as IEnumerable;
            if (en != null)
            {
                foreach (object item in en) action(item);
            }
        }

        private static Dictionary<string, object> D(params object[] pairs)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            if (pairs == null) return d;
            for (int i = 0; i + 1 < pairs.Length; i += 2)
            {
                d[Convert.ToString(pairs[i], CultureInfo.InvariantCulture)] = pairs[i + 1];
            }
            return d;
        }

        // ------------------------------------------------------------------
        // Status / hello
        // ------------------------------------------------------------------

        private static int OsMajor = 0;
        private static int OsMinor = 0;
        private static int OsBuild = 0;

        private static void EnsureOsVersion()
        {
            if (OsMajor > 0) return;
            try
            {
                RTL_OSVERSIONINFOW info = new RTL_OSVERSIONINFOW();
                info.dwOSVersionInfoSize = (uint)Marshal.SizeOf(typeof(RTL_OSVERSIONINFOW));
                int status = RtlGetVersion(ref info);
                if (status == 0 && info.dwMajorVersion > 0)
                {
                    OsMajor = (int)info.dwMajorVersion;
                    OsMinor = (int)info.dwMinorVersion;
                    OsBuild = (int)info.dwBuildNumber;
                    return;
                }
            }
            catch { }
            try
            {
                Version version = Environment.OSVersion.Version;
                OsMajor = version.Major;
                OsMinor = version.Minor;
                OsBuild = version.Build;
            }
            catch
            {
                OsMajor = 0;
                OsMinor = 0;
                OsBuild = 0;
            }
        }

        private static string OsVersionString()
        {
            EnsureOsVersion();
            if (OsMajor <= 0) return "unknown";
            return "Microsoft Windows " + OsMajor + "." + OsMinor + "." + OsBuild;
        }

        private static int OsBuildNumber()
        {
            EnsureOsVersion();
            return OsBuild;
        }

        private static Dictionary<string, object> BuildStatus()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["protocol"] = ProtocolVersion;
            d["pid"] = Process.GetCurrentProcess().Id;
            d["helperVersion"] = HelperVersion;
            d["osVersion"] = OsVersionString();
            d["dpiAware"] = DpiAware;
            d["capabilities"] = Capabilities();
            Rectangle vs = VirtualScreenRect();
            d["virtual"] = D("x", vs.X, "y", vs.Y, "w", vs.Width, "h", vs.Height);
            d["monitors"] = MonitorsData();
            POINT p;
            GetCursorPos(out p);
            d["cursor"] = D("x", p.X, "y", p.Y);
            d["foreground"] = WindowInfo(GetForegroundWindow());
            d["hotkey"] = D("registered", HotkeyRegistered, "combo", HotkeyCombo);
            d["abortHotkeyRegistered"] = AbortHotkeyRegistered;
            d["abortHotkey"] = D("registered", AbortHotkeyRegistered, "combo", AbortHotkeyCombo,
                                 "lastError", AbortHotkeyRegistered ? "" : HotkeyLastError);
            d["softHotkeyRegistered"] = SoftHotkeyRegistered;
            d["softHotkey"] = D("registered", SoftHotkeyRegistered, "combo", SoftHotkeyCombo,
                                 "lastError", SoftHotkeyRegistered ? "" : "soft stop unavailable");
            // D-08: the host must refuse to arm when the emergency stop hotkey is
            // not registered. Exposed explicitly so status/doctor can fail loud.
            d["safeToArm"] = AbortHotkeyRegistered;
            d["hotkeys"] = D("arm", D("registered", HotkeyRegistered, "combo", HotkeyCombo),
                             "abort", D("registered", AbortHotkeyRegistered, "combo", AbortHotkeyCombo,
                                        "lastError", AbortHotkeyRegistered ? "" : HotkeyLastError));
            d["overlay"] = D("available", OverlayAvailable(), "visible", LatticeVisible || PillVisible,
                             "captureExcluded", CurrentCaptureExcluded(),
                             "hitTestable", (LatticeVisible && LatticeHitTestable) || (PillVisible && PillHitTestable),
                             "latticeHitTestable", LatticeVisible && LatticeHitTestable,
                             "pillHitTestable", PillVisible && PillHitTestable,
                             "pillClickThrough", PillVisible && !PillHitTestable,
                             "stopHitTestable", StopVisible && StopHitTestable,
                             "pointProbe", OverlayPointProbe());
            d["buttonsDown"] = CurrentButtonsDown();
            d["physicalButtonsDown"] = PhysicalButtonsDown();
            d["elevated"] = IsProcessElevated();
            return d;
        }

        private static Dictionary<string, object> Capabilities()
        {
            return D("keyboard", true,
                     "clipboard", true,
                     "printWindow", true,
                     "escWatch", true,
                     "humanInputWatch", true,
                     "humanMouseWatch", true,
                     "focus", true,
                     "abortHotkey", true,
                     "physicalButtons", true,
                     "overlayHitTest", true,
                     "focusDetail", true);
        }

        private static Dictionary<string, object> CurrentButtonsDown()
        {
            bool left, right, middle;
            lock (ButtonLock)
            {
                left = ButtonLeftDown;
                right = ButtonRightDown;
                middle = ButtonMiddleDown;
            }
            return D("left", left, "right", right, "middle", middle);
        }

        // Real OS-level button state (GetAsyncKeyState), independent of what
        // this helper believes it pressed. Catches a button left down by
        // another process.
        private static Dictionary<string, object> PhysicalButtonsDown()
        {
            return D("left", KeyDown(0x01), "right", KeyDown(0x02), "middle", KeyDown(0x04));
        }

        private static bool CurrentCaptureExcluded()
        {
            bool visible = LatticeVisible || PillVisible || StopVisible;
            if (!visible) return false;
            bool ok = true;
            if (LatticeVisible && !LatticeExcluded) ok = false;
            if (PillVisible && !PillExcluded) ok = false;
            if (StopVisible && !StopExcluded) ok = false;
            return ok;
        }

        // A window without WS_EX_TRANSPARENT is hit-testable: clicks under it
        // land on the overlay instead of the application underneath.
        private static bool IsHitTestable(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            try { if (!IsWindow(hWnd)) return false; } catch { return false; }
            return (GetExStyle(hWnd) & WS_EX_TRANSPARENT) == 0;
        }

        // D-12 regression probe. Asks the OS which window a click at the pill
        // label area / the STOP button would reach. After the split the label
        // point must NOT resolve to one of our own windows (click-through)
        // while the STOP point must. Uses Win32 only, so it is safe to call
        // from the helper's RPC reader thread.
        private static Dictionary<string, object> OverlayPointProbe()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            try
            {
                d["pill"] = ProbeOwnHandle(PillHandle, PillVisible, true);
                d["stop"] = ProbeOwnHandle(StopHandle, StopVisible, false);
            }
            catch (Exception ex)
            {
                d["error"] = Describe(ex);
            }
            return d;
        }

        private static Dictionary<string, object> ProbeOwnHandle(IntPtr handle, bool visible, bool labelArea)
        {
            if (handle == IntPtr.Zero || !visible || !IsWindow(handle)) return D("visible", false);
            RECT r;
            if (!GetWindowRect(handle, out r)) return D("visible", true, "error", "GetWindowRect failed");
            int x = labelArea ? r.Left + 40 : r.Left + (r.Right - r.Left) / 2;
            int y = r.Top + (r.Bottom - r.Top) / 2;
            POINT p;
            p.X = x;
            p.Y = y;
            IntPtr hit = WindowFromPoint(p);
            IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, GA_ROOT);
            uint pid = 0;
            if (hit != IntPtr.Zero) GetWindowThreadProcessId(hit, out pid);
            return D("visible", true, "x", x, "y", y,
                     "own", IsOwnWindow(hit) || IsOwnWindow(root),
                     "pid", (int)pid);
        }

        private static bool OverlayAvailable()
        {
            if (OverlayAvailableCache.HasValue) return OverlayAvailableCache.Value;
            bool ok = true;
            try
            {
                IntPtr station = GetProcessWindowStation();
                if (station != IntPtr.Zero)
                {
                    USEROBJECTFLAGS flags = new USEROBJECTFLAGS();
                    int needed;
                    bool got = GetUserObjectInformationW(station, UOI_FLAGS, ref flags,
                        Marshal.SizeOf(typeof(USEROBJECTFLAGS)), out needed);
                    if (got) ok = (flags.dwFlags & WSF_VISIBLE) != 0;
                }
            }
            catch { ok = true; }
            OverlayAvailableCache = ok;
            return ok;
        }

        private static Dictionary<string, object> DoSetDeny(Dictionary<string, object> req)
        {
            List<string> procs = new List<string>();
            List<string> classes = new List<string>();
            object raw;
            if (req.TryGetValue("processes", out raw) && raw != null)
            {
                ForEachItem(raw, delegate(object item)
                {
                    if (item == null) return;
                    string s = Convert.ToString(item, CultureInfo.InvariantCulture);
                    if (s != null && s.Trim().Length > 0) procs.Add(NormalizeProcDeny(s.Trim()));
                });
            }
            if (req.TryGetValue("classes", out raw) && raw != null)
            {
                ForEachItem(raw, delegate(object item)
                {
                    if (item == null) return;
                    string s = Convert.ToString(item, CultureInfo.InvariantCulture);
                    if (s != null && s.Trim().Length > 0) classes.Add(s.Trim().ToLowerInvariant());
                });
            }
            lock (DenyLock)
            {
                DenyProcesses = procs;
                DenyClasses = classes;
            }
            return D("deniedProcesses", procs, "deniedClasses", classes,
                     "processes", procs.Count, "classes", classes.Count);
        }

        private static string NormalizeProcDeny(string value)
        {
            try
            {
                string name = Path.GetFileName(value);
                if (name != null && name.Length > 0) return name.ToLowerInvariant();
            }
            catch { }
            return value.ToLowerInvariant();
        }

        private static bool IsDenied(string title, string className, string processPath)
        {
            string cls = (className == null ? "" : className).ToLowerInvariant();
            string ttl = (title == null ? "" : title).ToLowerInvariant();
            for (int i = 0; i < BaseDenyClasses.Length; i++)
            {
                string token = BaseDenyClasses[i].ToLowerInvariant();
                if (cls.IndexOf(token, StringComparison.Ordinal) >= 0) return true;
                if (ttl.IndexOf(token, StringComparison.Ordinal) >= 0) return true;
            }
            string baseName = "";
            try
            {
                if (!string.IsNullOrEmpty(processPath)) baseName = Path.GetFileName(processPath).ToLowerInvariant();
            }
            catch { baseName = ""; }
            lock (DenyLock)
            {
                for (int i = 0; i < DenyClasses.Count; i++)
                {
                    if (cls.IndexOf(DenyClasses[i], StringComparison.Ordinal) >= 0) return true;
                }
                for (int i = 0; i < DenyProcesses.Count; i++)
                {
                    if (baseName.Length > 0 && baseName == DenyProcesses[i]) return true;
                }
            }
            return false;
        }

        // ------------------------------------------------------------------
        // Focus (v4)
        // ------------------------------------------------------------------

        // Raises an existing top-level window to the foreground without
        // injecting mouse/keyboard input and without changing its size or
        // position. A minimized window is restored first (restore defaults to
        // true), which is the only geometry change and returns it to the rect
        // it had before it was minimized.
        private static Dictionary<string, object> DoFocus(Dictionary<string, object> req)
        {
            if (!HasArg(req, "handle"))
                throw new InvalidOperationException("focus requires a handle");
            long handle;
            try
            {
                handle = Convert.ToInt64(req["handle"], CultureInfo.InvariantCulture);
            }
            catch
            {
                throw new InvalidOperationException("invalid handle argument");
            }
            if (handle == 0)
                throw new InvalidOperationException("focus requires a non-zero handle");
            IntPtr hWnd = new IntPtr(handle);
            if (!IsWindow(hWnd))
                throw new InvalidOperationException("focus handle is not a valid window: " + handle);
            if (IsOwnWindow(hWnd))
                throw new InvalidOperationException("focus handle refers to the helper's own window");

            IntPtr fgBefore = GetForegroundWindow();
            bool restore = BoolArg(req, "restore", true);
            bool wasMinimized = IsIconic(hWnd);
            if (wasMinimized && restore)
            {
                try { ShowWindow(hWnd, SW_RESTORE); } catch { }
            }

            int attempts = 0;
            bool setFgOk = false;
            int lastError = 0;

            try
            {
                setFgOk = SetForegroundWindow(hWnd);
                attempts++;
                if (!setFgOk) lastError = Marshal.GetLastWin32Error();
            }
            catch { setFgOk = false; }
            bool foregroundNow = GetForegroundWindow() == hWnd;

            // A background process is normally not allowed to steal focus, so
            // SetForegroundWindow can be refused. The standard Win32 workaround
            // is to attach to the current foreground input queue for the call
            // and detach immediately afterwards; the short poll absorbs the
            // asynchronous activation switch.
            if (!foregroundNow)
            {
                // AttachThreadInput needs a message queue on the calling thread;
                // the worker thread has none, and PeekMessageW(PM_NOREMOVE)
                // creates one on demand without consuming anything.
                try
                {
                    MSG ignored;
                    PeekMessageW(out ignored, IntPtr.Zero, 0, 0, 0);
                }
                catch { }
                IntPtr previous = GetForegroundWindow();
                if (previous != IntPtr.Zero && previous != hWnd)
                {
                    uint previousPid;
                    uint previousThread = GetWindowThreadProcessId(previous, out previousPid);
                    uint ownThread = GetCurrentThreadId();
                    bool attached = false;
                    if (previousThread != 0 && previousThread != ownThread)
                    {
                        try { attached = AttachThreadInput(previousThread, ownThread, true); }
                        catch { attached = false; }
                    }
                    try
                    {
                        if (attached)
                        {
                            try
                            {
                                setFgOk = SetForegroundWindow(hWnd);
                                attempts++;
                                if (!setFgOk) lastError = Marshal.GetLastWin32Error();
                            }
                            catch { }
                        }
                    }
                    finally
                    {
                        if (attached)
                        {
                            try { AttachThreadInput(previousThread, ownThread, false); } catch { }
                        }
                    }
                }
                // Second, stronger round: a foreground lock can ignore a bare
                // SetForegroundWindow but honour it once the window has been
                // raised to the top of its z-order. No size/position change.
                foregroundNow = GetForegroundWindow() == hWnd;
                if (!foregroundNow)
                {
                    try { BringWindowToTop(hWnd); } catch { }
                    try
                    {
                        SetWindowPos(hWnd, HWND_TOP, 0, 0, 0, 0,
                                     SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    }
                    catch { }
                    try
                    {
                        setFgOk = SetForegroundWindow(hWnd);
                        attempts++;
                        if (!setFgOk) lastError = Marshal.GetLastWin32Error();
                    }
                    catch { }
                }
                for (int i = 0; i < 15 && !foregroundNow; i++)
                {
                    Thread.Sleep(40);
                    foregroundNow = GetForegroundWindow() == hWnd;
                }
            }

            IntPtr fgAfter = GetForegroundWindow();
            foregroundNow = fgAfter == hWnd;
            bool minimized = IsIconic(hWnd);
            string reason = foregroundNow ? "" : "foreground-lock";
            return D(
                "focused", foregroundNow,
                "foregroundNow", foregroundNow,
                "window", WindowInfo(hWnd),
                "wasMinimized", wasMinimized,
                "restored", wasMinimized && restore && !minimized,
                "minimized", minimized,
                "restoreRequested", restore,
                "foregroundBefore", WindowInfo(fgBefore),
                "foregroundAfter", WindowInfo(fgAfter),
                "reason", reason,
                "attempts", attempts,
                "setForegroundOk", setFgOk,
                "lastError", lastError);
        }

        // ------------------------------------------------------------------
        // Windows enumeration
        // ------------------------------------------------------------------

        private static Dictionary<string, object> DoWindows()
        {
            WindowCollector = new List<object>();
            EnumWindows(new EnumWindowsProc(EnumWindowsCallback), IntPtr.Zero);
            return D("windows", WindowCollector);
        }

        private static bool EnumWindowsCallback(IntPtr hWnd, IntPtr lParam)
        {
            if (hWnd == IntPtr.Zero) return true;
            if (IsOwnWindow(hWnd)) return true;
            if (!IsWindowVisible(hWnd)) return true;
            if ((GetExStyle(hWnd) & WS_EX_TOOLWINDOW) != 0) return true;
            if (IsCloaked(hWnd)) return true;
            if (WindowCollector != null) WindowCollector.Add(WindowInfo(hWnd));
            return true;
        }

        private static bool IsCloaked(IntPtr hWnd)
        {
            try
            {
                int cloaked = 0;
                int hr = DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, 4);
                return hr == 0 && cloaked != 0;
            }
            catch { return false; }
        }

        private static Dictionary<string, object> DoProbeAt(Dictionary<string, object> req)
        {
            int x = IntArgRequired(req, "x");
            int y = IntArgRequired(req, "y");
            POINT p = new POINT();
            p.X = x;
            p.Y = y;
            IntPtr root = WindowAtPoint(p);
            return D("window", WindowInfo(root));
        }

        private static IntPtr WindowAtPoint(POINT p)
        {
            IntPtr h = WindowFromPoint(p);
            IntPtr root = h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, GA_ROOT);
            if (IsOwnWindow(root))
            {
                ProbePoint = p;
                ProbeResult = IntPtr.Zero;
                EnumWindows(new EnumWindowsProc(ProbeWindowCallback), IntPtr.Zero);
                return ProbeResult;
            }
            return root;
        }

        private static bool ProbeWindowCallback(IntPtr hWnd, IntPtr lParam)
        {
            if (hWnd == IntPtr.Zero || ProbeResult != IntPtr.Zero) return true;
            if (!IsWindowVisible(hWnd)) return true;
            if (IsOwnWindow(hWnd)) return true;
            if ((GetExStyle(hWnd) & WS_EX_TRANSPARENT) != 0) return true;
            if (IsCloaked(hWnd)) return true;
            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            if (ProbePoint.X >= r.Left && ProbePoint.X < r.Right &&
                ProbePoint.Y >= r.Top && ProbePoint.Y < r.Bottom)
            {
                ProbeResult = hWnd;
                return false;
            }
            return true;
        }

        private static bool IsOwnWindow(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            if (hWnd == PumpHandle) return true;
            if (LatticeHandle != IntPtr.Zero && hWnd == LatticeHandle) return true;
            if (PillHandle != IntPtr.Zero && hWnd == PillHandle) return true;
            if (StopHandle != IntPtr.Zero && hWnd == StopHandle) return true;
            return false;
        }

        private static Dictionary<string, object> WindowInfo(IntPtr hWnd)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            if (hWnd == IntPtr.Zero)
            {
                d["handle"] = 0;
                d["title"] = "";
                d["className"] = "";
                d["pid"] = 0;
                d["process"] = "";
                d["rect"] = D("x", 0, "y", 0, "w", 0, "h", 0, "width", 0, "height", 0);
                d["minimized"] = false;
                d["elevated"] = false;
                d["denied"] = false;
                return d;
            }
            StringBuilder title = new StringBuilder(1024);
            GetWindowTextW(hWnd, title, title.Capacity);
            StringBuilder cls = new StringBuilder(256);
            GetClassNameW(hWnd, cls, cls.Capacity);
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT r;
            GetWindowRect(hWnd, out r);
            string path = ProcessPath(pid);
            string t = title.ToString();
            string c = cls.ToString();
            d["handle"] = hWnd.ToInt64();
            d["title"] = t;
            d["className"] = c;
            d["pid"] = (int)pid;
            d["process"] = path;
            int rw = r.Right - r.Left;
            int rh = r.Bottom - r.Top;
            // Protocol names the rect fields w/h; width/height aliases keep older
            // host builds (which read rect.width/rect.height) working as well.
            d["rect"] = D("x", r.Left, "y", r.Top, "w", rw, "h", rh,
                          "width", rw, "height", rh);
            d["minimized"] = IsIconic(hWnd);
            d["elevated"] = IsProcessElevatedById(pid);
            d["denied"] = IsDenied(t, c, path);
            return d;
        }

        private static string ProcessPath(uint pid)
        {
            if (pid == 0) return "";
            IntPtr h = IntPtr.Zero;
            try
            {
                h = OpenProcess(0x1000, false, pid);
                if (h == IntPtr.Zero) return "";
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (QueryFullProcessImageNameW(h, 0, sb, ref size)) return sb.ToString();
                return "";
            }
            catch { return ""; }
            finally
            {
                if (h != IntPtr.Zero) CloseHandle(h);
            }
        }

        private static bool IsProcessElevatedById(uint pid)
        {
            if (pid == 0) return false;
            IntPtr h = IntPtr.Zero;
            try
            {
                h = OpenProcess(0x1000, false, pid);
                if (h == IntPtr.Zero) return true; // cannot query: fail closed
                IntPtr token = IntPtr.Zero;
                if (!OpenProcessToken(h, 0x0008, out token)) return true;
                try
                {
                    int size = 0;
                    GetTokenInformation(token, 20, IntPtr.Zero, 0, out size);
                    if (size <= 0) return true;
                    IntPtr buf = Marshal.AllocHGlobal(size);
                    try
                    {
                        int returned = 0;
                        if (!GetTokenInformation(token, 20, buf, size, out returned)) return true;
                        return Marshal.ReadInt32(buf) != 0;
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
                finally { CloseHandle(token); }
            }
            catch { return true; }
            finally
            {
                if (h != IntPtr.Zero) CloseHandle(h);
            }
        }

        private static bool IsProcessElevated()
        {
            try
            {
                IntPtr token = IntPtr.Zero;
                if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out token)) return false;
                try
                {
                    int size = 0;
                    GetTokenInformation(token, 20, IntPtr.Zero, 0, out size);
                    if (size <= 0) return false;
                    IntPtr buf = Marshal.AllocHGlobal(size);
                    try
                    {
                        int returned = 0;
                        if (!GetTokenInformation(token, 20, buf, size, out returned)) return false;
                        return Marshal.ReadInt32(buf) != 0;
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
                finally { CloseHandle(token); }
            }
            catch { return false; }
        }

        // ------------------------------------------------------------------
        // Monitors
        // ------------------------------------------------------------------

        internal static Rectangle VirtualScreenRect()
        {
            int x = GetSystemMetrics(76);
            int y = GetSystemMetrics(77);
            int w = GetSystemMetrics(78);
            int h = GetSystemMetrics(79);
            if (w <= 0) w = 1;
            if (h <= 0) h = 1;
            return new Rectangle(x, y, w, h);
        }

        private static List<object> MonitorsData()
        {
            MonitorCollector = new List<object>();
            try
            {
                EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, new MonitorEnumProc(MonitorEnumCallback), IntPtr.Zero);
            }
            catch (Exception ex)
            {
                LogErr("monitor enum failed: " + Describe(ex));
            }
            if (MonitorCollector.Count == 0)
            {
                Rectangle vs = VirtualScreenRect();
                MonitorCollector.Add(D("id", 0, "device", "virtual", "primary", true,
                    "x", vs.X, "y", vs.Y, "w", vs.Width, "h", vs.Height, "scale", 1.0));
            }
            return MonitorCollector;
        }

        private static bool MonitorEnumCallback(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData)
        {
            try
            {
                MONITORINFOEX mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (!GetMonitorInfoW(hMonitor, ref mi)) return true;
                uint dpiX = 96;
                uint dpiY = 96;
                TryGetDpiForMonitor(hMonitor, out dpiX, out dpiY);
                double scale = dpiX > 0 ? Math.Round(dpiX / 96.0, 4) : 1.0;
                if (MonitorCollector == null) MonitorCollector = new List<object>();
                MonitorCollector.Add(D(
                    "id", MonitorCollector.Count,
                    "device", mi.szDevice == null ? "" : mi.szDevice,
                    "primary", (mi.dwFlags & 1) != 0,
                    "x", mi.rcMonitor.Left,
                    "y", mi.rcMonitor.Top,
                    "w", mi.rcMonitor.Right - mi.rcMonitor.Left,
                    "h", mi.rcMonitor.Bottom - mi.rcMonitor.Top,
                    "scale", scale));
            }
            catch (Exception ex)
            {
                LogErr("monitor callback: " + Describe(ex));
            }
            return true;
        }

        private static bool DpiApiFailed = false;

        private static bool TryGetDpiForMonitor(IntPtr hMonitor, out uint dpiX, out uint dpiY)
        {
            dpiX = 96;
            dpiY = 96;
            if (DpiApiFailed) return false;
            try
            {
                uint x;
                uint y;
                int hr = GetDpiForMonitor(hMonitor, 0, out x, out y);
                if (hr == 0 && x > 0)
                {
                    dpiX = x;
                    dpiY = y > 0 ? y : x;
                    return true;
                }
                return false;
            }
            catch (Exception ex)
            {
                DpiApiFailed = true;
                LogErr("GetDpiForMonitor unavailable: " + Describe(ex));
                return false;
            }
        }

        private static Rectangle PrimaryMonitorBounds()
        {
            Rectangle result = VirtualScreenRect();
            try
            {
                List<object> monitors = MonitorsData();
                for (int i = 0; i < monitors.Count; i++)
                {
                    Dictionary<string, object> m = monitors[i] as Dictionary<string, object>;
                    if (m == null) continue;
                    if (BoolArg(m, "primary", false))
                    {
                        return new Rectangle(IntArg(m, "x", 0), IntArg(m, "y", 0),
                            IntArg(m, "w", result.Width), IntArg(m, "h", result.Height));
                    }
                }
            }
            catch { }
            return result;
        }

        // ------------------------------------------------------------------
        // Capture
        // ------------------------------------------------------------------

        internal static void SavePng(Bitmap bmp, string path)
        {
            try
            {
                string dir = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                bmp.Save(path, ImageFormat.Png);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("save png failed (" + path + "): " + Describe(ex));
            }
        }

        private static string HashAndBlackCheck(Bitmap bmp, out bool black)
        {
            black = true;
            BitmapData bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = bd.Stride;
                int width = bmp.Width;
                int height = bmp.Height;
                int total = stride * height;
                byte[] buf = new byte[total];
                Marshal.Copy(bd.Scan0, buf, 0, total);
                long pixels = (long)width * height;
                int step = (int)Math.Max(1, pixels / 8192);
                long samples = 0;
                long dark = 0;
                for (long i = 0; i < pixels; i += step)
                {
                    int row = (int)(i / width);
                    int col = (int)(i - (long)row * width);
                    int off = row * stride + col * 4;
                    byte b = buf[off];
                    byte g = buf[off + 1];
                    byte r = buf[off + 2];
                    samples++;
                    if (r < 12 && g < 12 && b < 12) dark++;
                }
                black = samples > 0 && dark * 100 >= samples * 98;
                using (SHA256 sha = SHA256.Create())
                {
                    byte[] hash = sha.ComputeHash(buf);
                    StringBuilder sb = new StringBuilder(64);
                    for (int i = 0; i < hash.Length; i++) sb.Append(hash[i].ToString("x2"));
                    return sb.ToString();
                }
            }
            finally
            {
                bmp.UnlockBits(bd);
            }
        }

        private static string HashBitmap(Bitmap bmp)
        {
            bool black;
            return HashAndBlackCheck(bmp, out black);
        }

        // v10 (D-03): bounding box of the non-black pixels, sampled every
        // `step` px. Used to detect a PrintWindow frame that only filled the
        // top-left (w/s, h/s) of the physical bitmap (DPI-unaware target).
        private static Rectangle ContentBounds(Bitmap bmp, int step)
        {
            if (step < 1) step = 1;
            BitmapData bd = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
                ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int stride = bd.Stride;
                int width = bmp.Width;
                int height = bmp.Height;
                byte[] buf = new byte[stride * height];
                Marshal.Copy(bd.Scan0, buf, 0, buf.Length);
                int minX = width, minY = height, maxX = -1, maxY = -1;
                for (int row = 0; row < height; row += step)
                {
                    int rowOff = row * stride;
                    for (int col = 0; col < width; col += step)
                    {
                        int off = rowOff + col * 4;
                        if (buf[off] >= 12 || buf[off + 1] >= 12 || buf[off + 2] >= 12)
                        {
                            if (col < minX) minX = col;
                            if (col > maxX) maxX = col;
                            if (row < minY) minY = row;
                            if (row > maxY) maxY = row;
                        }
                    }
                }
                if (maxX < 0 || maxY < 0) return Rectangle.Empty;
                return new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
            }
            finally
            {
                bmp.UnlockBits(bd);
            }
        }

        // v10 (D-03): DPI_AWARENESS of a window: 0 unaware, 1 system, 2 per
        // monitor, -1 unknown (API missing or window gone).
        private static int WindowAwareness(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return -1;
            try
            {
                IntPtr ctx = GetWindowDpiAwarenessContext(hWnd);
                if (ctx == IntPtr.Zero) return -1;
                return GetAwarenessFromDpiAwarenessContext(ctx);
            }
            catch
            {
                return -1;
            }
        }

        // D-03b: the scale of the monitor that contains this physical point
        // (a DPI-unaware window paints in ITS monitor's DIP space, which is
        // not necessarily the primary monitor, and is 1.25/1.5 on some setups).
        private static double MonitorScaleAt(int x, int y)
        {
            try
            {
                List<object> list = MonitorsData();
                for (int i = 0; i < list.Count; i++)
                {
                    Dictionary<string, object> m = list[i] as Dictionary<string, object>;
                    if (m == null) continue;
                    int mx = Convert.ToInt32(m["x"], CultureInfo.InvariantCulture);
                    int my = Convert.ToInt32(m["y"], CultureInfo.InvariantCulture);
                    int mw = Convert.ToInt32(m["w"], CultureInfo.InvariantCulture);
                    int mh = Convert.ToInt32(m["h"], CultureInfo.InvariantCulture);
                    if (x < mx || y < my || x >= mx + mw || y >= my + mh) continue;
                    object sc;
                    if (m.TryGetValue("scale", out sc) && sc != null)
                        return Convert.ToDouble(sc, CultureInfo.InvariantCulture);
                }
            }
            catch { }
            return PrimaryMonitorScale();
        }

        private static double PrimaryMonitorScale()
        {
            try
            {
                List<object> list = MonitorsData();
                for (int i = 0; i < list.Count; i++)
                {
                    Dictionary<string, object> m = list[i] as Dictionary<string, object>;
                    if (m == null) continue;
                    object prim;
                    if (!m.TryGetValue("primary", out prim) || !(prim is bool) || !(bool)prim) continue;
                    object sc;
                    if (m.TryGetValue("scale", out sc) && sc != null)
                        return Convert.ToDouble(sc, CultureInfo.InvariantCulture);
                }
            }
            catch { }
            return 1.0;
        }

        // v10 (D-03): decide which DPI space PrintWindow rendered into. A
        // DPI-unaware target paints in its own 1x space, so only the
        // top-left w/s x h/s of the physical bitmap holds content. We crop
        // ONLY when the measured content bbox agrees with that prediction
        // (safety interlock: a DPI-aware window painted into a small corner
        // would exceed the 1x boundary and is never cropped). On success the
        // bitmap is replaced by the 1x content and the normal upscale path
        // then produces a full, correctly mapped image.
        private static Dictionary<string, object> ArbitrateWindowContent(ref Bitmap raw, IntPtr hWnd, int x, int y, int w, int h)
        {
            int awareness = WindowAwareness(hWnd);
            double monitorScale = MonitorScaleAt(x + w / 2, y + h / 2);
            double s = (awareness == 0 && monitorScale > 1.01) ? monitorScale : 1.0;
            Rectangle cb = ContentBounds(raw, 2);
            string mismatch = null;
            bool cropped = false;
            if (s > 1.0)
            {
                int cw = (int)Math.Round(w / s);
                int ch = (int)Math.Round(h / s);
                if (!cb.IsEmpty && cw >= 2 && ch >= 2 && cb.Right <= cw + 2 && cb.Bottom <= ch + 2)
                {
                    try
                    {
                        Bitmap crop = raw.Clone(new Rectangle(0, 0, cw, ch), raw.PixelFormat);
                        raw.Dispose();
                        raw = crop;
                        cropped = true;
                    }
                    catch (Exception ex)
                    {
                        LogErr("dpi crop failed: " + Describe(ex));
                        mismatch = "unexplained";
                    }
                }
                else
                {
                    mismatch = "unexplained";
                }
            }
            bool filled = (int)Math.Round((double)raw.Width) == w && (int)Math.Round((double)raw.Height) == h;
            return D("contentScale", cropped ? s : 1.0,
                     "targetDpi", awareness == 0 ? "unaware" : awareness == 1 ? "system" : awareness == 2 ? "perMonitor" : "unknown",
                     "frameFilled", filled,
                     "mismatch", cropped ? "dpi-virtualized" : mismatch);
        }

        private static Bitmap CopyScreenRegion(int x, int y, int w, int h)
        {
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                }
                return bmp;
            }
            catch (Exception ex)
            {
                bmp.Dispose();
                throw new InvalidOperationException("screen copy failed (" + x + "," + y + "," + w + "," + h + "): " + Describe(ex));
            }
        }
        private static void RequireRegionInVirtual(Rectangle region)
        {
            Rectangle vs = VirtualScreenRect();
            if (region.Width <= 0 || region.Height <= 0)
                throw new InvalidOperationException("capture region must be positive");
            if (region.X < vs.X || region.Y < vs.Y ||
                region.Right > vs.Right || region.Bottom > vs.Bottom)
                throw new InvalidOperationException("capture region outside virtual screen: " +
                    region.X + "," + region.Y + "," + region.Width + "," + region.Height);
            if ((long)region.Width * region.Height > 100000000L)
                throw new InvalidOperationException("capture region too large");
        }

        // Validates a v2 windowHandle target and returns its screen rect. Only
        // top-level, non-minimized, non-zero-size windows are accepted; the
        // helper's own windows are refused.
        private static Rectangle WindowCaptureRect(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
                throw new InvalidOperationException("capture windowHandle is not a valid window: " + hWnd.ToInt64());
            if (IsOwnWindow(hWnd))
                throw new InvalidOperationException("capture windowHandle refers to the helper's own window");
            if (IsIconic(hWnd))
                throw new InvalidOperationException("capture window is minimized: " + hWnd.ToInt64());
            RECT r;
            if (!GetWindowRect(hWnd, out r))
                throw new InvalidOperationException("capture window rect unavailable: " + hWnd.ToInt64());
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;
            if (w <= 0 || h <= 0)
                throw new InvalidOperationException("capture window has zero size: " + w + "x" + h);
            if ((long)w * h > 100000000L)
                throw new InvalidOperationException("capture window too large: " + w + "x" + h);
            return new Rectangle(r.Left, r.Top, w, h);
        }

        // v7 clientOnly: validates a windowHandle target and returns its CLIENT
        // area rect in screen coordinates (GetClientRect size + ClientToScreen
        // origin), used as the PrintWindow(PW_CLIENTONLY) output region.
        private static Rectangle WindowClientCaptureRect(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero || !IsWindow(hWnd))
                throw new InvalidOperationException("capture windowHandle is not a valid window: " + hWnd.ToInt64());
            if (IsOwnWindow(hWnd))
                throw new InvalidOperationException("capture windowHandle refers to the helper's own window");
            if (IsIconic(hWnd))
                throw new InvalidOperationException("capture window is minimized: " + hWnd.ToInt64());
            RECT cr;
            if (!GetClientRect(hWnd, out cr))
                throw new InvalidOperationException("capture client rect unavailable: " + hWnd.ToInt64());
            int w = cr.Right - cr.Left;
            int h = cr.Bottom - cr.Top;
            if (w <= 0 || h <= 0)
                throw new InvalidOperationException("capture client area has zero size: " + w + "x" + h);
            if ((long)w * h > 100000000L)
                throw new InvalidOperationException("capture client area too large: " + w + "x" + h);
            POINT origin = new POINT();
            origin.X = 0;
            origin.Y = 0;
            if (!ClientToScreen(hWnd, ref origin))
                throw new InvalidOperationException("capture client origin unavailable: " + hWnd.ToInt64());
            return new Rectangle(origin.X, origin.Y, w, h);
        }

        // PrintWindow(PW_RENDERFULLCONTENT) render of a window, so a background
        // or occluded window can be captured without raising it. clientOnly uses
        // PW_CLIENTONLY so only the client area is rendered (FB-07).
        private static Bitmap CaptureWindowBitmap(IntPtr hWnd, Rectangle region, bool clientOnly)
        {
            int w = region.Width;
            int h = region.Height;
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    bool printed;
                    try
                    {
                        printed = PrintWindow(hWnd, hdc, (uint)(clientOnly ? PW_CLIENTONLY : PW_RENDERFULLCONTENT));
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                    if (!printed)
                        throw new InvalidOperationException("PrintWindow failed for window " + hWnd.ToInt64());
                }
                return bmp;
            }
            catch
            {
                bmp.Dispose();
                throw;
            }
        }

        private static Rectangle ComputeOutputSize(int w, int h, double scale, int outWArg, int outHArg,
            out double actualScale)
        {
            int outW;
            int outH;
            if (outWArg > 0 && outHArg > 0)
            {
                outW = outWArg;
                outH = outHArg;
            }
            else if (outWArg > 0)
            {
                outW = outWArg;
                outH = Math.Max(1, (int)Math.Round((double)outW * h / Math.Max(1, w)));
            }
            else if (outHArg > 0)
            {
                outH = outHArg;
                outW = Math.Max(1, (int)Math.Round((double)outH * w / Math.Max(1, h)));
            }
            else
            {
                if (scale <= 0) scale = 1.0;
                if (scale > 8.0) scale = 8.0;
                outW = Math.Max(1, (int)Math.Round(w * scale));
                outH = Math.Max(1, (int)Math.Round(h * scale));
            }
            if (outW > 8192) outW = 8192;
            if (outH > 8192) outH = 8192;
            actualScale = (double)outW / Math.Max(1, w);
            return new Rectangle(0, 0, outW, outH);
        }

        private static void DrawCross(Graphics g, int cx, int cy, int arm, Color color, float width)
        {
            using (Pen shadow = new Pen(Color.FromArgb(200, 0, 0, 0), width + 2.0f))
            {
                g.DrawLine(shadow, cx - arm, cy, cx + arm, cy);
                g.DrawLine(shadow, cx, cy - arm, cx, cy + arm);
            }
            using (Pen pen = new Pen(color, width))
            {
                g.DrawLine(pen, cx - arm, cy, cx + arm, cy);
                g.DrawLine(pen, cx, cy - arm, cx, cy + arm);
            }
        }

        private static void DrawLattice(Graphics g, int outW, int outH, int srcX, int srcY, int srcW, int srcH,
            int spacing, string style, int majorEvery)
        {
            if (spacing <= 0 || style == null || style == "none") return;
            double sx = (double)outW / Math.Max(1, srcW);
            double sy = (double)outH / Math.Max(1, srcH);
            double spacingImgX = spacing * sx;
            double spacingImgY = spacing * sy;
            if (spacingImgX < 4.0 || spacingImgY < 4.0) return;
            if (majorEvery < 2) majorEvery = 2;

            // Lattice points are aligned to the virtual-screen origin (the same
            // convention the host uses for snapping), not to absolute multiples.
            Rectangle vsGlobal = VirtualScreenRect();
            int firstX = (int)(vsGlobal.X + Math.Ceiling((srcX - (double)vsGlobal.X) / spacing) * spacing);
            int firstY = (int)(vsGlobal.Y + Math.Ceiling((srcY - (double)vsGlobal.Y) / spacing) * spacing);
            int endX = srcX + srcW;
            int endY = srcY + srcH;

            int arm = (int)Math.Round(Math.Min(spacingImgX, spacingImgY) / 8.0);
            if (arm < 3) arm = 3;
            if (arm > 14) arm = 14;
            int majorArm = arm * 2;
            if (majorArm > 22) majorArm = 22;

            Color crossColor = Color.FromArgb(255, 0, 230, 255);
            Color majorColor = Color.FromArgb(255, 255, 220, 40);

            g.SmoothingMode = SmoothingMode.None;
            int i = 0;
            for (int sxScreen = firstX; sxScreen < endX; sxScreen += spacing)
            {
                int imgX = (int)Math.Round((sxScreen - srcX) * sx);
                int j = 0;
                for (int syScreen = firstY; syScreen < endY; syScreen += spacing)
                {
                    int imgY = (int)Math.Round((syScreen - srcY) * sy);
                    if (imgX >= 0 && imgX < outW && imgY >= 0 && imgY < outH)
                    {
                        bool major = style == "hierarchical" && (i % majorEvery == 0) && (j % majorEvery == 0);
                        if (major)
                        {
                            DrawCross(g, imgX, imgY, majorArm, majorColor, 1.6f);
                            using (Pen ring = new Pen(Color.FromArgb(220, 255, 220, 40), 1.2f))
                            {
                                g.DrawEllipse(ring, imgX - majorArm - 3, imgY - majorArm - 3,
                                    (majorArm + 3) * 2, (majorArm + 3) * 2);
                            }
                        }
                        else if (style == "hierarchical")
                        {
                            int smallArm = Math.Max(2, arm / 2);
                            DrawCross(g, imgX, imgY, smallArm, crossColor, 1.0f);
                        }
                        else
                        {
                            DrawCross(g, imgX, imgY, arm, crossColor, 1.0f);
                        }
                    }
                    j++;
                }
                i++;
            }
        }

        private static void DrawMark(Graphics g, int imgX, int imgY, string kind, double scale)
        {
            Color color = kind == "cursor" ? Color.FromArgb(255, 80, 255, 120) : Color.FromArgb(255, 255, 60, 60);
            int radius = (int)Math.Round((kind == "cursor" ? 11.0 : 15.0) * Math.Max(0.75, Math.Min(1.8, scale)));
            using (Pen white = new Pen(Color.FromArgb(255, 255, 255, 255), 3.0f))
            using (Pen pen = new Pen(color, 1.6f))
            {
                g.DrawEllipse(white, imgX - radius, imgY - radius, radius * 2, radius * 2);
                g.DrawEllipse(pen, imgX - radius, imgY - radius, radius * 2, radius * 2);
                g.DrawLine(white, imgX - 3, imgY, imgX + 3, imgY);
                g.DrawLine(white, imgX, imgY - 3, imgX, imgY + 3);
                g.DrawLine(pen, imgX - 2, imgY, imgX + 2, imgY);
                g.DrawLine(pen, imgX, imgY - 2, imgX, imgY + 2);
            }
        }

        private static void DrawCursorIcon(Graphics g, int srcX, int srcY, double sx, double sy)
        {
            try
            {
                CURSORINFO ci = new CURSORINFO();
                ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                if (!GetCursorInfo(ref ci)) return;
                if (ci.flags != CURSOR_SHOWING || ci.hCursor == IntPtr.Zero) return;
                int imgX = (int)Math.Round((ci.ptScreenPos.X - srcX) * sx);
                int imgY = (int)Math.Round((ci.ptScreenPos.Y - srcY) * sy);
                IntPtr hdc = g.GetHdc();
                try
                {
                    DrawIconEx(hdc, imgX, imgY, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                }
                finally
                {
                    g.ReleaseHdc(hdc);
                }
            }
            catch (Exception ex)
            {
                LogErr("draw cursor: " + Describe(ex));
            }
        }

        private sealed class OverlaySuppression
        {
            public bool Lattice;
            public bool Pill;
            public bool Stop;
        }

        private static OverlaySuppression SuppressOverlaysForCapture()
        {
            OverlaySuppression s = new OverlaySuppression();
            try
            {
                Pump.Invoke(new Action(delegate
                {
                    if (LatticeVisible && LatticeWin != null && !LatticeExcluded)
                    {
                        LatticeWin.Hide();
                        s.Lattice = true;
                    }
                    if (PillVisible && PillWin != null && !PillExcluded)
                    {
                        PillWin.Hide();
                        s.Pill = true;
                    }
                    if (StopVisible && StopWin != null && !StopExcluded)
                    {
                        StopWin.Hide();
                        s.Stop = true;
                    }
                }));
            }
            catch (Exception ex)
            {
                LogErr("suppress overlays: " + Describe(ex));
            }
            if (s.Lattice || s.Pill || s.Stop) Thread.Sleep(180);
            return s;
        }

        private static void RestoreOverlaysAfterCapture(OverlaySuppression s)
        {
            if (s == null || (!s.Lattice && !s.Pill && !s.Stop)) return;
            try
            {
                Pump.Invoke(new Action(delegate
                {
                    if (s.Lattice && LatticeWin != null) LatticeWin.ShowNoActivate();
                    if (s.Pill && PillWin != null) PillWin.ShowNoActivate();
                    if (s.Stop && StopWin != null) StopWin.ShowNoActivate();
                }));
            }
            catch (Exception ex)
            {
                LogErr("restore overlays: " + Describe(ex));
            }
        }

        private static Dictionary<string, object> DoCapture(Dictionary<string, object> req)
        {
            Rectangle vs = VirtualScreenRect();
            bool windowMode = HasArg(req, "windowHandle");
            bool clientOnly = BoolArg(req, "clientOnly", false);
            if (clientOnly && !windowMode)
                throw new InvalidOperationException("capture clientOnly requires windowHandle");
            long windowHandle = 0;
            IntPtr windowHwnd = IntPtr.Zero;
            Rectangle region;
            if (windowMode)
            {
                try
                {
                    windowHandle = Convert.ToInt64(req["windowHandle"], CultureInfo.InvariantCulture);
                }
                catch
                {
                    throw new InvalidOperationException("invalid windowHandle argument");
                }
                windowHwnd = new IntPtr(windowHandle);
                region = clientOnly ? WindowClientCaptureRect(windowHwnd) : WindowCaptureRect(windowHwnd);
            }
            else
            {
                int rx = IntArg(req, "x", vs.X);
                int ry = IntArg(req, "y", vs.Y);
                int rw = IntArg(req, "w", vs.Width);
                int rh = IntArg(req, "h", vs.Height);
                region = new Rectangle(rx, ry, rw, rh);
                RequireRegionInVirtual(region);
            }
            int x = region.X;
            int y = region.Y;
            int w = region.Width;
            int h = region.Height;

            string path = StrArg(req, "path", "");
            if (path.Length == 0) throw new InvalidOperationException("capture requires path");
            if (!Path.IsPathRooted(path)) throw new InvalidOperationException("capture path must be absolute");

            double scale = DoubleArg(req, "scale", 1.0);
            int outWArg = IntArg(req, "outW", 0);
            int outHArg = IntArg(req, "outH", 0);
            double actualScale;
            Rectangle outSize = ComputeOutputSize(w, h, scale, outWArg, outHArg, out actualScale);
            int outW = outSize.Width;
            int outH = outSize.Height;

            int spacing = 0;
            string style = "none";
            int majorEvery = 4;
            object latticeRaw;
            if (req.TryGetValue("lattice", out latticeRaw) && latticeRaw != null)
            {
                Dictionary<string, object> lattice = latticeRaw as Dictionary<string, object>;
                if (lattice != null)
                {
                    spacing = IntArg(lattice, "spacing", 0);
                    style = StrArg(lattice, "style", "cross").Trim().ToLowerInvariant();
                    majorEvery = IntArg(lattice, "majorEvery", 4);
                    if (style != "cross" && style != "hierarchical" && style != "none")
                        throw new InvalidOperationException("invalid lattice style: " + style);
                    if (style != "none" && spacing <= 0)
                        throw new InvalidOperationException("lattice spacing must be positive");
                }
            }

            List<Dictionary<string, object>> marks = new List<Dictionary<string, object>>();
            object marksRaw;
            if (req.TryGetValue("marks", out marksRaw) && marksRaw != null)
            {
                ForEachItem(marksRaw, delegate(object item)
                {
                    Dictionary<string, object> md = item as Dictionary<string, object>;
                    if (md == null) return;
                    Dictionary<string, object> mark = new Dictionary<string, object>();
                    mark["x"] = IntArg(md, "x", 0);
                    mark["y"] = IntArg(md, "y", 0);
                    mark["kind"] = StrArg(md, "kind", "target").Trim().ToLowerInvariant();
                    marks.Add(mark);
                });
            }

            bool includeCursor = BoolArg(req, "includeCursor", false);
            bool excludeOverlay = BoolArg(req, "excludeOverlay", false);

            OverlaySuppression suppressed = excludeOverlay && !windowMode ? SuppressOverlaysForCapture() : null;
            try
            {
                Bitmap raw = windowMode
                    ? CaptureWindowBitmap(windowHwnd, region, clientOnly)
                    : CopyScreenRegion(x, y, w, h);
                try
                {
                    bool black;
                    string captureHash = HashAndBlackCheck(raw, out black);
                    if (windowMode && black)
                        throw new InvalidOperationException(
                            (clientOnly
                                ? "window client capture produced a black frame (PrintWindow PW_CLIENTONLY failed)"
                                : "window capture produced a black frame (PrintWindow failed)") +
                            " for handle " + windowHandle);
                    // v10 (D-03): arbitrate the DPI space of the rendered frame
                    // before scaling (crops a 1x-painted frame back to its content).
                    Dictionary<string, object> contentInfo = windowMode
                        ? ArbitrateWindowContent(ref raw, windowHwnd, x, y, w, h)
                        : D("contentScale", 1.0, "targetDpi", "n/a", "frameFilled", true, "mismatch", null);
                    int srcW = raw.Width;
                    int srcH = raw.Height;
                    using (Bitmap output = new Bitmap(outW, outH, PixelFormat.Format32bppArgb))
                    {
                        using (Graphics g = Graphics.FromImage(output))
                        {
                            bool downscale = outW < w || outH < h;
                            g.InterpolationMode = downscale ? InterpolationMode.HighQualityBicubic : InterpolationMode.NearestNeighbor;
                            g.PixelOffsetMode = PixelOffsetMode.Half;
                            g.CompositingMode = CompositingMode.SourceCopy;
                            g.DrawImage(raw, new Rectangle(0, 0, outW, outH), 0, 0, srcW, srcH, GraphicsUnit.Pixel);
                            g.CompositingMode = CompositingMode.SourceOver;
                            if (style != "none") DrawLattice(g, outW, outH, x, y, w, h, spacing, style, majorEvery);
                            double sx = (double)outW / Math.Max(1, w);
                            double sy = (double)outH / Math.Max(1, h);
                            for (int i = 0; i < marks.Count; i++)
                            {
                                int mx = IntArg(marks[i], "x", 0);
                                int my = IntArg(marks[i], "y", 0);
                                int imgX = (int)Math.Round((mx - x) * sx);
                                int imgY = (int)Math.Round((my - y) * sy);
                                if (imgX >= 0 && imgX < outW && imgY >= 0 && imgY < outH)
                                    DrawMark(g, imgX, imgY, StrArg(marks[i], "kind", "target"), Math.Min(sx, sy));
                            }
                            if (includeCursor && !windowMode) DrawCursorIcon(g, x, y, sx, sy);
                        }
                        SavePng(output, path);
                    }

                    int latticeSpacing = Math.Max(1, spacing);
                    int firstX = (int)(vs.X + Math.Ceiling((x - (double)vs.X) / latticeSpacing) * latticeSpacing);
                    int firstY = (int)(vs.Y + Math.Ceiling((y - (double)vs.Y) / latticeSpacing) * latticeSpacing);
                    Dictionary<string, object> latticeData = D(
                        "spacingScreen", spacing,
                        "spacingImage", Math.Round(spacing * actualScale, 3),
                        "originX", firstX,
                        "originY", firstY,
                        "originImageX", Math.Round((firstX - x) * actualScale, 3),
                        "originImageY", Math.Round((firstY - y) * actualScale, 3),
                        "style", style,
                        "majorEvery", majorEvery);
                    Dictionary<string, object> data = D(
                        "path", path,
                        "width", outW,
                        "height", outH,
                        "source", D("x", x, "y", y, "w", w, "h", h),
                        "sourceKind", windowMode ? "window" : "screen",
                        "windowHandle", windowHandle,
                        "clientOnly", clientOnly,
                        "scale", Math.Round(actualScale, 6),
                        "lattice", latticeData,
                        "captureHash", captureHash,
                        "blackFrame", black,
                        "marksDrawn", marks.Count,
                        "includeCursor", includeCursor,
                        "content", D("x", x, "y", y, "w", srcW, "h", srcH),
                        "contentScale", contentInfo["contentScale"],
                        "targetDpi", contentInfo["targetDpi"],
                        "frameFilled", contentInfo["frameFilled"],
                        "mismatch", contentInfo["mismatch"]);
                    return data;
                }
                finally
                {
                    raw.Dispose();
                }
            }
            finally
            {
                if (suppressed != null) RestoreOverlaysAfterCapture(suppressed);
            }
        }

        // ------------------------------------------------------------------
        // Zoom
        // ------------------------------------------------------------------

        private static Dictionary<string, object> DoZoom(Dictionary<string, object> req)
        {
            int cx = IntArgRequired(req, "cx");
            int cy = IntArgRequired(req, "cy");
            int size = IntArg(req, "size", 270);
            if (size < 16) size = 16;
            if (size > 2000) size = 2000;
            int scale = IntArg(req, "scale", 3);
            if (scale < 1) scale = 1;
            if (scale > 8) scale = 8;
            int subCols = IntArg(req, "subCols", 6);
            if (subCols < 1) subCols = 1;
            if (subCols > 40) subCols = 40;
            int subRows = IntArg(req, "subRows", 6);
            if (subRows < 1) subRows = 1;
            if (subRows > 40) subRows = 40;
            string path = StrArg(req, "path", "");
            if (path.Length == 0) throw new InvalidOperationException("zoom requires path");
            if (!Path.IsPathRooted(path)) throw new InvalidOperationException("zoom path must be absolute");

            Rectangle vs = VirtualScreenRect();
            int srcW = Math.Min(size, vs.Width);
            int srcH = Math.Min(size, vs.Height);
            int srcX = cx - srcW / 2;
            int srcY = cy - srcH / 2;
            if (srcX < vs.X) srcX = vs.X;
            if (srcY < vs.Y) srcY = vs.Y;
            if (srcX + srcW > vs.Right) srcX = vs.Right - srcW;
            if (srcY + srcH > vs.Bottom) srcY = vs.Bottom - srcH;
            Rectangle region = new Rectangle(srcX, srcY, srcW, srcH);
            RequireRegionInVirtual(region);

            int outW = srcW * scale;
            int outH = srcH * scale;
            if (outW > 8192) outW = 8192;
            if (outH > 8192) outH = 8192;

            double markX = double.NaN;
            double markY = double.NaN;
            object markRaw;
            if (req.TryGetValue("mark", out markRaw) && markRaw != null)
            {
                Dictionary<string, object> md = markRaw as Dictionary<string, object>;
                if (md != null)
                {
                    markX = DoubleArg(md, "x", cx);
                    markY = DoubleArg(md, "y", cy);
                }
                else if (markRaw is bool && (bool)markRaw)
                {
                    markX = cx;
                    markY = cy;
                }
            }

            using (Bitmap raw = CopyScreenRegion(srcX, srcY, srcW, srcH))
            {
                bool black;
                string captureHash = HashAndBlackCheck(raw, out black);
                using (Bitmap output = new Bitmap(outW, outH, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(output))
                    {
                        g.InterpolationMode = InterpolationMode.NearestNeighbor;
                        g.PixelOffsetMode = PixelOffsetMode.Half;
                        g.CompositingMode = CompositingMode.SourceCopy;
                        g.DrawImage(raw, new Rectangle(0, 0, outW, outH), 0, 0, srcW, srcH, GraphicsUnit.Pixel);
                        g.CompositingMode = CompositingMode.SourceOver;
                        g.SmoothingMode = SmoothingMode.None;
                        double cellW = (double)outW / subCols;
                        double cellH = (double)outH / subRows;
                        int arm = (int)Math.Round(Math.Min(cellW, cellH) / 5.0);
                        if (arm < 3) arm = 3;
                        if (arm > 18) arm = 18;
                        Color crossColor = Color.FromArgb(255, 0, 230, 255);
                        for (int r = 0; r < subRows; r++)
                        {
                            for (int c = 0; c < subCols; c++)
                            {
                                int px = (int)Math.Round((c + 0.5) * cellW);
                                int py = (int)Math.Round((r + 0.5) * cellH);
                                DrawCross(g, px, py, arm, crossColor, 1.0f);
                            }
                        }
                        if (!double.IsNaN(markX) && !double.IsNaN(markY))
                        {
                            double sx = (double)outW / Math.Max(1, srcW);
                            double sy = (double)outH / Math.Max(1, srcH);
                            int imgX = (int)Math.Round((markX - srcX) * sx);
                            int imgY = (int)Math.Round((markY - srcY) * sy);
                            if (imgX >= 0 && imgX < outW && imgY >= 0 && imgY < outH)
                                DrawMark(g, imgX, imgY, "target", Math.Min(sx, sy));
                        }
                    }
                    SavePng(output, path);
                }
                Dictionary<string, object> data = D(
                    "path", path,
                    "width", outW,
                    "height", outH,
                    "source", D("x", srcX, "y", srcY, "w", srcW, "h", srcH),
                    "scale", scale,
                    "subCols", subCols,
                    "subRows", subRows,
                    "subSpacingScreen", Math.Round((double)srcW / subCols, 4),
                    "subSpacingScreenY", Math.Round((double)srcH / subRows, 4),
                    "subSpacingImage", Math.Round((double)outW / subCols, 4),
                    "subSpacingImageY", Math.Round((double)outH / subRows, 4),
                    "captureHash", captureHash,
                    "blackFrame", black,
                    "center", D("x", cx, "y", cy));
                return data;
            }
        }

        // ------------------------------------------------------------------
        // v2: Esc watchdog / keyboard injection / clipboard
        // ------------------------------------------------------------------

        private static Dictionary<string, object> DoSetEscWatch(Dictionary<string, object> req)
        {
            bool enabled = BoolArg(req, "enabled", false);
            if (enabled)
            {
                LastEscapeEventTick = 0;
                LastHumanInputEventTick = 0;
                LastHumanMouseEventTick = 0;
                WatchEnabledAt = Environment.TickCount;
                POINT watchStart;
                if (GetCursorPos(out watchStart))
                {
                    WatchLastX = watchStart.X;
                    WatchLastY = watchStart.Y;
                }
                else
                {
                    WatchLastX = int.MinValue;
                    WatchLastY = int.MinValue;
                }
                // Snapshot already-held keys BEFORE enabling the watchdog thread,
                // so the arm chord itself (Ctrl+Alt+F12) never counts as typing.
                for (int vk = 0x08; vk <= 0xFE; vk++)
                {
                    if (vk == 0x01 || vk == 0x02 || vk == 0x04 || vk == 0x05 || vk == 0x06) continue;
                    WatchDownBase[vk] = KeyDown(vk);
                }
                StartEscWatchThread();
                EscWatchEnabled = true;
            }
            else
            {
                EscWatchEnabled = false;
            }
            return D("enabled", EscWatchEnabled,
                     "intervalMs", ESC_WATCH_INTERVAL_MS,
                     "buttonsDown", CurrentButtonsDown(),
                     "abortPending", AbortRequested);
        }

        private static void StartEscWatchThread()
        {
            lock (EscWatchLock)
            {
                if (EscWatchThread != null) return;
                EscWatchStop = false;
                EscWatchThread = new Thread(EscWatchLoop);
                EscWatchThread.IsBackground = true;
                EscWatchThread.Name = "esc-watch";
                EscWatchThread.Start();
            }
        }

        internal static void StopEscWatch()
        {
            EscWatchEnabled = false;
            EscWatchStop = true;
        }

        private static bool KeyDown(int vk)
        {
            try { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
            catch { return false; }
        }

        // First non-mouse, non-modifier key that transitioned from up to down since
        // the previous poll (0 when none). Modifier-only presses (Ctrl/Alt/Shift/Win)
        // are ignored: the arm chord itself uses them and holding a modifier is not
        // "typing". The helper never records key content.
        private static int ScanHumanKey()
        {
            int found = 0;
            for (int vk = 0x08; vk <= 0xFE; vk++)
            {
                if (vk == (int)VK_ESCAPE) continue;
                if (vk == 0x01 || vk == 0x02 || vk == 0x04 || vk == 0x05 || vk == 0x06) continue;
                bool down = KeyDown(vk);
                if (down && !WatchDownBase[vk] && found == 0 && !IsModifierVk(vk)) found = vk;
                WatchDownBase[vk] = down;
            }
            return found;
        }

        private static bool IsModifierVk(int vk)
        {
            return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C
                || vk == 0xA0 || vk == 0xA1 || vk == 0xA2 || vk == 0xA3 || vk == 0xA4 || vk == 0xA5;
        }

        private static void EscWatchLoop()
        {
            bool escapeLatched = false;
            int humanLatched = 0;
            while (!EscWatchStop && !QuitRequested)
            {
                try
                {
                    if (!EscWatchEnabled)
                    {
                        escapeLatched = false;
                        humanLatched = 0;
                        Thread.Sleep(ESC_WATCH_INTERVAL_MS);
                        continue;
                    }
                    int now = Environment.TickCount;
                    if (unchecked(now - WatchEnabledAt) < WATCH_ARM_GRACE_MS)
                    {
                        // Ignore the arm chord's own keys and any leftover release.
                        Thread.Sleep(ESC_WATCH_INTERVAL_MS);
                        continue;
                    }
                    if (unchecked(now - LastKeyboardInjectTick) < KEYBOARD_INJECT_GRACE_MS)
                    {
                        // Our own type_text/press_keys output must never look like
                        // physical human input.
                        escapeLatched = false;
                        humanLatched = 0;
                        Thread.Sleep(ESC_WATCH_INTERVAL_MS);
                        continue;
                    }
                    if (KeyDown((int)VK_ESCAPE))
                    {
                        if (!escapeLatched && unchecked(now - LastEscapeEventTick) >= EVENT_DEBOUNCE_MS)
                        {
                            LastEscapeEventTick = now;
                            TriggerAbortFromWatch("escape", null);
                        }
                        escapeLatched = true;
                        humanLatched = 0;
                    }
                    else
                    {
                        escapeLatched = false;
                        int vk = ScanHumanKey();
                        if (vk != 0)
                        {
                            if (humanLatched == 0 && unchecked(now - LastHumanInputEventTick) >= EVENT_DEBOUNCE_MS)
                            {
                                LastHumanInputEventTick = now;
                                TriggerAbortFromWatch("human-input", D("vk", vk));
                            }
                            humanLatched = vk;
                        }
                        else
                        {
                            humanLatched = 0;
                        }
                    }
                    // Physical-cursor watchdog: outside our own injection grace, any
                    // cursor movement is the human. Emit one event per movement bout
                    // (throttled); the host owns the suspend/resume policy.
                    POINT mouseNow;
                    if (GetCursorPos(out mouseNow))
                    {
                        bool moved = WatchLastX != int.MinValue &&
                            (Math.Abs(mouseNow.X - WatchLastX) + Math.Abs(mouseNow.Y - WatchLastY) >= 3);
                        if (moved &&
                            unchecked(now - LastMouseInjectTick) >= MOUSE_INJECT_GRACE_MS &&
                            unchecked(now - LastHumanMouseEventTick) >= HUMAN_MOUSE_EVENT_INTERVAL_MS)
                        {
                            LastHumanMouseEventTick = now;
                            SendEvent("human-mouse", D(
                                "x", mouseNow.X,
                                "y", mouseNow.Y,
                                "dx", mouseNow.X - WatchLastX,
                                "dy", mouseNow.Y - WatchLastY));
                        }
                        WatchLastX = mouseNow.X;
                        WatchLastY = mouseNow.Y;
                    }
                }
                catch (Exception ex)
                {
                    LogErr("esc watch: " + Describe(ex));
                }
                Thread.Sleep(ESC_WATCH_INTERVAL_MS);
            }
        }

        private static void TriggerAbortFromWatch(string eventName, Dictionary<string, object> data)
        {
            AbortRequested = true;
            // D-13b: for plain human input (any key press) release only what we
            // injected. Esc / the F11 abort hotkey are explicit human STOP
            // requests and keep the full (union) release.
            if (eventName == "human-input") { try { ReleaseTrackedButtons(); } catch { } }
            else { try { ReleaseAllButtons(); } catch { } }
            try { SendEvent(eventName, data); } catch { }
        }

        private static void MarkKeyboardInjection()
        {
            LastKeyboardInjectTick = Environment.TickCount;
        }

        private static void MarkMouseInjection()
        {
            LastMouseInjectTick = Environment.TickCount;
        }

        private static void SleepAbortable(int ms)
        {
            int remaining = ms;
            while (remaining > 0)
            {
                if (AbortRequested) return;
                int slice = remaining > 8 ? 8 : remaining;
                Thread.Sleep(slice);
                remaining -= slice;
            }
        }

        private static void SendKeyboard(ushort vk, ushort scan, uint flags)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u = new INPUTUNION();
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            input.u.ki.time = 0;
            input.u.ki.dwExtraInfo = IntPtr.Zero;
            try { SendInput(1, ref input, Marshal.SizeOf(typeof(INPUT))); } catch { }
        }

        private static void SendUnicodeChar(char c)
        {
            SendKeyboard(0, (ushort)c, KEYEVENTF_UNICODE);
            SendKeyboard(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }

        private static void SendKeyTap(ushort vk, bool extended)
        {
            uint flags = extended ? KEYEVENTF_EXTENDEDKEY : 0;
            SendKeyboard(vk, 0, flags);
            SendKeyboard(vk, 0, flags | KEYEVENTF_KEYUP);
        }

        private static Dictionary<string, object> DoTypeText(Dictionary<string, object> req)
        {
            string text = StrArg(req, "text", "");
            if (text == null) text = "";
            if (text.Length > TYPE_TEXT_MAX_CHARS)
                throw new InvalidOperationException("type_text text too long: " + text.Length +
                    " code units (max " + TYPE_TEXT_MAX_CHARS + ")");
            int interval = IntArg(req, "intervalMs", 10);
            if (interval < 8) interval = 8;
            if (interval > 15) interval = 15;
            ResetAbort();
            MarkKeyboardInjection();
            int sent = 0;
            bool aborted = false;
            for (int i = 0; i < text.Length; i++)
            {
                if (AbortRequested)
                {
                    aborted = true;
                    break;
                }
                char c = text[i];
                if (c == '\r')
                {
                    // CRLF is a single Enter; a lone CR is Enter as well.
                    if (i + 1 < text.Length && text[i + 1] == '\n')
                    {
                        MarkKeyboardInjection();
                        SleepAbortable(interval);
                        continue;
                    }
                    SendKeyTap((ushort)VK_RETURN, false);
                }
                else if (c == '\n')
                {
                    SendKeyTap((ushort)VK_RETURN, false);
                }
                else if (c == '\t')
                {
                    SendKeyTap((ushort)VK_TAB, false);
                }
                else
                {
                    // One KEYEVENTF_UNICODE pair per UTF-16 code unit: surrogate
                    // pairs are sent as two events and composed by the target.
                    SendUnicodeChar(c);
                }
                sent++;
                MarkKeyboardInjection();
                SleepAbortable(interval);
            }
            if (AbortRequested) aborted = true;
            return D("chars", sent, "aborted", aborted, "textLength", text.Length,
                     "intervalMs", interval);
        }

        private const int KEY_EXTENDED_BIT = 0x100;
        private const int KEY_CTRL_BIT = 0x200;

        private static readonly Dictionary<string, int> KeyMap = BuildKeyMap();

        private static Dictionary<string, int> BuildKeyMap()
        {
            Dictionary<string, int> map = new Dictionary<string, int>();
            map["enter"] = 0x0D;
            map["tab"] = 0x09;
            map["esc"] = 0x1B;
            map["backspace"] = 0x08;
            map["delete"] = 0x2E | KEY_EXTENDED_BIT;
            map["left"] = 0x25 | KEY_EXTENDED_BIT;
            map["right"] = 0x27 | KEY_EXTENDED_BIT;
            map["up"] = 0x26 | KEY_EXTENDED_BIT;
            map["down"] = 0x28 | KEY_EXTENDED_BIT;
            map["home"] = 0x24 | KEY_EXTENDED_BIT;
            map["end"] = 0x23 | KEY_EXTENDED_BIT;
            map["f5"] = 0x74;
            map["ctrl+a"] = 0x41 | KEY_CTRL_BIT;
            map["ctrl+c"] = 0x43 | KEY_CTRL_BIT;
            map["ctrl+v"] = 0x56 | KEY_CTRL_BIT;
            map["ctrl+x"] = 0x58 | KEY_CTRL_BIT;
            map["ctrl+z"] = 0x5A | KEY_CTRL_BIT;
            map["ctrl+s"] = 0x53 | KEY_CTRL_BIT;
            map["ctrl+f"] = 0x46 | KEY_CTRL_BIT;
            map["ctrl+n"] = 0x4E | KEY_CTRL_BIT;
            map["ctrl+w"] = 0x57 | KEY_CTRL_BIT;
            map["ctrl+tab"] = 0x09 | KEY_CTRL_BIT;
            return map;
        }

        private static Dictionary<string, object> DoPressKeys(Dictionary<string, object> req)
        {
            object raw;
            if (!req.TryGetValue("keys", out raw) || raw == null)
                throw new InvalidOperationException("press_keys requires a keys array");
            List<string> names = new List<string>();
            List<ushort> vks = new List<ushort>();
            List<bool> extendedFlags = new List<bool>();
            List<bool> ctrlFlags = new List<bool>();
            ForEachItem(raw, delegate(object item)
            {
                if (item == null) return;
                string converted = Convert.ToString(item, CultureInfo.InvariantCulture);
                if (converted == null || converted.Trim().Length == 0) return;
                string key = converted.Trim().ToLowerInvariant();
                int mapped;
                if (!KeyMap.TryGetValue(key, out mapped))
                    throw new InvalidOperationException("unsupported key: " + converted.Trim());
                names.Add(key);
                vks.Add((ushort)(mapped & 0xFF));
                extendedFlags.Add((mapped & KEY_EXTENDED_BIT) != 0);
                ctrlFlags.Add((mapped & KEY_CTRL_BIT) != 0);
            });
            if (names.Count == 0) throw new InvalidOperationException("press_keys requires at least one key");
            if (names.Count > 32) throw new InvalidOperationException("press_keys supports at most 32 keys per call");
            ResetAbort();
            MarkKeyboardInjection();
            bool aborted = false;
            List<object> sent = new List<object>();
            for (int i = 0; i < names.Count; i++)
            {
                if (AbortRequested)
                {
                    aborted = true;
                    break;
                }
                bool ctrl = ctrlFlags[i];
                if (ctrl) SendKeyboard(0x11, 0, 0); // VK_CONTROL down first
                SendKeyTap(vks[i], extendedFlags[i]);
                if (ctrl) SendKeyboard(0x11, 0, KEYEVENTF_KEYUP); // control released last
                sent.Add(names[i]);
                MarkKeyboardInjection();
                if (i + 1 < names.Count) SleepAbortable(12);
            }
            return D("sent", sent, "count", sent.Count, "aborted", aborted);
        }

        private sealed class ClipboardOp
        {
            public bool Set;
            public string Text;
            public string Result;
            public bool HasText;
            public Exception Error;
            public bool Done;

            public void Run()
            {
                try
                {
                    if (Set)
                    {
                        string text = Text == null ? "" : Text;
                        if (text.Length == 0) Clipboard.Clear();
                        else Clipboard.SetText(text);
                        Result = text;
                        HasText = text.Length > 0;
                    }
                    else
                    {
                        HasText = Clipboard.ContainsText();
                        Result = HasText ? (Clipboard.GetText() ?? "") : "";
                    }
                    Done = true;
                }
                catch (Exception ex)
                {
                    Error = ex;
                }
            }
        }

        // Runs one clipboard op on the STA UI thread, bounded by a 2 s wait.
        private static bool WaitClipboardOp(ClipboardOp op)
        {
            try
            {
                IAsyncResult ar = Pump.BeginInvoke(new Action(delegate { op.Run(); }));
                if (ar == null) return false;
                if (!ar.AsyncWaitHandle.WaitOne(2000)) return false;
                Pump.EndInvoke(ar);
                return true;
            }
            catch (Exception ex)
            {
                op.Error = ex;
                return true;
            }
        }

        // v7 clipboard_get: optional requireText (default false). A clipboard
        // that holds no text right now is re-checked with a short internal wait
        // (up to 3 x 70ms) because another process may be re-writing it (FB-03).
        // Without requireText an empty read is successful but explicit:
        // hasText=false, reason="no-text". With requireText it is a fail-closed
        // error after the retries, which the host can surface instead of typing
        // into the wrong window.
        private static Dictionary<string, object> DoClipboardGet(Dictionary<string, object> req)
        {
            bool requireText = BoolArg(req, "requireText", false);
            Exception last = null;
            for (int attempt = 0; attempt < CLIPBOARD_ATTEMPTS; attempt++)
            {
                ClipboardOp op = new ClipboardOp();
                op.Set = false;
                bool ran = WaitClipboardOp(op);
                if (ran && op.Done && op.Error == null)
                {
                    if (op.HasText)
                    {
                        string text = op.Result == null ? "" : op.Result;
                        bool truncated = text.Length > CLIPBOARD_MAX_CHARS;
                        if (truncated) text = text.Substring(0, CLIPBOARD_MAX_CHARS);
                        return D("text", text, "chars", text.Length, "truncated", truncated,
                                 "hasText", true, "reason", "text");
                    }
                    // No text this instant: wait and re-check before deciding.
                }
                else
                {
                    last = ran ? op.Error : new InvalidOperationException("clipboard ui thread timeout");
                }
                if (attempt < CLIPBOARD_ATTEMPTS - 1) Thread.Sleep(CLIPBOARD_RETRY_MS);
            }
            if (requireText)
            {
                throw new InvalidOperationException(
                    "clipboard_get: no text on the clipboard after " + CLIPBOARD_ATTEMPTS + " attempts" +
                    (last != null ? " (last error: " + Describe(last) + ")" : ""));
            }
            return D("text", "", "chars", 0, "truncated", false, "hasText", false, "reason", "no-text");
        }

        private static Dictionary<string, object> DoClipboardSet(Dictionary<string, object> req)
        {
            string text = StrArg(req, "text", "");
            if (text == null) text = "";
            if (text.Length > CLIPBOARD_MAX_CHARS)
                throw new InvalidOperationException("clipboard_set text too long: " + text.Length +
                    " chars (max " + CLIPBOARD_MAX_CHARS + ")");
            Exception last = null;
            for (int attempt = 0; attempt < CLIPBOARD_ATTEMPTS; attempt++)
            {
                ClipboardOp op = new ClipboardOp();
                op.Set = true;
                op.Text = text;
                bool ran = WaitClipboardOp(op);
                if (ran && op.Done && op.Error == null)
                {
                    return D("chars", text.Length, "textLength", text.Length);
                }
                last = ran ? op.Error : new InvalidOperationException("clipboard ui thread timeout");
                Thread.Sleep(CLIPBOARD_RETRY_MS);
            }
            throw new InvalidOperationException("clipboard_set failed: " + Describe(last));
        }

        // ------------------------------------------------------------------
        // Mouse: move / click / drag / scroll
        // ------------------------------------------------------------------

        internal static void ResetAbort()
        {
            AbortRequested = false;
        }

        private static void RequireInsideVirtual(int x, int y)
        {
            Rectangle vs = VirtualScreenRect();
            if (x < vs.X || x >= vs.Right || y < vs.Y || y >= vs.Bottom)
                throw new InvalidOperationException("target outside virtual screen: " + x + "," + y);
        }

        private static double EaseInOutCubic(double t)
        {
            if (t < 0.5) return 4.0 * t * t * t;
            double f = -2.0 * t + 2.0;
            return 1.0 - (f * f * f) / 2.0;
        }

        private sealed class MoveResult
        {
            public bool Aborted;
            public bool External;
            public int StartX;
            public int StartY;
            public int CursorX;
            public int CursorY;
            public long ElapsedMs;
        }

        // Ring buffer of the positions we injected most recently. A cursor
        // reading that matches an earlier injected point only means the input
        // queue has not caught up yet ("lag"), which is not interference.
        private sealed class CursorTrace
        {
            private const int LAG_TOLERANCE_PX = 2;
            private readonly int[] _xs = new int[8];
            private readonly int[] _ys = new int[8];
            private int _count;
            private int _head;

            public void Add(int x, int y)
            {
                _xs[_head] = x;
                _ys[_head] = y;
                _head = (_head + 1) % _xs.Length;
                if (_count < _xs.Length) _count++;
            }

            public bool MatchesLag(int x, int y)
            {
                for (int i = 0; i < _count; i++)
                {
                    int index = (_head - 1 - i + _xs.Length * 2) % _xs.Length;
                    if (Math.Abs(_xs[index] - x) <= LAG_TOLERANCE_PX &&
                        Math.Abs(_ys[index] - y) <= LAG_TOLERANCE_PX)
                        return true;
                }
                return false;
            }
        }

        // Final-position check: retries briefly for a lagging input queue and
        // only reports interference when the cursor is stably elsewhere.
        private static bool CursorAt(int x, int y, CursorTrace trace, out bool external)
        {
            external = false;
            POINT p = new POINT();
            for (int attempt = 0; attempt < 5; attempt++)
            {
                if (!GetCursorPos(out p)) return true; // cannot verify: assume our move landed
                if (Math.Abs(p.X - x) <= CURSOR_TOLERANCE_PX &&
                    Math.Abs(p.Y - y) <= CURSOR_TOLERANCE_PX)
                    return true;
                if (attempt >= 2 && !trace.MatchesLag(p.X, p.Y))
                {
                    external = true;
                    return false;
                }
                Thread.Sleep(2);
            }
            external = true;
            return false;
        }

        private static MoveResult AnimateCursor(int targetX, int targetY, int durationMs, string easing)
        {
            MoveResult r = new MoveResult();
            POINT p;
            GetCursorPos(out p);
            r.StartX = p.X;
            r.StartY = p.Y;
            r.CursorX = p.X;
            r.CursorY = p.Y;
            int duration = durationMs;
            if (duration < 0) duration = 0;
            if (duration > 5000) duration = 5000;
            int steps = duration <= 0 ? 1 : Math.Max(1, duration / 10);
            int stepSleep = duration <= 0 ? 0 : Math.Max(1, duration / steps);
            bool linear = easing != null && easing == "linear";
            CursorTrace trace = new CursorTrace();
            trace.Add(r.StartX, r.StartY);
            Stopwatch sw = Stopwatch.StartNew();
            for (int i = 1; i <= steps; i++)
            {
                if (AbortRequested)
                {
                    r.Aborted = true;
                    break;
                }
                double t = (double)i / steps;
                double e = linear ? t : EaseInOutCubic(t);
                int nx = (int)Math.Round(r.StartX + (targetX - r.StartX) * e);
                int ny = (int)Math.Round(r.StartY + (targetY - r.StartY) * e);
                if (i == steps)
                {
                    nx = targetX;
                    ny = targetY;
                }
                SendMouseMove(nx, ny);
                trace.Add(nx, ny);
                POINT cur;
                if (GetCursorPos(out cur) &&
                    (Math.Abs(cur.X - nx) > CURSOR_TOLERANCE_PX ||
                     Math.Abs(cur.Y - ny) > CURSOR_TOLERANCE_PX) &&
                    !trace.MatchesLag(cur.X, cur.Y))
                {
                    // Someone else moved the cursor: abort, release buttons.
                    r.External = true;
                    r.Aborted = true;
                    AbortRequested = true;
                    try { ReleaseTrackedButtons(); } catch { }
                    break;
                }
                if (duration > 0 && i < steps) Thread.Sleep(stepSleep);
            }
            if (!r.Aborted)
            {
                SendMouseMove(targetX, targetY);
                bool external;
                if (!CursorAt(targetX, targetY, trace, out external))
                {
                    r.External = true;
                    r.Aborted = true;
                    AbortRequested = true;
                    try { ReleaseTrackedButtons(); } catch { }
                }
                else
                {
                    POINT cur;
                    if (GetCursorPos(out cur) && (cur.X != targetX || cur.Y != targetY))
                    {
                        SetCursorPos(targetX, targetY);
                    }
                }
            }
            POINT final;
            GetCursorPos(out final);
            r.CursorX = final.X;
            r.CursorY = final.Y;
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private static Dictionary<string, object> DoMove(Dictionary<string, object> req)
        {
            int x = IntArgRequired(req, "x");
            int y = IntArgRequired(req, "y");
            RequireInsideVirtual(x, y);
            int duration = IntArg(req, "durationMs", 260);
            if (duration < 0) duration = 0;
            if (duration > 5000) duration = 5000;
            string easing = StrArg(req, "easing", "easeInOutCubic").Trim().ToLowerInvariant();
            if (easing != "easeinoutcubic" && easing != "linear")
                throw new InvalidOperationException("invalid easing: " + easing);
            ResetAbort();
            MoveResult r = AnimateCursor(x, y, duration, easing == "linear" ? "linear" : "easeInOutCubic");
            return D("x", x, "y", y,
                     "cursorX", r.CursorX, "cursorY", r.CursorY,
                     "aborted", r.Aborted,
                     "externalAborted", r.External,
                     "startX", r.StartX, "startY", r.StartY,
                     "elapsedMs", r.ElapsedMs);
        }

        private static string NormalizeButton(string button)
        {
            string b = (button == null ? "left" : button.Trim().ToLowerInvariant());
            if (b != "left" && b != "right" && b != "middle")
                throw new InvalidOperationException("invalid button: " + button);
            return b;
        }

        private static Dictionary<string, object> DoClick(Dictionary<string, object> req)
        {
            int x = IntArgRequired(req, "x");
            int y = IntArgRequired(req, "y");
            RequireInsideVirtual(x, y);
            string button = NormalizeButton(StrArg(req, "button", "left"));
            int count = IntArg(req, "count", 1);
            if (count < 1 || count > 2) throw new InvalidOperationException("count must be 1 or 2");
            int holdMs = IntArg(req, "holdMs", 35);
            if (holdMs < 0) holdMs = 0;
            if (holdMs > 5000) holdMs = 5000;
            int duration = IntArg(req, "durationMs", 260);
            if (duration < 0) duration = 0;
            if (duration > 5000) duration = 5000;
            bool moveFirst = BoolArg(req, "moveFirst", true);

            ResetAbort();
            IntPtr fgBefore = GetForegroundWindow();
            if (moveFirst)
            {
                MoveResult m = AnimateCursor(x, y, duration, "easeInOutCubic");
                if (m.External)
                {
                    try { ReleaseTrackedButtons(); } catch { }
                    POINT movedCur;
                    GetCursorPos(out movedCur);
                    IntPtr fgAfterExternal = GetForegroundWindow();
                    return D("x", x, "y", y,
                             "cursorX", movedCur.X, "cursorY", movedCur.Y,
                             "button", button,
                             "count", count,
                             "aborted", true,
                             "externalAborted", true,
                             "foregroundBefore", WindowInfo(fgBefore),
                             "foregroundAfter", WindowInfo(fgAfterExternal),
                             "foregroundChanged", fgAfterExternal != fgBefore,
                             "physicalButtonsAfter", PhysicalButtonsDown());
                }
                if (m.Aborted) throw new InvalidOperationException("aborted before click");
            }
            if (AbortRequested) throw new InvalidOperationException("aborted before click");

            bool down = false;
            bool abortedMid = false;
            try
            {
                for (int c = 0; c < count; c++)
                {
                    if (AbortRequested)
                    {
                        abortedMid = true;
                        break;
                    }
                    SendButton(button, true);
                    down = true;
                    SetTrackedButton(button, true);
                    int waited = 0;
                    while (waited < holdMs)
                    {
                        if (AbortRequested)
                        {
                            abortedMid = true;
                            break;
                        }
                        int slice = Math.Min(10, holdMs - waited);
                        if (slice > 0) Thread.Sleep(slice);
                        waited += slice;
                    }
                    SendButton(button, false);
                    down = false;
                    SetTrackedButton(button, false);
                    if (abortedMid) break;
                    if (c + 1 < count) Thread.Sleep(70);
                }
            }
            finally
            {
                if (down)
                {
                    try { SendButton(button, false); } catch { }
                    SetTrackedButton(button, false);
                }
            }
            POINT after;
            GetCursorPos(out after);
            IntPtr fgAfter = GetForegroundWindow();
            return D("x", x, "y", y,
                     "cursorX", after.X, "cursorY", after.Y,
                     "button", button,
                     "count", count,
                     "aborted", abortedMid,
                     "externalAborted", false,
                     "foregroundBefore", WindowInfo(fgBefore),
                     "foregroundAfter", WindowInfo(fgAfter),
                     "foregroundChanged", fgAfter != fgBefore,
                     "physicalButtonsAfter", PhysicalButtonsDown());
        }

        private static Dictionary<string, object> DoDrag(Dictionary<string, object> req)
        {
            int fromX = IntArgRequired(req, "fromX");
            int fromY = IntArgRequired(req, "fromY");
            int toX = IntArgRequired(req, "toX");
            int toY = IntArgRequired(req, "toY");
            RequireInsideVirtual(fromX, fromY);
            RequireInsideVirtual(toX, toY);
            string button = NormalizeButton(StrArg(req, "button", "left"));
            int duration = IntArg(req, "durationMs", 260);
            if (duration < 0) duration = 0;
            if (duration > 5000) duration = 5000;
            bool moveFirst = BoolArg(req, "moveFirst", true);

            ResetAbort();
            if (moveFirst)
            {
                int approach = Math.Min(duration, 200);
                MoveResult m = AnimateCursor(fromX, fromY, approach, "easeInOutCubic");
                if (m.External)
                {
                    try { ReleaseTrackedButtons(); } catch { }
                    POINT movedCur;
                    GetCursorPos(out movedCur);
                    return D("fromX", fromX, "fromY", fromY, "toX", toX, "toY", toY,
                             "cursorX", movedCur.X, "cursorY", movedCur.Y,
                             "aborted", true,
                             "externalAborted", true);
                }
                if (m.Aborted) throw new InvalidOperationException("aborted before drag");
            }
            if (AbortRequested) throw new InvalidOperationException("aborted before drag");

            bool down = false;
            bool aborted = false;
            bool external = false;
            try
            {
                SendButton(button, true);
                down = true;
                SetTrackedButton(button, true);
                MoveResult dragMove = AnimateCursor(toX, toY, duration, "easeInOutCubic");
                aborted = dragMove.Aborted;
                external = dragMove.External;
            }
            finally
            {
                if (down)
                {
                    try { SendButton(button, false); } catch { }
                    SetTrackedButton(button, false);
                }
            }
            POINT after;
            GetCursorPos(out after);
            return D("fromX", fromX, "fromY", fromY, "toX", toX, "toY", toY,
                     "cursorX", after.X, "cursorY", after.Y,
                     "aborted", aborted,
                     "externalAborted", external);
        }

        private static Dictionary<string, object> DoScroll(Dictionary<string, object> req)
        {
            int delta = IntArgRequired(req, "delta");
            if (delta < -50) delta = -50;
            if (delta > 50) delta = 50;
            ResetAbort();
            bool hasPoint = HasArg(req, "x") && HasArg(req, "y");
            if (hasPoint)
            {
                int x = IntArg(req, "x", 0);
                int y = IntArg(req, "y", 0);
                RequireInsideVirtual(x, y);
                SendMouseMove(x, y);
                POINT now;
                GetCursorPos(out now);
                if (now.X != x || now.Y != y) SetCursorPos(x, y);
                Thread.Sleep(40);
            }
            // Protocol: delta is in wheel notches with negative = up. Windows
            // WHEEL positive data means "rotate forward" (scroll up), so invert
            // the sign here so the host-facing semantic matches PROTOCOL.md.
            if (delta != 0) SendWheel(-delta * 120);
            Thread.Sleep(20);
            POINT p;
            GetCursorPos(out p);
            return D("delta", delta, "cursorX", p.X, "cursorY", p.Y, "moved", hasPoint);
        }

        internal static void SetTrackedButton(string button, bool down)
        {
            lock (ButtonLock)
            {
                if (button == "right") ButtonRightDown = down;
                else if (button == "middle") ButtonMiddleDown = down;
                else ButtonLeftDown = down;
            }
        }

        internal static bool ReleaseAllButtons()
        {
            bool left;
            bool right;
            bool middle;
            lock (ButtonLock)
            {
                left = ButtonLeftDown;
                right = ButtonRightDown;
                middle = ButtonMiddleDown;
                ButtonLeftDown = false;
                ButtonRightDown = false;
                ButtonMiddleDown = false;
            }
            // v9: release the union of tracked and real OS state. Tracking can
            // be false while the button is physically down when the process is
            // killed between SendButton(down) and SetTrackedButton(true), or
            // when another process left a button down. A synthetic UP is
            // harmless if the button is already up; a missing UP can leave the
            // Windows/touchpad click state stuck until a real mouse click.
            if (left || KeyDown(0x01)) { try { SendButton("left", false); left = true; } catch { } }
            if (right || KeyDown(0x02)) { try { SendButton("right", false); right = true; } catch { } }
            if (middle || KeyDown(0x04)) { try { SendButton("middle", false); middle = true; } catch { } }
            return left || right || middle;
        }

        // D-13b: release ONLY the buttons this helper injected. The union
        // release in ReleaseAllButtons is right for explicit STOP/kill paths
        // but wrong for HUMAN activity: a synthetic UP for a physically held
        // button breaks the human's drag (the original D-13 symptom came
        // back through human-input / external-cursor aborts).
        internal static bool ReleaseTrackedButtons()
        {
            bool left;
            bool right;
            bool middle;
            lock (ButtonLock)
            {
                left = ButtonLeftDown;
                right = ButtonRightDown;
                middle = ButtonMiddleDown;
                ButtonLeftDown = false;
                ButtonRightDown = false;
                ButtonMiddleDown = false;
            }
            if (left) { try { SendButton("left", false); } catch { } }
            if (right) { try { SendButton("right", false); } catch { } }
            if (middle) { try { SendButton("middle", false); } catch { } }
            return left || right || middle;
        }

        // v1.3 (self-window deny): the pid + ancestor/descendant tree of a
        // process, so the host can refuse input aimed at its own UI even when
        // the UI lives in a different process/image (browser tab, renamed host).
        private static Dictionary<string, object> DoProcessTree(Dictionary<string, object> req)
        {
            int pid = IntArgRequired(req, "pid");
            if (pid <= 0) throw new InvalidOperationException("invalid pid");
            List<object> ancestors = new List<object>();
            List<object> descendants = new List<object>();
            try
            {
                Dictionary<int, int> parents = SnapshotParents();
                int current = pid;
                int guard = 0;
                while (current > 0 && guard++ < 64)
                {
                    int parent;
                    if (!parents.TryGetValue(current, out parent)) break;
                    if (parent <= 0 || parent == current) break;
                    ancestors.Add(parent);
                    current = parent;
                }
                Dictionary<int, List<int>> children = new Dictionary<int, List<int>>();
                foreach (KeyValuePair<int, int> pair in parents)
                {
                    List<int> list;
                    if (!children.TryGetValue(pair.Value, out list))
                    {
                        list = new List<int>();
                        children[pair.Value] = list;
                    }
                    list.Add(pair.Key);
                }
                Queue<int> queue = new Queue<int>();
                HashSet<int> seen = new HashSet<int>();
                queue.Enqueue(pid);
                seen.Add(pid);
                while (queue.Count > 0)
                {
                    int node = queue.Dequeue();
                    List<int> kids;
                    if (!children.TryGetValue(node, out kids)) continue;
                    foreach (int kid in kids)
                    {
                        if (!seen.Add(kid)) continue;
                        descendants.Add(kid);
                        queue.Enqueue(kid);
                    }
                }
            }
            catch (Exception ex)
            {
                return D("pid", pid, "error", Describe(ex), "ancestors", ancestors, "descendants", descendants, "pids", ancestors);
            }
            List<object> all = new List<object>();
            all.Add(pid);
            foreach (object item in ancestors) all.Add(item);
            foreach (object item in descendants) all.Add(item);
            return D("pid", pid, "ancestors", ancestors, "descendants", descendants, "pids", all);
        }

        private static Dictionary<int, int> SnapshotParents()
        {
            Dictionary<int, int> map = new Dictionary<int, int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002u, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
                throw new InvalidOperationException("CreateToolhelp32Snapshot failed");
            try
            {
                PROCESSENTRY32 entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry))
                    throw new InvalidOperationException("Process32First failed");
                do
                {
                    map[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                }
                while (Process32Next(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }
            return map;
        }

        // ------------------------------------------------------------------
        // Overlay
        // ------------------------------------------------------------------

        private static Dictionary<string, object> DoOverlay(Dictionary<string, object> req)
        {
            bool show = BoolArg(req, "show", true);
            string mode = StrArg(req, "mode", "both").Trim().ToLowerInvariant();
            if (mode != "lattice" && mode != "pill" && mode != "both")
                throw new InvalidOperationException("invalid overlay mode: " + mode);
            int spacing = IntArg(req, "spacing", 640);
            if (spacing < 20) spacing = 20;
            if (spacing > 4000) spacing = 4000;
            double opacity = DoubleArg(req, "opacity", 0.55);
            if (opacity < 0.05) opacity = 0.05;
            if (opacity > 1.0) opacity = 1.0;
            string label = StrArg(req, "label", "Click Matrix");
            if (label.Length > 200) label = label.Substring(0, 200);

            bool showLattice = show && (mode == "lattice" || mode == "both");
            bool showPill = show && (mode == "pill" || mode == "both");

            int latticeX = 0;
            int latticeY = 0;
            int latticeW = 0;
            int latticeH = 0;
            int pillX = 0;
            int pillY = 0;
            int pillW = 0;
            int pillH = 0;
            int stopX = 0;
            int stopY = 0;
            int stopRectX = 0;
            int stopRectY = 0;
            int stopW = 0;
            int stopH = 0;

            Exception uiError = null;
            try
            {
                Pump.Invoke(new Action(delegate
                {
                    try
                    {
                        if (showLattice)
                        {
                            if (LatticeWin == null || LatticeWin.IsDisposed)
                            {
                                LatticeWin = new LatticeForm();
                                LatticeHandle = LatticeWin.Handle;
                            }
                            LatticeWin.SetSpacing(spacing);
                            LatticeWin.SetOpacityValue(opacity);
                            LatticeWin.ShowNoActivate();
                            LatticeExcluded = TryExcludeWindowFromCapture(LatticeHandle);
                            LatticeVisible = true;
                            LatticeHitTestable = IsHitTestable(LatticeHandle);
                        }
                        else
                        {
                            if (LatticeWin != null) LatticeWin.Hide();
                            LatticeVisible = false;
                            LatticeHitTestable = false;
                        }
                        if (showPill)
                        {
                            if (PillWin == null || PillWin.IsDisposed)
                            {
                                PillWin = new PillForm();
                                PillHandle = PillWin.Handle;
                            }
                            if (StopWin == null || StopWin.IsDisposed)
                            {
                                StopWin = new StopForm();
                                StopHandle = StopWin.Handle;
                            }
                            PillWin.SetLabel(label);
                            PillWin.ShowNoActivate();
                            StopWin.ShowNoActivate();
                            PillExcluded = TryExcludeWindowFromCapture(PillHandle);
                            PillVisible = true;
                            PillHitTestable = IsHitTestable(PillHandle);
                            StopExcluded = TryExcludeWindowFromCapture(StopHandle);
                            StopVisible = true;
                            StopHitTestable = IsHitTestable(StopHandle);
                        }
                        else
                        {
                            if (PillWin != null) PillWin.Hide();
                            PillVisible = false;
                            PillHitTestable = false;
                            if (StopWin != null) StopWin.Hide();
                            StopVisible = false;
                            StopHitTestable = false;
                        }
                        if (LatticeWin != null)
                        {
                            Rectangle lr = LatticeWin.Bounds;
                            latticeX = lr.X;
                            latticeY = lr.Y;
                            latticeW = lr.Width;
                            latticeH = lr.Height;
                        }
                        if (PillWin != null)
                        {
                            Rectangle pr = PillWin.Bounds;
                            pillX = pr.X;
                            pillY = pr.Y;
                            pillW = pr.Width;
                            pillH = pr.Height;
                        }
                        if (StopWin != null && StopWin.Visible)
                        {
                            Rectangle sr = StopWin.Bounds;
                            stopRectX = sr.X;
                            stopRectY = sr.Y;
                            stopW = sr.Width;
                            stopH = sr.Height;
                            stopX = sr.X + sr.Width / 2;
                            stopY = sr.Y + sr.Height / 2;
                        }
                    }
                    catch (Exception ex)
                    {
                        uiError = ex;
                    }
                }));
            }
            catch (Exception ex)
            {
                uiError = ex;
            }
            if (uiError != null) throw new InvalidOperationException("overlay ui failed: " + Describe(uiError));

            bool visible = LatticeVisible || PillVisible;
            return D("visible", visible,
                     "mode", mode,
                     "captureExcluded", CurrentCaptureExcluded(),
                     "lattice", D("visible", LatticeVisible, "spacing", spacing,
                                  "excludedFromCapture", LatticeExcluded,
                                  "rect", D("x", latticeX, "y", latticeY, "w", latticeW, "h", latticeH)),
                     "pill", D("visible", PillVisible, "label", label,
                               "excludedFromCapture", PillExcluded,
                               "rect", D("x", pillX, "y", pillY, "w", pillW, "h", pillH),
                               "clickThrough", PillVisible && !PillHitTestable,
                               "hitTestable", PillVisible && PillHitTestable,
                               "stop", D("x", stopX, "y", stopY,
                                         "visible", StopVisible,
                                         "hitTestable", StopVisible && StopHitTestable,
                                         "excludedFromCapture", StopExcluded,
                                         "rect", D("x", stopRectX, "y", stopRectY, "w", stopW, "h", stopH))));
        }

        private static bool TryExcludeWindowFromCapture(IntPtr hWnd)
        {
            if (hWnd == IntPtr.Zero) return false;
            try
            {
                return SetWindowDisplayAffinity(hWnd, WDA_EXCLUDEFROMCAPTURE);
            }
            catch (Exception ex)
            {
                LogErr("SetWindowDisplayAffinity failed: " + Describe(ex));
                return false;
            }
        }

        internal static void PlacePill(PillForm form)
        {
            try
            {
                Rectangle primary = PrimaryMonitorBounds();
                int x = primary.X + (primary.Width - form.Width) / 2;
                // D-12b: bottom edge. The old top-centre spot sat exactly on the
                // window title-bar drag area; the click-through label fixed most of
                // it but the STOP window itself still swallowed a 96x38 strip there.
                int y = primary.Y + primary.Height - form.Height - 12;
                form.Location = new Point(x, y);
                SetWindowPos(form.Handle, HWND_TOPMOST, x, y, form.Width, form.Height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW);
                if (StopWin != null && !StopWin.IsDisposed)
                {
                    StopWin.PlaceAt(x + PillForm.StopLeft, y + PillForm.StopTop);
                }
            }
            catch (Exception ex)
            {
                LogErr("place pill: " + Describe(ex));
            }
        }

        internal static void ShowLatticeWindow(IntPtr handle)
        {
            try
            {
                SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0,
                    SWP_NOACTIVATE | 0x0001 | 0x0002); // SWP_NOSIZE | SWP_NOMOVE
            }
            catch { }
        }

        internal static void OnHotkey()
        {
            if (!AbortHotkeyRegistered)
            {
                // D-08: never arm without a working emergency stop hotkey.
                SendEvent("hotkey", D("combo", HotkeyCombo, "armed", false, "refused", "abort-hotkey-missing"));
                return;
            }
            Armed = !Armed;
            SendEvent("hotkey", D("combo", HotkeyCombo, "armed", Armed));
        }

        // D-08: retry hotkey registration on demand (a combo may be owned by
        // another process only temporarily). Never exits the helper.
        private static Dictionary<string, object> DoRetryHotkeys()
        {
            if (PumpHandle == IntPtr.Zero) throw new InvalidOperationException("hotkey pump is not ready");
            try
            {
                Pump.Invoke(new Action(delegate
                {
                    if (!HotkeyRegistered)
                        HotkeyRegistered = RegisterHotkeyWithRetry(PumpHandle, HOTKEY_ID, VK_F12, HotkeyCombo);
                    if (!AbortHotkeyRegistered)
                        AbortHotkeyRegistered = RegisterHotkeyWithRetry(PumpHandle, ABORT_HOTKEY_ID, VK_F11, AbortHotkeyCombo);
                    if (!SoftHotkeyRegistered)
                        SoftHotkeyRegistered = RegisterSoftHotkey();
                }));
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException("retry_hotkeys failed: " + Describe(ex));
            }
            return D("armRegistered", HotkeyRegistered,
                     "abortRegistered", AbortHotkeyRegistered,
                     "softRegistered", SoftHotkeyRegistered,
                     "safeToArm", AbortHotkeyRegistered,
                     "lastError", AbortHotkeyRegistered ? "" : HotkeyLastError);
        }

        // Ctrl+Alt+F11: independent global abort. It never injects input; it
        // just sets AbortRequested (so in-flight move/click/drag/type loops stop
        // at their next slice), releases any held button, and emits one "abort"
        // event so the host can surface it. Works whether or not the helper is
        // armed via Ctrl+Alt+F12.
        internal static void OnAbortHotkey()
        {
            TriggerAbortFromWatch("abort", D("source", "hotkey"));
        }

        // ⑥ 软停热键：写共享 stop.signal token（level=soft），交给各引擎的步内检测点
        // 在自己的原子边界停；不在此处直接 abort（那会变成 hard）。fail-soft：写不进去也不崩。
        internal static void OnSoftHotkey()
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                                          ".dsh", "dsh-desktop-hands");
                Directory.CreateDirectory(dir);
                string target = Path.Combine(dir, "stop.signal");
                string tmp = target + ".tmp-" + System.Diagnostics.Process.GetCurrentProcess().Id;
                string json = "{\"level\":\"soft\",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() +
                              ",\"by\":\"hotkey\",\"reason\":\"Ctrl+Shift+F11\"}";
                File.WriteAllText(tmp, json, new UTF8Encoding(false));
                try { File.Delete(target); } catch { }
                File.Move(tmp, target);
                SendEvent("soft-hotkey", D("combo", SoftHotkeyCombo));
            }
            catch
            {
                SendEvent("soft-hotkey", D("combo", SoftHotkeyCombo, "writeError", true));
            }
        }

        internal static void OnPillClick()
        {
            SendEvent("pill-click", null);
        }

        internal static void OnPillStop()
        {
            AbortRequested = true;
            try { ReleaseAllButtons(); } catch { }
            SendEvent("pill-click", null);
            SendEvent("stop", null);
        }

        // ------------------------------------------------------------------
        // Doctor
        // ------------------------------------------------------------------

        private static Dictionary<string, object> DoDoctor()
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["osVersion"] = OsVersionString();
            d["build"] = OsBuildNumber();
            d["processElevated"] = IsProcessElevated();
            d["dpiAware"] = DpiAware;
            d["monitors"] = MonitorsData();

            Dictionary<string, object> capture = new Dictionary<string, object>();
            bool captureOk = false;
            bool captureBlack = true;
            int probeSize = 0;
            string captureError = null;
            try
            {
                Rectangle vs = VirtualScreenRect();
                probeSize = Math.Min(64, Math.Min(vs.Width, vs.Height));
                int px = vs.X + 8;
                int py = vs.Y + 8;
                using (Bitmap bmp = CopyScreenRegion(px, py, probeSize, probeSize))
                {
                    bool black;
                    HashAndBlackCheck(bmp, out black);
                    captureOk = true;
                    captureBlack = black;
                }
            }
            catch (Exception ex)
            {
                captureError = Describe(ex);
            }
            capture["ok"] = captureOk;
            capture["black"] = captureBlack;
            capture["size"] = probeSize;
            if (captureError != null) capture["error"] = captureError;
            d["capture"] = capture;

            d["hotkeyRegistered"] = HotkeyRegistered;
            d["abortHotkeyRegistered"] = AbortHotkeyRegistered;
            d["abortHotkey"] = D("registered", AbortHotkeyRegistered, "combo", AbortHotkeyCombo);
            d["overlayAvailable"] = OverlayAvailable();
            d["captureExcluded"] = CurrentCaptureExcluded();
            d["uipiProbe"] = UipiProbe();
            d["capabilities"] = Capabilities();
            d["helperVersion"] = HelperVersion;
            d["protocol"] = ProtocolVersion;
            return d;
        }

        private static Dictionary<string, object> UipiProbe()
        {
            bool ok = false;
            string note = "";
            try
            {
                IntPtr fg = GetForegroundWindow();
                uint pid = 0;
                if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out pid);
                if (pid == 0)
                {
                    note = "no foreground window";
                }
                else
                {
                    IntPtr h = OpenProcess(0x1000, false, pid);
                    if (h != IntPtr.Zero)
                    {
                        CloseHandle(h);
                        ok = true;
                        note = "can query foreground process pid " + pid;
                    }
                    else
                    {
                        note = "cannot query foreground process pid " + pid + " (elevated or protected)";
                    }
                }
            }
            catch (Exception ex)
            {
                note = Describe(ex);
            }
            return D("ok", ok, "note", note);
        }

        // ------------------------------------------------------------------
        // Win32: structs / delegates / imports
        // ------------------------------------------------------------------

        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT
        {
            public uint type;
            public INPUTUNION u;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct RTL_OSVERSIONINFOW
        {
            public uint dwOSVersionInfoSize;
            public uint dwMajorVersion;
            public uint dwMinorVersion;
            public uint dwBuildNumber;
            public uint dwPlatformId;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szCSDVersion;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CURSORINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hCursor;
            public POINT ptScreenPos;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct USEROBJECTFLAGS
        {
            public int fInherit;
            public int fReserved;
            public int dwFlags;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")]
        private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int cmdShow);
        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint attach, uint attachTo, bool combine);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool PeekMessageW(out MSG msg, IntPtr hWnd, uint filterMin, uint filterMax, uint removeMsg);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        private static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hWnd, int flags);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
        [DllImport("user32.dll")]
        private static extern uint SendInput(uint count, ref INPUT input, int size);
        [DllImport("user32.dll")]
        private static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")]
        private static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon,
            int cx, int cy, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, int diFlags);
        [DllImport("user32.dll")]
        private static extern int GetWindowLongW(IntPtr hWnd, int index);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int index);
        [DllImport("user32.dll")]
        private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("user32.dll")]
        private static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformationW(IntPtr hObj, int index, ref USEROBJECTFLAGS info,
            int length, out int needed);

        [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
        private static extern int RtlGetVersion(ref RTL_OSVERSIONINFOW info);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);

        [DllImport("kernel32.dll")]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("advapi32.dll")]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int size, out int returned);

        private static long GetExStyle(IntPtr hWnd)
        {
            try
            {
                if (IntPtr.Size == 8) return GetWindowLongPtrW(hWnd, GWL_EXSTYLE).ToInt64();
                return GetWindowLongW(hWnd, GWL_EXSTYLE);
            }
            catch { return 0; }
        }

        private static void SendMouseMove(int x, int y)
        {
            MarkMouseInjection();
            Rectangle vs = VirtualScreenRect();
            long nx = (long)Math.Round((x - (double)vs.X) * 65535.0 / Math.Max(1, vs.Width - 1));
            long ny = (long)Math.Round((y - (double)vs.Y) * 65535.0 / Math.Max(1, vs.Height - 1));
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u = new INPUTUNION();
            input.u.mi.dx = (int)nx;
            input.u.mi.dy = (int)ny;
            input.u.mi.mouseData = 0;
            input.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
            try { SendInput(1, ref input, Marshal.SizeOf(typeof(INPUT))); } catch { }
        }

        private static void SendButton(string button, bool down)
        {
            MarkMouseInjection();
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u = new INPUTUNION();
            input.u.mi.dx = 0;
            input.u.mi.dy = 0;
            input.u.mi.mouseData = 0;
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
            uint flag;
            switch (button)
            {
                case "right": flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
                case "middle": flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
                default: flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
            }
            input.u.mi.dwFlags = flag;
            try { SendInput(1, ref input, Marshal.SizeOf(typeof(INPUT))); } catch { }
        }

        private static void SendWheel(int delta)
        {
            MarkMouseInjection();
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u = new INPUTUNION();
            input.u.mi.dx = 0;
            input.u.mi.dy = 0;
            input.u.mi.mouseData = (uint)delta;
            input.u.mi.time = 0;
            input.u.mi.dwExtraInfo = IntPtr.Zero;
            input.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
            try { SendInput(1, ref input, Marshal.SizeOf(typeof(INPUT))); } catch { }
        }

        // ------------------------------------------------------------------
        // Forms
        // ------------------------------------------------------------------

        internal sealed class PumpForm : Form
        {
            public PumpForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-4000, -4000);
                Size = new Size(1, 1);
                Opacity = 0.0;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x80;          // WS_EX_TOOLWINDOW
                    cp.ExStyle |= 0x08000000;    // WS_EX_NOACTIVATE
                    return cp;
                }
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY)
                {
                    try
                    {
                        int hotkeyId = m.WParam.ToInt32();
                        if (hotkeyId == ABORT_HOTKEY_ID) OnAbortHotkey();
                        else if (hotkeyId == SOFT_HOTKEY_ID) OnSoftHotkey();
                        else if (hotkeyId == HOTKEY_ID) OnHotkey();
                    }
                    catch { }
                    return;
                }
                base.WndProc(ref m);
            }
        }

        internal sealed class LatticeForm : Form
        {
            private int _spacing = 640;

            public LatticeForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                Rectangle vs = VirtualScreenRect();
                Bounds = new Rectangle(vs.X, vs.Y, vs.Width, vs.Height);
                BackColor = Color.Fuchsia;
                TransparencyKey = Color.Fuchsia;
                Opacity = 0.55;
                SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint |
                         ControlStyles.UserPaint, true);
                DoubleBuffered = true;
            }

            public void SetSpacing(int spacing)
            {
                if (spacing < 20) spacing = 20;
                _spacing = spacing;
                Invalidate();
            }

            public void SetOpacityValue(double value)
            {
                if (value < 0.05) value = 0.05;
                if (value > 1.0) value = 1.0;
                Opacity = value;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x20;          // WS_EX_TRANSPARENT (click-through)
                    cp.ExStyle |= 0x80;          // WS_EX_TOOLWINDOW
                    cp.ExStyle |= 0x08000000;    // WS_EX_NOACTIVATE
                    return cp;
                }
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0084) // WM_NCHITTEST
                {
                    m.Result = new IntPtr(-1); // HTTRANSPARENT
                    return;
                }
                base.WndProc(ref m);
            }

            public void ShowNoActivate()
            {
                if (!Visible) Show();
                try
                {
                    Rectangle vs = VirtualScreenRect();
                    if (Bounds.X != vs.X || Bounds.Y != vs.Y ||
                        Bounds.Width != vs.Width || Bounds.Height != vs.Height)
                    {
                        Bounds = new Rectangle(vs.X, vs.Y, vs.Width, vs.Height);
                    }
                    SetWindowPos(Handle, HWND_TOPMOST, Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                catch { }
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                try
                {
                    Graphics g = e.Graphics;
                    g.SmoothingMode = SmoothingMode.None;
                    Rectangle vs = VirtualScreenRect();
                    int arm = _spacing / 8;
                    if (arm < 6) arm = 6;
                    if (arm > 28) arm = 28;
                    // Client (0,0) is the virtual-screen origin: crossings sit at
                    // virtual origin + k * spacing, matching the host snap model.
                    int startX = 0;
                    int startY = 0;
                    using (Pen shadow = new Pen(Color.FromArgb(255, 0, 0, 0), 3.0f))
                    using (Pen pen = new Pen(Color.FromArgb(255, 0, 230, 255), 1.4f))
                    using (Pen dot = new Pen(Color.FromArgb(255, 255, 255, 255), 1.0f))
                    {
                        for (int x = startX; x < ClientSize.Width; x += _spacing)
                        {
                            for (int y = startY; y < ClientSize.Height; y += _spacing)
                            {
                                g.DrawLine(shadow, x - arm, y, x + arm, y);
                                g.DrawLine(shadow, x, y - arm, x, y + arm);
                                g.DrawLine(pen, x - arm, y, x + arm, y);
                                g.DrawLine(pen, x, y - arm, x, y + arm);
                                g.DrawEllipse(dot, x - 1, y - 1, 3, 3);
                            }
                        }
                    }
                }
                catch { }
            }
        }

        internal sealed class PillForm : Form
        {
            // Geometry shared with StopForm (D-12 split).
            internal const int StopLeft = 272;
            internal const int StopTop = 8;
            internal const int StopWidth = 96;
            internal const int StopHeight = 38;

            private readonly Label _label;

            public PillForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                Size = new Size(380, 54);
                BackColor = Color.FromArgb(24, 26, 32);
                Opacity = 0.96;
                _label = new Label();
                _label.AutoSize = false;
                _label.Location = new Point(14, 10);
                _label.Size = new Size(246, 34);
                _label.ForeColor = Color.White;
                _label.BackColor = Color.Transparent;
                _label.TextAlign = ContentAlignment.MiddleLeft;
                _label.AutoEllipsis = true;
                _label.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold, GraphicsUnit.Point);
                _label.Text = "Click Matrix";
                Controls.Add(_label);
            }

            public void SetLabel(string text)
            {
                if (text == null) text = "";
                _label.Text = text;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x20;          // WS_EX_TRANSPARENT (click-through)
                    cp.ExStyle |= 0x80000;       // WS_EX_LAYERED (required for pass-through)
                    cp.ExStyle |= 0x80;          // WS_EX_TOOLWINDOW
                    cp.ExStyle |= 0x08000000;    // WS_EX_NOACTIVATE
                    return cp;
                }
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0084) // WM_NCHITTEST
                {
                    m.Result = new IntPtr(-1); // HTTRANSPARENT
                    return;
                }
                base.WndProc(ref m);
            }

            public void ShowNoActivate()
            {
                if (!Visible) Show();
                PlacePill(this);
            }
        }

        // D-12: the human escape hatch. This window is deliberately NOT
        // click-through; it owns the only mouse-interactive pixels of the pill.
        internal sealed class StopForm : Form
        {
            public StopForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                Size = new Size(PillForm.StopWidth, PillForm.StopHeight);
                BackColor = Color.FromArgb(190, 44, 44);
                Cursor = Cursors.Hand;
                Font = new Font("Segoe UI", 10f, FontStyle.Bold, GraphicsUnit.Point);
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ExStyle |= 0x80;          // WS_EX_TOOLWINDOW
                    cp.ExStyle |= 0x08000000;    // WS_EX_NOACTIVATE
                    return cp;
                }
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                base.OnPaint(e);
                try
                {
                    TextRenderer.DrawText(e.Graphics, "STOP", Font, ClientRectangle, Color.White,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                }
                catch { }
            }

            protected override void OnMouseClick(MouseEventArgs e)
            {
                base.OnMouseClick(e);
                try { OnPillStop(); } catch { }
            }

            public void PlaceAt(int x, int y)
            {
                Location = new Point(x, y);
                try
                {
                    SetWindowPos(Handle, HWND_TOPMOST, x, y, Width, Height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                catch { }
            }

            public void ShowNoActivate()
            {
                if (!Visible) Show();
                try
                {
                    SetWindowPos(Handle, HWND_TOPMOST, Left, Top, Width, Height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                catch { }
            }
        }
    }
}
