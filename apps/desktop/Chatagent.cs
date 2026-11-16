using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("fish with me")]
[assembly: System.Reflection.AssemblyDescription("fish with me · 本机桌面版")]
[assembly: System.Reflection.AssemblyVersion("0.4.9.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.4.9.0")]

internal sealed class ChatagentWindow : Form {
    private readonly WebView2 web = new WebView2();
    private readonly Label loading = new Label();
    private delegate bool EnumWindowProc(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern bool SetProp(IntPtr window,string name,IntPtr value);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr GetProp(IntPtr window,string name);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr RemoveProp(IntPtr window,string name);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback,IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
    private static readonly uint activationMessage=RegisterWindowMessage("FishWithMe.ActivateWindow.v1");
    private static string ActivationKey(bool installed) { return installed?"FishWithMe.InstalledWindow.v1":"FishWithMe.DevelopmentWindow.v1"; }
    internal static bool ActivateExistingWindow(bool installed) {
        for(int attempt=0;attempt<60;attempt++) {
            bool sent=false;
            EnumWindows(delegate(IntPtr window,IntPtr parameter) {
                if(GetProp(window,ActivationKey(installed))!=new IntPtr(1))return true;
                uint pid;GetWindowThreadProcessId(window,out pid);AllowSetForegroundWindow(pid);
                sent=PostMessage(window,activationMessage,IntPtr.Zero,IntPtr.Zero);return !sent;
            },IntPtr.Zero);
            if(sent)return true;
            Thread.Sleep(50);
        }
        return false;
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);if(!verify)SetProp(Handle,ActivationKey(installed),new IntPtr(1));
    }
    protected override void OnHandleDestroyed(EventArgs e) {
        if(!verify)RemoveProp(Handle,ActivationKey(installed));base.OnHandleDestroyed(e);
    }
    protected override void WndProc(ref Message message) {
        if(message.Msg==activationMessage && !verify){RestoreWindow();message.Result=IntPtr.Zero;return;}
        base.WndProc(ref message);
    }
    private NotifyIcon tray;
    private bool exitRequested;
    private string origin;
    private readonly string screenshot;
    private readonly string route;
    private readonly bool verify;
    private readonly bool installed = File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"installed.json"));
    private string setupPrompt;
    internal ChatagentWindow(string[] args) {
        Text = "fish with me";
        Size = new Size(1240, 850); MinimumSize = new Size(920, 660);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(246,248,252);
        Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Chatagent.ico"));
        loading.Text = "正在打开 fish with me…"; loading.Dock = DockStyle.Fill;
        loading.TextAlign = ContentAlignment.MiddleCenter; loading.Font = new Font("Microsoft YaHei UI",14);
        loading.ForeColor = Color.FromArgb(70,110,165); Controls.Add(loading);
        web.Dock = DockStyle.Fill;
        verify = args.Length > 0 && args[0] == "--verify";
        screenshot = verify && args.Length > 1 ? Path.GetFullPath(args[1]) : null;
        var verifyRoutes = new HashSet<string> { "/", "/settings", "/plugins", "/customize", "/archive", "/devices", "/archive?kind=diaries", "/archive?kind=bili-legacy", "/manage?tab=personas", "/manage?tab=settings", "/manage?tab=sessions", "/models" };
        route = verify && args.Length > 2 && verifyRoutes.Contains(args[2]) ? args[2] : "/overview";
        if(!verify) {
            tray=new NotifyIcon();tray.Icon=Icon;tray.Text="fish with me";tray.Visible=true;
            var menu=new ContextMenuStrip();
            menu.Items.Add("打开 fish with me",null,delegate{RestoreWindow();});
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出桌面端（后台服务继续运行）",null,delegate{exitRequested=true;Close();});
            if(installed) {
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("复制首次连接提示词",null,delegate{if(!String.IsNullOrEmpty(setupPrompt)){Clipboard.SetText(setupPrompt);MessageBox.Show("已复制。粘贴给本机 DSH 或 Codex，完成后导入连接配置。","fish with me");}});
                menu.Items.Add("导入 DSH 连接配置…",null,async delegate{
                    using(var dialog=new OpenFileDialog()){dialog.Title="选择 DSH 桥接客户端配置";dialog.Filter="JSON 连接配置|*.json";
                        if(dialog.ShowDialog(this)==DialogResult.OK){await OpenSpace(dialog.FileName);RestoreWindow();}
                    }
                });
                menu.Items.Add("新手教程",null,delegate{if(origin!=null && web.CoreWebView2!=null){web.CoreWebView2.Navigate(origin+"/speech-guide");RestoreWindow();}});
            }
            tray.ContextMenuStrip=menu;
            tray.DoubleClick+=delegate{RestoreWindow();};
            Resize+=delegate{if(WindowState==FormWindowState.Minimized)Hide();};
        }
        FormClosing += delegate(object sender,FormClosingEventArgs e) {
            if(!verify && !exitRequested && e.CloseReason==CloseReason.UserClosing) { e.Cancel=true;Hide(); }
        };
        Shown += async delegate { await OpenSpace(); };
        FormClosed += delegate { if(tray != null) { tray.Visible=false;tray.ContextMenuStrip.Dispose();tray.Dispose(); } web.Dispose(); };
    }
    private void RestoreWindow() { Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();SetForegroundWindow(Handle); }
    private async Task OpenSpace(string connection = null) {
        try {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string arguments = installed ? "-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(folder,"installed-bootstrap.ps1")+"\""+(connection==null?"":" -Connection \""+connection+"\"") : "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(folder,"bootstrap.ps1") + "\" -Settings \"" + Path.Combine(folder,"desktop.private.json") + "\"";
            var info = new ProcessStartInfo("powershell.exe", arguments);
            info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
            info.StandardOutputEncoding=System.Text.Encoding.UTF8; info.StandardErrorEncoding=System.Text.Encoding.UTF8;
            string result = await Task.Run(delegate {
                using(var process=Process.Start(info)) {
                    var output=process.StandardOutput.ReadToEndAsync(); var error=process.StandardError.ReadToEndAsync();
                    if(!process.WaitForExit(70000)) { process.Kill(); throw new Exception("备用服务启动超时，原有资料和服务未被停止。"); }
                    Task.WaitAll(output,error); if(process.ExitCode!=0) throw new Exception("无法确认备用服务。请检查本机运行配置；不会接管未知端口。\n"+error.Result);
                    return output.Result;
                }
            });
            var parsed=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(result);
            origin=(string)parsed["url"];
            if(installed)setupPrompt=(string)parsed["setupPrompt"];
            Uri local;
            if(!Uri.TryCreate(origin,UriKind.Absolute,out local) || local.Scheme!="http" || local.Host!="127.0.0.1" || local.Port<37821 || local.Port>37999 || local.AbsolutePath!="/" || local.UserInfo!="" || local.Query!="" || local.Fragment!="") throw new Exception("桌面入口必须使用指定本机备用服务。");
            if(web.CoreWebView2!=null){web.BringToFront();web.CoreWebView2.Navigate(origin+route);return;}
            string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Chatagent","DesktopProfile");
            if(installed)profile=Path.Combine((string)parsed["dataRoot"],"DesktopProfile");
            var environment=await CoreWebView2Environment.CreateAsync(null,profile);
            Controls.Add(web); await web.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.Settings.AreDevToolsEnabled=false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled=true;
            web.CoreWebView2.Settings.IsStatusBarEnabled=false;
            web.CoreWebView2.Settings.IsGeneralAutofillEnabled=false;
            web.CoreWebView2.Settings.IsPasswordAutosaveEnabled=false;
            web.CoreWebView2.NavigationStarting += delegate(object sender,CoreWebView2NavigationStartingEventArgs e) {
                Uri target; if(!Uri.TryCreate(e.Uri,UriKind.Absolute,out target) || target.GetLeftPart(UriPartial.Authority)!=origin) e.Cancel=true;
            };
            web.CoreWebView2.NewWindowRequested += delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) {
                e.Handled=true;
                Uri target;
                if(e.IsUserInitiated && Uri.TryCreate(e.Uri,UriKind.Absolute,out target) && target.Scheme=="https" && target.UserInfo=="") {
                    try{Process.Start(new ProcessStartInfo(target.AbsoluteUri){UseShellExecute=true});}
                    catch{MessageBox.Show("无法打开浏览器，请复制链接后打开。","fish with me");}
                }
            };
            web.CoreWebView2.PermissionRequested += delegate(object sender,CoreWebView2PermissionRequestedEventArgs e) { e.State=CoreWebView2PermissionState.Deny; };
            web.CoreWebView2.NavigationCompleted += async delegate(object sender,CoreWebView2NavigationCompletedEventArgs e) {
                if(!e.IsSuccess) { loading.Text="页面加载失败。请重新打开窗口，现有聊天仍保留。";loading.BringToFront();return; }
                if(verify && screenshot!=null) {
                    await Task.Delay(2200);
                    using(var stream=File.Create(screenshot)) await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png,stream);
                    string state=await web.CoreWebView2.ExecuteScriptAsync("JSON.stringify({title:document.title,path:location.pathname,nav:document.querySelectorAll('.nav-item').length,overflow:document.documentElement.scrollWidth>innerWidth,heading:document.querySelector('h1')?.textContent,body:document.body.innerText.slice(0,1600)})");
                    File.WriteAllText(screenshot+".json",state); Close();
                }
            };
            web.BringToFront(); web.CoreWebView2.Navigate(origin+(installed && (bool)parsed["firstRun"]?"/installed-start":route));
        } catch(Exception error) {
            loading.Text="私人空间暂时无法打开\n"+error.Message;loading.BringToFront();
            if(verify && screenshot!=null) { File.WriteAllText(screenshot+".error.txt",error.ToString());Environment.ExitCode=1;Close(); }
        }
    }
    [STAThread] private static void Main(string[] args) {
        bool verification = args.Length > 0 && args[0] == "--verify";
        string mutexName = verification ? "Local\\ChatagentDesktopVerify-" + Process.GetCurrentProcess().Id : File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"installed.json")) ? "Local\\FishWithMeInstalledWindow" : "Local\\ChatagentDesktopWindow";
        using(var mutex=new Mutex(false,mutexName)) {
            if(!mutex.WaitOne(0,false)) { ActivateExistingWindow(File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"installed.json")));return; }
            try { Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new ChatagentWindow(args)); }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
