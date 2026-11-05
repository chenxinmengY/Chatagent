using System;
using System.IO;
using System.Drawing;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("Chatagent")]
[assembly: System.Reflection.AssemblyDescription("小鲸鱼的私人空间 · 本机桌面版")]
[assembly: System.Reflection.AssemblyVersion("0.4.4.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.4.4.0")]

internal sealed class ChatagentWindow : Form {
    private readonly WebView2 web = new WebView2();
    private readonly Label loading = new Label();
    private NotifyIcon tray;
    private bool exitRequested;
    private string origin;
    private readonly string screenshot;
    private readonly string route;
    private readonly bool verify;
    internal ChatagentWindow(string[] args) {
        Text = "Chatagent · 小鲸鱼的私人空间";
        Size = new Size(1240, 850); MinimumSize = new Size(920, 660);
        StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(246,248,252);
        Icon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Chatagent.ico"));
        loading.Text = "正在打开小鲸鱼的私人空间…"; loading.Dock = DockStyle.Fill;
        loading.TextAlign = ContentAlignment.MiddleCenter; loading.Font = new Font("Microsoft YaHei UI",14);
        loading.ForeColor = Color.FromArgb(70,110,165); Controls.Add(loading);
        web.Dock = DockStyle.Fill;
        verify = args.Length > 0 && args[0] == "--verify";
        screenshot = verify && args.Length > 1 ? Path.GetFullPath(args[1]) : null;
        var verifyRoutes = new HashSet<string> { "/", "/settings", "/plugins", "/customize", "/archive", "/devices", "/archive?kind=diaries", "/archive?kind=bili-legacy", "/manage?tab=personas", "/manage?tab=settings", "/manage?tab=sessions", "/models" };
        route = verify && args.Length > 2 && verifyRoutes.Contains(args[2]) ? args[2] : "/overview";
        if(!verify) {
            tray=new NotifyIcon();tray.Icon=Icon;tray.Text="Chatagent · 私人空间";tray.Visible=true;
            var menu=new ContextMenuStrip();
            menu.Items.Add("打开私人空间",null,delegate{RestoreWindow();});
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出桌面端（后台服务继续运行）",null,delegate{exitRequested=true;Close();});
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
    private void RestoreWindow() { Show();WindowState=FormWindowState.Normal;Activate(); }
    private async Task OpenSpace() {
        try {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            var info = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(folder,"bootstrap.ps1") + "\" -Settings \"" + Path.Combine(folder,"desktop.private.json") + "\"");
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
            Uri local;
            if(!Uri.TryCreate(origin,UriKind.Absolute,out local) || local.Scheme!="http" || local.Host!="127.0.0.1" || local.Port<37821 || local.Port>37999 || local.AbsolutePath!="/" || local.UserInfo!="" || local.Query!="" || local.Fragment!="") throw new Exception("桌面入口必须使用指定本机备用服务。");
            string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Chatagent","DesktopProfile");
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
            web.CoreWebView2.NewWindowRequested += delegate(object sender,CoreWebView2NewWindowRequestedEventArgs e) { e.Handled=true; };
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
            web.BringToFront(); web.CoreWebView2.Navigate(origin+route);
        } catch(Exception error) {
            loading.Text="私人空间暂时无法打开\n"+error.Message;loading.BringToFront();
            if(verify && screenshot!=null) { File.WriteAllText(screenshot+".error.txt",error.ToString());Environment.ExitCode=1;Close(); }
        }
    }
    [STAThread] private static void Main(string[] args) {
        bool verification = args.Length > 0 && args[0] == "--verify";
        string mutexName = verification ? "Local\\ChatagentDesktopVerify-" + Process.GetCurrentProcess().Id : "Local\\ChatagentDesktopWindow";
        using(var mutex=new Mutex(false,mutexName)) {
            if(!mutex.WaitOne(0,false)) { MessageBox.Show("Chatagent 桌面窗口已经打开，请从任务栏或托盘打开。","Chatagent");return; }
            try { Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Application.Run(new ChatagentWindow(args)); }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
