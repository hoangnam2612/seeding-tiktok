using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace SeedingTikTok.ChromeView
{
    public class ChromeViewForm : Form
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        private FlowLayoutPanel pnListDevice;
        private Dictionary<int, Panel> panels = new Dictionary<int, Panel>();
        private System.Windows.Forms.Timer refreshTimer;

        public ChromeViewForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "TikTok Automation Studio - Gom Cửa Sổ (0) Browsers";
            this.Size = new Size(1280, 760);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(18, 18, 20);
            this.ForeColor = Color.White;
            this.Font = new Font("Segoe UI", 9F, FontStyle.Regular);

            pnListDevice = new FlowLayoutPanel();
            pnListDevice.Dock = DockStyle.Fill;
            pnListDevice.AutoScroll = true;
            pnListDevice.BackColor = Color.FromArgb(12, 12, 14);
            pnListDevice.Padding = new Padding(12);
            pnListDevice.WrapContents = true;
            this.Controls.Add(pnListDevice);

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 2000;
            refreshTimer.Tick += (s, e) => UpdateTitleCount();
            refreshTimer.Start();
        }

        public void AddChromeByTitle(string title, int slotIndex, int width, int height)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;

            this.BeginInvoke((MethodInvoker)delegate
            {
                try
                {
                    if (panels.ContainsKey(slotIndex) && pnListDevice.Controls.Contains(panels[slotIndex]))
                    {
                        pnListDevice.Controls.Remove(panels[slotIndex]);
                        panels.Remove(slotIndex);
                    }

                    Panel pnl = new Panel();
                    pnl.Name = "pnl_" + slotIndex;
                    pnl.Size = new Size(width, height);
                    pnl.BackColor = Color.FromArgb(0, 0, 0);
                    pnl.BorderStyle = BorderStyle.FixedSingle;
                    pnl.Margin = new Padding(8);
                    
                    pnListDevice.Controls.Add(pnl);
                    panels[slotIndex] = pnl;

                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        IntPtr chromeHwnd = IntPtr.Zero;
                        for (int attempt = 0; attempt < 25; attempt++)
                        {
                            var procs = Process.GetProcessesByName("chrome");
                            foreach (var p in procs)
                            {
                                try
                                {
                                    if (!string.IsNullOrEmpty(p.MainWindowTitle) && p.MainWindowTitle.Contains(title))
                                    {
                                        chromeHwnd = p.MainWindowHandle;
                                        break;
                                    }
                                }
                                catch {}
                            }
                            if (chromeHwnd != IntPtr.Zero) break;
                            Thread.Sleep(300);
                        }

                        if (chromeHwnd != IntPtr.Zero && !pnl.IsDisposed && pnl.IsHandleCreated)
                        {
                            pnl.BeginInvoke((MethodInvoker)delegate
                            {
                                try
                                {
                                    SetParent(chromeHwnd, pnl.Handle);
                                    // MoveWindow cuts off the top titlebar (-32px) and side frames (-10px)
                                    MoveWindow(chromeHwnd, -10, -32, width + 20, height + 42, true);
                                    UpdateTitleCount();
                                }
                                catch {}
                            });
                        }
                    });
                }
                catch {}
            });
        }

        public void RemoveChrome(int slotIndex)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;

            this.BeginInvoke((MethodInvoker)delegate
            {
                try
                {
                    if (panels.ContainsKey(slotIndex))
                    {
                        var pnl = panels[slotIndex];
                        pnListDevice.Controls.Remove(pnl);
                        panels.Remove(slotIndex);
                        pnl.Dispose();
                        UpdateTitleCount();
                    }
                }
                catch {}
            });
        }

        public void ClearAll()
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;

            this.BeginInvoke((MethodInvoker)delegate
            {
                try
                {
                    pnListDevice.Controls.Clear();
                    panels.Clear();
                    UpdateTitleCount();
                }
                catch {}
            });
        }

        public void BringToFrontView()
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;

            this.BeginInvoke((MethodInvoker)delegate
            {
                try
                {
                    if (this.WindowState == FormWindowState.Minimized)
                    {
                        this.WindowState = FormWindowState.Normal;
                    }
                    this.Show();
                    this.BringToFront();
                    SetForegroundWindow(this.Handle);
                }
                catch {}
            });
        }

        private void UpdateTitleCount()
        {
            int count = pnListDevice.Controls.Count;
            this.Text = string.Format("TikTok Automation Studio - Gom Cửa Sổ ({0}) Browsers", count);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // If user clicks [X], hide instead of terminate
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                this.Hide();
            }
            else
            {
                base.OnFormClosing(e);
            }
        }
    }

    static class Program
    {
        private static ChromeViewForm form;

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            form = new ChromeViewForm();

            // Background thread to listen to standard input commands from Electron
            Thread readerThread = new Thread(ListenCommands);
            readerThread.IsBackground = true;
            readerThread.Start();

            Console.WriteLine("CHROME_VIEW_READY");
            Console.Out.Flush();

            Application.Run(form);
        }

        private static void ListenCommands()
        {
            using (StreamReader reader = new StreamReader(Console.OpenStandardInput()))
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (string.IsNullOrEmpty(line)) continue;

                    try
                    {
                        string[] parts = line.Split(' ');
                        string cmd = parts[0].ToUpperInvariant();

                        if (cmd == "SHOW")
                        {
                            form.BringToFrontView();
                        }
                        else if (cmd == "ADD" && parts.Length >= 5)
                        {
                            string title = parts[1];
                            int slot = int.Parse(parts[2]);
                            int width = int.Parse(parts[3]);
                            int height = int.Parse(parts[4]);
                            form.AddChromeByTitle(title, slot, width, height);
                        }
                        else if (cmd == "REMOVE" && parts.Length >= 2)
                        {
                            int slot = int.Parse(parts[1]);
                            form.RemoveChrome(slot);
                        }
                        else if (cmd == "CLEAR")
                        {
                            form.ClearAll();
                        }
                        else if (cmd == "QUIT")
                        {
                            Application.Exit();
                            break;
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("ERR " + ex.Message);
                    }
                }
            }
        }
    }
}
