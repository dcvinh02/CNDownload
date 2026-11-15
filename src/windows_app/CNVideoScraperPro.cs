// CN Video Scraper Pro — ứng dụng Windows độc lập (cửa sổ riêng bằng Microsoft WebView2, máy chủ Node chạy ẩn).
// Được dựng ngay trên máy người dùng lúc cài (scripts/setup.js → thành phần "Ứng dụng Windows"),
// bằng bộ dịch C# có sẵn trong Windows (.NET Framework 4.x) — viết theo cú pháp C# 5.
//
// - Không mở trình duyệt Edge, không có cửa sổ dòng lệnh đen.
// - Bật máy chủ `node src\server.js` ẩn; đóng cửa sổ app là tắt máy chủ và mọi tiến trình con (Job Object).
// - Đã có máy chủ chạy sẵn ở cổng 3889 thì dùng lại; chạy app lần 2 thì đưa cửa sổ cũ lên trước.
// - Máy thiếu WebView2 Runtime: báo rõ và mở giao diện trong trình duyệt mặc định.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("CN Video Scraper Pro")]
[assembly: System.Reflection.AssemblyProduct("CN Video Scraper Pro")]
[assembly: System.Reflection.AssemblyDescription("CN Video Scraper Pro")]

namespace CNVideoScraperPro
{
    static class Program
    {
        public const string AppTitle = "CN Video Scraper Pro";

        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [STAThread]
        static int Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--root") root = args[i + 1];

            if (Array.IndexOf(args, "--selftest") >= 0) return SelfTest(root);

            bool created;
            using (Mutex mutex = new Mutex(true, "CNVideoScraperPro_SingleInstance", out created))
            {
                if (!created)
                {
                    // Đã mở rồi → đưa cửa sổ cũ lên trước
                    foreach (Process p in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
                    {
                        if (p.Id != Process.GetCurrentProcess().Id && p.MainWindowHandle != IntPtr.Zero)
                        {
                            ShowWindow(p.MainWindowHandle, 9);
                            SetForegroundWindow(p.MainWindowHandle);
                        }
                    }
                    return 0;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(root));
            }
            return 0;
        }

        /// Kiểm tra nhanh (dùng khi cài): nạp được thư viện WebView2 + có WebView2 Runtime. Ghi kết quả ra stdout.
        static int SelfTest(string root)
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(LoaderFolder(root));
                string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
                Console.WriteLine("OK WebView2 Runtime " + v);
                return 0;
            }
            catch (WebView2RuntimeNotFoundException)
            {
                Console.WriteLine("NO_RUNTIME");
                return 2;
            }
            catch (Exception e)
            {
                Console.WriteLine("ERROR " + e.GetType().Name + ": " + e.Message);
                return 1;
            }
        }

        public static string LoaderFolder(string root)
        {
            string arch = (Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "AMD64").ToUpperInvariant();
            return Path.Combine(root, "bin", "windows_app", arch == "ARM64" ? "arm64" : "x64");
        }
    }

    class MainForm : Form
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint len);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }

        readonly string root;
        readonly string logPath;
        WebView2 web;
        Label status;
        Process server;
        IntPtr job = IntPtr.Zero;
        int port = 3889;

        public MainForm(string root)
        {
            this.root = root;
            this.logPath = Path.Combine(root, "config", "app_window.log");
            Text = Program.AppTitle;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            StartPosition = FormStartPosition.CenterScreen;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1360, wa.Width - 40), Math.Min(880, wa.Height - 40));
            MinimumSize = new Size(960, 640);
            BackColor = Color.White;

            status = new Label();
            status.Dock = DockStyle.Fill;
            status.TextAlign = ContentAlignment.MiddleCenter;
            status.Font = new Font("Segoe UI", 12f);
            status.ForeColor = Color.FromArgb(51, 65, 85);
            status.Text = "Đang khởi động CN Video Scraper Pro...";
            Controls.Add(status);

            Shown += async (s, e) => await StartAsync();
            FormClosing += (s, e) => StopServer();
        }

        void Log(string msg)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(logPath));
                File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        static bool Healthy(int p)
        {
            try
            {
                HttpWebRequest r = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + p + "/api/health");
                r.Timeout = 800; r.ReadWriteTimeout = 800; r.Proxy = null;
                using (HttpWebResponse res = (HttpWebResponse)r.GetResponse()) return (int)res.StatusCode == 200;
            }
            catch { return false; }
        }

        static bool PortFree(int p)
        {
            try { TcpListener l = new TcpListener(IPAddress.Loopback, p); l.Start(); l.Stop(); return true; }
            catch { return false; }
        }

        static int FreePort()
        {
            TcpListener l = new TcpListener(IPAddress.Loopback, 0); l.Start();
            int p = ((IPEndPoint)l.LocalEndpoint).Port; l.Stop(); return p;
        }

        static string FindNode()
        {
            List<string> c = new List<string>();
            foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                if (dir.Trim().Length > 0) c.Add(Path.Combine(dir.Trim().Trim('"'), "node.exe"));
            c.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            c.Add(Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Programs", "nodejs", "node.exe"));
            foreach (string p in c) { try { if (File.Exists(p)) return p; } catch { } }
            return null;
        }

        void StartServer()
        {
            string node = FindNode();
            if (node == null) throw new Exception("Chưa cài Node.js 20+ (https://nodejs.org). Cài Node.js rồi mở lại ứng dụng.");
            if (!File.Exists(Path.Combine(root, "src", "server.js"))) throw new Exception("Không thấy src\\server.js trong " + root);
            port = PortFree(3889) ? 3889 : FreePort();
            ProcessStartInfo si = new ProcessStartInfo(node, "src\\server.js");
            si.WorkingDirectory = root;
            si.UseShellExecute = false;
            si.CreateNoWindow = true;
            si.RedirectStandardOutput = true;
            si.RedirectStandardError = true;
            si.StandardOutputEncoding = Encoding.UTF8;
            si.StandardErrorEncoding = Encoding.UTF8;
            si.EnvironmentVariables["PORT"] = port.ToString();
            server = new Process();
            server.StartInfo = si;
            server.OutputDataReceived += (s, e) => { if (e.Data != null) Log("[server] " + e.Data); };
            server.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("[server!] " + e.Data); };
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
            // Tắt app (kể cả bị diệt đột ngột) → hệ điều hành tự tắt máy chủ + mọi tiến trình con (Python, llama-server)
            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr ptr = Marshal.AllocHGlobal(len);
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(job, 9, ptr, (uint)len);
                Marshal.FreeHGlobal(ptr);
                AssignProcessToJobObject(job, server.Handle);
            }
            catch (Exception e) { Log("Job Object: " + e.Message); }
            Log("Đã bật máy chủ: " + node + " src\\server.js (cổng " + port + ")");
        }

        async Task StartAsync()
        {
            try
            {
                if (Healthy(3889)) { port = 3889; Log("Dùng máy chủ đang chạy sẵn ở cổng 3889"); }
                else
                {
                    StartServer();
                    DateTime until = DateTime.Now.AddSeconds(120);
                    while (!Healthy(port))
                    {
                        if (server.HasExited) throw new Exception("Máy chủ dừng khi khởi động (mã " + server.ExitCode + "). Xem config\\app_window.log");
                        if (DateTime.Now > until) throw new Exception("Máy chủ không phản hồi sau 120 giây. Xem config\\app_window.log");
                        await Task.Delay(400);
                    }
                }
                string url = "http://127.0.0.1:" + port + "/";
                status.Text = "Đang mở giao diện...";
                try
                {
                    CoreWebView2Environment.SetLoaderDllFolderPath(Program.LoaderFolder(root));
                    string dataDir = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? Path.GetTempPath(), "CNVideoScraperPro", "WebView2");
                    CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
                    web = new WebView2();
                    web.Dock = DockStyle.Fill;
                    Controls.Add(web);
                    await web.EnsureCoreWebView2Async(env);
                    web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    web.CoreWebView2.DocumentTitleChanged += (s, e) => { Text = Program.AppTitle; };
                    // Link mở cửa sổ mới (hướng dẫn, trang nền tảng...) → mở trong trình duyệt mặc định
                    web.CoreWebView2.NewWindowRequested += (s, e) =>
                    {
                        e.Handled = true;
                        try { Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); } catch { }
                    };
                    web.CoreWebView2.Navigate(url);
                    status.Visible = false;
                    web.BringToFront();
                    Log("Đã mở giao diện bằng WebView2 " + env.BrowserVersionString + ": " + url);
                }
                catch (WebView2RuntimeNotFoundException)
                {
                    Log("Thiếu Microsoft Edge WebView2 Runtime → mở trình duyệt mặc định");
                    status.Text = "Máy chưa có Microsoft Edge WebView2 Runtime nên giao diện mở trong trình duyệt.\n"
                        + "Cài WebView2 tại https://go.microsoft.com/fwlink/p/?LinkId=2124703 để dùng cửa sổ riêng.\n\n"
                        + "Giữ cửa sổ này mở khi dùng ứng dụng — đóng nó để tắt ứng dụng.";
                    Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                }
            }
            catch (Exception e)
            {
                Log("Lỗi: " + e.Message);
                status.Text = "Không khởi động được ứng dụng:\n" + e.Message;
                MessageBox.Show(this, e.Message, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        void StopServer()
        {
            try { if (web != null) web.Dispose(); } catch { }
            if (server == null) return;
            try
            {
                if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
                if (!server.HasExited) { server.Kill(); server.WaitForExit(5000); }
                Log("Đã tắt máy chủ.");
            }
            catch (Exception e) { Log("Tắt máy chủ: " + e.Message); }
        }
    }
}
