// dsh-dexter panel: a small always-on-top status strip that survives being covered.
//
// Why a separate native window: an in-page element (the Web client module) lives inside the
// DSH window, so the moment another app covers that window the widget is gone. This is a
// topmost, borderless WinForms window instead -- same trick the pixel helper uses -- but it
// clamps itself to Screen.WorkingArea, which excludes the taskbar by definition.
//
// It reads <dataDir>\state.txt (UTF-8, line 1 = headline, line 2 = detail) every 500 ms and
// writes <dataDir>\panel-pos.txt so its position survives restarts. It exits when
// <dataDir>\panel.stop exists.
//
// ASCII source only: compiled by the in-box csc, which reads ANSI without a BOM.

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshDexterPanel
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string dir = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "dsh-dexter-panel");
            try
            {
                Directory.CreateDirectory(dir);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new PanelForm(dir));
            }
            catch (Exception error)
            {
                try
                {
                    File.WriteAllText(Path.Combine(dir, "panel-error.txt"), error.ToString(), new UTF8Encoding(false));
                }
                catch { }
                Environment.Exit(1);
            }
        }
    }

    internal sealed class PanelForm : Form
    {
        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_NOACTIVATE = 0x08000000;

        /// <summary>
        /// A status strip must never take focus: if it became the foreground window, the next
        /// keystroke or click from an injection could land on the panel instead of the target.
        /// </summary>
        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
        }

        private const int HTCAPTION = 0x2;
        private const int WM_NCLBUTTONDOWN = 0xA1;

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int index, int value);
        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

        private readonly string dir;
        private readonly string statePath;
        private readonly string posPath;
        private readonly string stopPath;
        private string labelReset = "Reset to top-right";
        private string labelToggle = "Show / hide panel";
        private string labelExit = "Exit panel";
        private string labelTray = "dsh-dexter";
        private readonly System.Windows.Forms.Timer poll;
        private readonly Label dot;
        private readonly Label headline;
        private readonly Label detail;
        private readonly Label hideButton;
        private readonly ContextMenuStrip menu;
        private readonly NotifyIcon tray;

        private bool expanded;
        private bool collapsedToStrip;
        private string lastHeadline = "";
        private string lastDetail = "";

        public PanelForm(string dir)
        {
            this.dir = dir;
            statePath = Path.Combine(dir, "state.txt");
            posPath = Path.Combine(dir, "panel-pos.txt");
            stopPath = Path.Combine(dir, "panel.stop");
            // Before any menu is built: the label file must be read first, or the menus keep
            // the English defaults.
            LoadLabels();

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            ShowInTaskbar = false;
            BackColor = Color.FromArgb(32, 34, 38);
            Opacity = 0.93;
            ClientSize = new Size(252, 42);
            Text = "dsh-dexter";
            Padding = new Padding(0);

            dot = new Label();
            dot.Text = "\u25CF";
            dot.ForeColor = Color.FromArgb(63, 191, 111);
            dot.Font = new Font("Segoe UI", 9f);
            dot.AutoSize = false;
            dot.TextAlign = ContentAlignment.MiddleCenter;
            dot.Size = new Size(18, 42);
            dot.Location = new Point(6, 0);
            Controls.Add(dot);

            headline = new Label();
            headline.Text = "dsh-dexter";
            headline.ForeColor = Color.FromArgb(235, 236, 238);
            headline.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            headline.AutoSize = false;
            headline.TextAlign = ContentAlignment.MiddleLeft;
            headline.Size = new Size(184, 42);
            headline.Location = new Point(24, 0);
            Controls.Add(headline);

            hideButton = new Label();
            hideButton.Text = "\u00D7";
            hideButton.ForeColor = Color.FromArgb(200, 200, 205);
            hideButton.Font = new Font("Segoe UI", 10f);
            hideButton.AutoSize = false;
            hideButton.TextAlign = ContentAlignment.MiddleCenter;
            hideButton.Size = new Size(26, 42);
            hideButton.Location = new Point(214, 0);
            hideButton.Cursor = Cursors.Hand;
            Controls.Add(hideButton);

            detail = new Label();
            detail.Text = "";
            detail.ForeColor = Color.FromArgb(190, 192, 198);
            detail.Font = new Font("Segoe UI", 8.5f);
            detail.AutoSize = false;
            detail.TextAlign = ContentAlignment.TopLeft;
            detail.Size = new Size(236, 110);
            detail.Location = new Point(12, 46);
            detail.Visible = false;
            Controls.Add(detail);

            menu = new ContextMenuStrip();
            menu.Items.Add(labelReset, null, delegate { ResetPosition(); });
            menu.Items.Add(labelToggle, null, delegate { if (collapsedToStrip) ShowFromStrip(); else HideToStrip(); });
            menu.Items.Add(labelExit, null, delegate { Close(); });
            ContextMenuStrip = menu;

            // The tray icon carries the same menu: a borderless window can be dragged off the
            // screen edge or hidden behind another window, so there is always a way back.
            tray = new NotifyIcon();
            tray.Icon = SystemIcons.Application;
            tray.Text = labelTray;
            tray.Visible = true;
            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add(labelToggle, null, delegate { if (collapsedToStrip) ShowFromStrip(); else HideToStrip(); });
            trayMenu.Items.Add(labelReset, null, delegate { ResetPosition(); });
            trayMenu.Items.Add(labelExit, null, delegate { Close(); });
            tray.ContextMenuStrip = trayMenu;
            tray.DoubleClick += delegate { if (collapsedToStrip) ShowFromStrip(); else HideToStrip(); };

            LoadPosition();
            MouseDown += OnDragStart;
            MouseMove += OnDragMove;
            MouseUp += OnDragEnd;
            headline.MouseDown += OnDragStart;
            headline.MouseMove += OnDragMove;
            headline.MouseUp += OnDragEnd;
            dot.MouseDown += OnDragStart;
            dot.MouseMove += OnDragMove;
            dot.MouseUp += OnDragEnd;
            // Deliberately NOT on hideButton: the native move loop (WM_NCLBUTTONDOWN) swallows
            // the mouse-up, so the close label never saw its Click.
            DoubleClick += delegate { ToggleExpanded(); };
            headline.DoubleClick += delegate { ToggleExpanded(); };
            hideButton.Click += delegate { HideToStrip(); };

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 500;
            poll.Tick += delegate { Poll(); };
            poll.Start();
            Poll();
        }

        /// <summary>
        /// Interface text comes from labels.txt (UTF-8, key=value) so this source stays ASCII:
        /// the in-box csc reads a BOM-less file as ANSI, which would mangle Chinese literals.
        /// </summary>
        private void LoadLabels()
        {
            try
            {
                string path = Path.Combine(dir, "labels.txt");
                if (!File.Exists(path)) return;
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int at = line.IndexOf('=');
                    if (at <= 0) continue;
                    string key = line.Substring(0, at).Trim().ToLowerInvariant();
                    string value = line.Substring(at + 1).Trim();
                    if (value.Length == 0) continue;
                    if (key == "reset") labelReset = value;
                    else if (key == "toggle") labelToggle = value;
                    else if (key == "exit") labelExit = value;
                    else if (key == "tray") labelTray = value;
                }
                // Diagnostic: what the menus actually got, so a test can prove the Chinese
                // labels reached the window instead of guessing from a screenshot.
                File.WriteAllText(Path.Combine(dir, "labels-loaded.txt"),
                    "reset=" + labelReset + "\ntoggle=" + labelToggle + "\nexit=" + labelExit + "\ntray=" + labelTray + "\n",
                    new UTF8Encoding(false));
            }
            catch { }
        }

        private bool dragging;
        private Point dragOffset;

        /// <summary>
        /// Manual drag instead of the native move loop: WM_NCLBUTTONDOWN + HTCAPTION hands
        /// the mouse to the window manager, which swallows the button-up so child controls
        /// (the close label) never receive a Click.
        /// </summary>
        private void OnDragStart(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            dragging = true;
            dragOffset = new Point(Cursor.Position.X - Location.X, Cursor.Position.Y - Location.Y);
        }

        private void OnDragMove(object sender, MouseEventArgs e)
        {
            if (!dragging) return;
            Location = new Point(Cursor.Position.X - dragOffset.X, Cursor.Position.Y - dragOffset.Y);
        }

        private void OnDragEnd(object sender, MouseEventArgs e)
        {
            if (!dragging) return;
            dragging = false;
            ClampIntoWorkingArea();
            SavePosition();
        }

        private void ToggleExpanded()
        {
            expanded = !expanded;
            detail.Visible = expanded;
            ClientSize = new Size(expanded ? 264 : 252, expanded ? 166 : 42);
            ClampIntoWorkingArea();
            SavePosition();
        }

        private void HideToStrip()
        {
            collapsedToStrip = true;
            expanded = false;
            detail.Visible = false;
            ClientSize = new Size(14, 56);
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(work.Right - 14, work.Top + (work.Height - 56) / 2);
            headline.Visible = false;
            detail.Visible = false;
            hideButton.Visible = false;
            dot.Visible = false;
            SavePosition();
        }

        private void ShowFromStrip()
        {
            collapsedToStrip = false;
            headline.Visible = true;
            hideButton.Visible = true;
            dot.Visible = true;
            ClientSize = new Size(252, 42);
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(work.Right - 252 - 24, work.Top + 40);
            ClampIntoWorkingArea();
            SavePosition();
        }

        /// <summary>Clamp inside the working area: the taskbar is outside it, so it is never covered.</summary>
        private void ClampIntoWorkingArea()
        {
            Rectangle work = Screen.FromPoint(Location).WorkingArea;
            int x = Math.Max(work.Left, Math.Min(Location.X, work.Right - Width));
            int y = Math.Max(work.Top, Math.Min(Location.Y, work.Bottom - Height));
            Location = new Point(x, y);
        }

        private void ResetPosition()
        {
            Rectangle work = Screen.FromPoint(Cursor.Position).WorkingArea;
            Location = new Point(work.Right - Width - 24, work.Top + 40);
            ClampIntoWorkingArea();
            SavePosition();
        }

        private void LoadPosition()
        {
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(work.Right - 252 - 24, work.Top + 40);
            try
            {
                if (File.Exists(posPath))
                {
                    string[] parts = File.ReadAllText(posPath, Encoding.UTF8).Split(',');
                    if (parts.Length >= 2)
                    {
                        int px = int.Parse(parts[0]);
                        int py = int.Parse(parts[1]);
                        Location = new Point(px, py);
                    }
                }
            }
            catch { }
            ClampIntoWorkingArea();
        }

        private void SavePosition()
        {
            try
            {
                File.WriteAllText(posPath, Location.X + "," + Location.Y, new UTF8Encoding(false));
            }
            catch { }
        }

        private void Poll()
        {
            if (File.Exists(stopPath)) { Close(); return; }
            try
            {
                if (File.Exists(statePath))
                {
                    string[] lines = File.ReadAllLines(statePath, Encoding.UTF8);
                    string head = lines.Length > 0 ? lines[0] : "";
                    string body = lines.Length > 1 ? lines[1] : "";
                    if (head != lastHeadline || body != lastDetail)
                    {
                        lastHeadline = head;
                        lastDetail = body;
                        if (head.Length > 0) headline.Text = head;
                        if (body.Length > 0) detail.Text = body;
                    }
                }
                RunCommand();
            }
            catch { }
        }

        /// <summary>
        /// One-shot commands written by the plugin (`cmd.txt`): a keyboard-free way to move,
        /// hide or close the strip when the pointer is busy somewhere else.
        /// </summary>
        private void RunCommand()
        {
            string cmdPath = Path.Combine(dir, "cmd.txt");
            if (!File.Exists(cmdPath)) return;
            string command = "";
            try
            {
                command = File.ReadAllText(cmdPath, Encoding.UTF8).Trim().ToLowerInvariant();
            }
            catch { }
            try { File.Delete(cmdPath); } catch { }
            if (command == "show") ShowFromStrip();
            else if (command == "hide") HideToStrip();
            else if (command == "reset") ResetPosition();
            else if (command == "exit") Close();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                try
                {
                    if (tray != null) { tray.Visible = false; tray.Dispose(); }
                }
                catch { }
            }
            base.Dispose(disposing);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (!collapsedToStrip) ClampIntoWorkingArea();
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (collapsedToStrip) ShowFromStrip();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            try
            {
                poll.Stop();
                SavePosition();
            }
            catch { }
            base.OnFormClosing(e);
        }
    }
}
