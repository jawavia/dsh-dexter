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
        private const int WS_EX_TRANSPARENT = 0x20;
        private const int GWL_EXSTYLE = -20;
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;

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
        private readonly System.Windows.Forms.Timer poll;
        private readonly Label dot;
        private readonly Label headline;
        private readonly Label detail;
        private readonly Label hideButton;
        private readonly ContextMenuStrip menu;

        private bool expanded;
        private bool clickThrough;
        private bool collapsedToStrip;
        private string lastHeadline = "";
        private string lastDetail = "";

        public PanelForm(string dir)
        {
            this.dir = dir;
            statePath = Path.Combine(dir, "state.txt");
            posPath = Path.Combine(dir, "panel-pos.txt");
            stopPath = Path.Combine(dir, "panel.stop");

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
            menu.Items.Add("Reset to top-right", null, delegate { ResetPosition(); });
            menu.Items.Add("Toggle click-through", null, delegate { SetClickThrough(!clickThrough); });
            menu.Items.Add("Exit panel", null, delegate { Close(); });
            ContextMenuStrip = menu;

            LoadPosition();
            MouseDown += OnDragStart;
            headline.MouseDown += OnDragStart;
            dot.MouseDown += OnDragStart;
            hideButton.MouseDown += OnDragStart;
            DoubleClick += delegate { ToggleExpanded(); };
            headline.DoubleClick += delegate { ToggleExpanded(); };
            hideButton.Click += delegate { HideToStrip(); };

            poll = new System.Windows.Forms.Timer();
            poll.Interval = 500;
            poll.Tick += delegate { Poll(); };
            poll.Start();
            Poll();
        }

        private void OnDragStart(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
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

        private void SetClickThrough(bool on)
        {
            clickThrough = on;
            int style = GetWindowLong(Handle, GWL_EXSTYLE);
            int next = on ? (style | WS_EX_TRANSPARENT) : (style & ~WS_EX_TRANSPARENT);
            SetWindowLong(Handle, GWL_EXSTYLE, next);
            menu.Items[1].Text = on ? "Disable click-through" : "Enable click-through";
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
            }
            catch { }
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
