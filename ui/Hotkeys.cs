// dsh-dexter — the plugin's own global hotkey owner.
//
// The pixel engine's helper hardcodes Ctrl+Alt+F12 / Ctrl+Alt+F11 / Ctrl+Shift+F11 for its own
// gate, which the plugin bypasses; this process is the one that must bind them to the plugin's
// gate instead. It is a tiny Windows message pump: register, print one line per press on
// stdout, exit when the parent closes stdin or asks it to stop.
//
// Protocol (one line each, UTF-8):
//   ready arm=1 extend=1 soft=1 stop=1        <- registration result per combo
//   failed arm                                <- combo could not be registered
//   event arm | event extend | event soft | event stop
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_ALT = 0x0001;
    private const uint MOD_CONTROL = 0x0002;
    private const uint MOD_SHIFT = 0x0004;
    private const uint MOD_WIN = 0x0008;

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    private sealed class PumpForm : Form
    {
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x80; // WS_EX_TOOLWINDOW: no taskbar entry, no Alt+Tab entry
                return cp;
            }
        }

        public PumpForm()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Location = new System.Drawing.Point(-4000, -4000);
            Size = new System.Drawing.Size(1, 1);
            Opacity = 0;
            Visible = false;
            ShowInTaskbar = false;
        }
    }

    private static readonly object WriteLock = new object();

    private static void Emit(string line)
    {
        try
        {
            lock (WriteLock)
            {
                Console.Out.Write(line + "\n");
                Console.Out.Flush();
            }
        }
        catch { /* the parent is gone */ }
    }

    private static uint Modifier(string token)
    {
        switch (token.Trim().ToLowerInvariant())
        {
            case "ctrl": case "control": return MOD_CONTROL;
            case "alt": return MOD_ALT;
            case "shift": return MOD_SHIFT;
            case "win": case "lwin": case "rwin": return MOD_WIN;
            default: return 0;
        }
    }

    private static uint VirtualKey(string token)
    {
        string t = token.Trim().ToUpperInvariant();
        if (t.Length == 1)
        {
            char c = t[0];
            if (c >= 'A' && c <= 'Z') return (uint)c;
            if (c >= '0' && c <= '9') return (uint)c;
        }
        if (t.StartsWith("F", StringComparison.Ordinal) && t.Length <= 3)
        {
            int n;
            if (int.TryParse(t.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out n) && n >= 1 && n <= 24)
            {
                return (uint)(0x70 + n - 1);
            }
        }
        if (t == "ESC") return 0x1B;
        if (t == "SPACE") return 0x20;
        if (t == "TAB") return 0x09;
        return 0;
    }

    [STAThread]
    private static void Main(string[] args)
    {
        var combos = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            string flag = args[i].TrimStart('-');
            if (flag == "stop-file") continue;
            combos[flag] = args[i + 1];
        }

        var order = new[] { "arm", "extend", "soft", "stop" };
        var mods = new Dictionary<string, uint>();
        var vks = new Dictionary<string, uint>();
        foreach (string name in order)
        {
            string spec;
            if (!combos.TryGetValue(name, out spec) || spec == null || spec.Trim() == "")
            {
                mods[name] = 0;
                vks[name] = 0;
                continue;
            }
            uint m = 0;
            uint vk = 0;
            foreach (string part in spec.Split('+'))
            {
                string p = part.Trim();
                uint asMod = Modifier(p);
                if (asMod != 0) m |= asMod;
                else vk = VirtualKey(p);
            }
            mods[name] = m;
            vks[name] = vk;
        }

        var form = new PumpForm();
        IntPtr handle = form.Handle; // forces handle creation

        var registered = new Dictionary<string, bool>();
        for (int i = 0; i < order.Length; i++)
        {
            string name = order[i];
            if (vks[name] == 0)
            {
                registered[name] = false;
                continue;
            }
            bool ok = false;
            // A previous instance may still be releasing the combo; retry briefly.
            for (int attempt = 0; attempt < 10 && !ok; attempt++)
            {
                ok = RegisterHotKey(handle, i + 1, mods[name], vks[name]);
                if (!ok) Thread.Sleep(120);
            }
            registered[name] = ok;
        }

        int owned = 0;
        foreach (string name in order) if (registered[name]) owned++;
        if (owned == 0)
        {
            Emit("ready none");
            return;
        }
        Emit(string.Format(CultureInfo.InvariantCulture, "ready arm={0} extend={1} soft={2} stop={3}",
            registered["arm"] ? 1 : 0,
            registered["extend"] ? 1 : 0,
            registered["soft"] ? 1 : 0,
            registered["stop"] ? 1 : 0));
        foreach (string name in order)
        {
            if (!registered[name]) Emit("failed " + name);
        }

        // Exit when the parent closes stdin: a plugin reload must not leave a hotkey owner
        // behind, because that would make the next instance lose the registration.
        var stdin = new Thread(delegate ()
        {
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
                {
                    while (reader.ReadLine() != null) { }
                }
            }
            catch { }
            try { if (form.IsHandleCreated) form.BeginInvoke(new Action(delegate { Application.Exit(); })); }
            catch { }
        });
        stdin.IsBackground = true;
        stdin.Start();

        var hook = new HotkeyHook(form);
        hook.Map = registered;
        hook.OnEvent = Emit;
        // Never Show(): a visible window would appear in Alt+Tab and in the desktop capture.
        // A created-but-hidden handle still receives WM_HOTKEY, and ApplicationContext pumps
        // the thread's messages for it.
        Application.Run(new ApplicationContext());
        for (int i = 0; i < order.Length; i++) { try { UnregisterHotKey(handle, i + 1); } catch { } }
    }
}

/// <summary>Receives WM_HOTKEY for the four ids and forwards "event &lt;name&gt;" lines.</summary>
internal sealed class HotkeyHook : NativeWindow
{
    private readonly Form owner;
    public Dictionary<string, bool> Map;
    public Action<string> OnEvent;

    private static readonly string[] Names = { "arm", "extend", "soft", "stop" };

    public HotkeyHook(Form form)
    {
        owner = form;
        owner.HandleCreated += delegate { AssignHandle(owner.Handle); };
        if (owner.IsHandleCreated) AssignHandle(owner.Handle);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312)
        {
            int id = m.WParam.ToInt32();
            if (id >= 1 && id <= Names.Length && OnEvent != null) OnEvent("event " + Names[id - 1]);
        }
        base.WndProc(ref m);
    }
}
