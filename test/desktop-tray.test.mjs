import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sandbox} from './helpers.mjs';

test('实际 Windows 窗口：关闭和最小化进托盘，恢复、启动失败、退出与系统关机行为', t => {
  if (process.platform !== 'win32') return t.skip('Windows Forms requires Windows');
  const sdk = path.resolve('.verification-tmp/webview2-sdk/extracted');
  if (!fs.existsSync(path.join(sdk, 'lib/net462/Microsoft.Web.WebView2.Core.dll'))) return t.skip('Build desktop once to cache the WebView2 SDK');
  const {root} = sandbox(t);
  for (const name of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']) {
    fs.copyFileSync(path.join(sdk, 'lib/net462', name), path.join(root, name));
  }
  fs.copyFileSync(path.join(sdk, 'runtimes/win-x64/native/WebView2Loader.dll'), path.join(root, 'WebView2Loader.dll'));
  // A failing isolated bootstrap exercises loading/error closes without contacting any service.
  fs.writeFileSync(path.join(root, 'bootstrap.ps1'), "Start-Sleep -Milliseconds 500\n[Console]::Error.WriteLine('isolated startup failure')\nexit 1\n");
  fs.writeFileSync(path.join(root, 'desktop.private.json'), '{}');
  const check = path.join(root, 'DesktopTrayCheck.cs');
  fs.writeFileSync(check, `
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
internal static class DesktopTrayCheck {
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);
    private static void Check(bool value, string message) { if(!value) throw new Exception(message); }
    private static void Pump() { Application.DoEvents(); }
    private static NotifyIcon Tray(Form window) { return (NotifyIcon)window.GetType().GetField("tray",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(window); }
    private static void SystemClose(Form window) {
        var closing=new FormClosingEventArgs(CloseReason.WindowsShutDown,false);
        typeof(Form).GetMethod("OnFormClosing",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(window,new object[]{closing});
        Check(!closing.Cancel,"Windows shutdown must not be canceled");
    }
    [STAThread] private static void Main() {
        try { Run(); } catch(Exception error) { Console.Error.WriteLine(error.Message);Environment.ExitCode=1; }
    }
    private static void Run() {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        using(var stream=File.Create(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Chatagent.ico"))) SystemIcons.Application.Save(stream);
        using(var window=new ChatagentWindow(new string[0])) {
            // Keep the real native test window offscreen; no user desktop interaction is required.
            window.StartPosition=FormStartPosition.Manual;window.Location=new Point(-32000,-32000);window.ShowInTaskbar=false;
            int closed=0;window.FormClosed+=delegate{closed++;};
            window.FormClosing+=delegate(object sender,FormClosingEventArgs e){Console.WriteLine("closing reason="+e.CloseReason+" canceled="+e.Cancel);};
            var tray=Tray(window);Check(tray!=null && tray.Visible,"Tray must exist before bootstrap completes");
            window.Show();Pump();
            SendMessage(window.Handle,0x0112,new IntPtr(0xF060),IntPtr.Zero);Pump();
            Check(!window.Visible && !window.IsDisposed && closed==0 && tray.Visible,"Title-bar close state: visible="+window.Visible+" disposed="+window.IsDisposed+" closed="+closed+" tray="+tray.Visible);
            tray.ContextMenuStrip.Items[0].PerformClick();Pump();
            Check(window.Visible && window.WindowState==FormWindowState.Normal,"Tray open must restore the window");
            window.WindowState=FormWindowState.Minimized;Pump();
            Check(!window.Visible && tray.Visible,"Minimize must hide to the tray");
            typeof(NotifyIcon).GetMethod("OnDoubleClick",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(tray,new object[]{EventArgs.Empty});Pump();
            Check(window.Visible && window.WindowState==FormWindowState.Normal,"Tray double-click must restore the window");
            var loading=(Label)window.GetType().GetField("loading",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(window);
            var deadline=DateTime.UtcNow.AddSeconds(10);
            while(!loading.Text.StartsWith("私人空间暂时无法打开") && DateTime.UtcNow<deadline) { Pump();Thread.Sleep(10); }
            Check(loading.Text.Contains("isolated startup failure"),"Isolated startup failure must be visible");
            window.Close();Pump();Check(!window.Visible && !window.IsDisposed && tray.Visible,"Close after startup failure must still hide to tray");
            SystemClose(window);
            Check(tray.ContextMenuStrip.Items[2].Text.Contains("后台服务继续运行"),"Exit must explain that the service is independent");
            tray.ContextMenuStrip.Items[2].PerformClick();Pump();
            Check(window.IsDisposed && closed==1 && !tray.Visible,"Explicit tray exit must dispose exactly once and remove the icon");
        }
        using(var verification=new ChatagentWindow(new[]{"--verify"})) {
            Check(Tray(verification)==null,"Screenshot verification must not create a tray icon");
            var closing=new FormClosingEventArgs(CloseReason.UserClosing,false);
            typeof(Form).GetMethod("OnFormClosing",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(verification,new object[]{closing});
            Check(!closing.Cancel,"Screenshot verification must retain automatic exit");
        }
        Console.WriteLine("desktop tray lifecycle passed");
    }
}
`);
  const exe = path.join(root, 'DesktopTrayCheck.exe');
  const references = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll', path.join(root, 'Microsoft.Web.WebView2.Core.dll'), path.join(root, 'Microsoft.Web.WebView2.WinForms.dll')];
  execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', [
    '/nologo', '/target:exe', '/platform:x64', '/utf8output', '/main:DesktopTrayCheck', '/out:' + exe,
    ...references.map(file => '/reference:' + file), path.resolve('apps/desktop/Chatagent.cs'), check,
  ], {encoding:'utf8', windowsHide:true});
  assert.match(execFileSync(exe, [], {encoding:'utf8', windowsHide:true, timeout:20000}), /desktop tray lifecycle passed/);
});
