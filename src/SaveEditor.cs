using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NextJianghu2SaveEditor
{
    internal static class Program
    {
        public const string AppTitle = "\ud558\uc77c\ucc38\uac15\ud6382 \uc138\uc774\ube0c \uc5d0\ub514\ud130 v1.0";
        public const string VirtualHost = "nj2-editor.local";

        private const string HtmlResourceName = "NextJianghu2SaveEditor.html";
        private const string CoreResourceName = "Microsoft.Web.WebView2.Core.dll";
        private const string WinFormsResourceName = "Microsoft.Web.WebView2.WinForms.dll";
        private const string LoaderResourceName = "WebView2Loader.dll";

        private static string _localAppDataBase;
        private static string _runtimeDir;
        private static string _htmlDir;
        private static string _htmlFilePath;
        private static readonly object _resolveLock = new object();
        private static bool _resolveHooked;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                _localAppDataBase = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "NextJianghu2SaveEditor");
                _runtimeDir = Path.Combine(_localAppDataBase, "runtime-1.0.0");
                _htmlDir = Path.Combine(_localAppDataBase, "html-1.0.0");
                _htmlFilePath = Path.Combine(_htmlDir, HtmlResourceName);

                HookAssemblyResolver();
                InitializeWebView2Loader(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
                ExtractHtml();

                bool selfTest = false;
                string outDir = null;
                string seedSavePath = null;

                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i];
                    if (string.Equals(a, "--self-test", StringComparison.OrdinalIgnoreCase))
                    {
                        selfTest = true;
                        if (i + 1 < args.Length)
                        {
                            outDir = args[i + 1];
                            i++;
                        }
                        if (i + 1 < args.Length)
                        {
                            seedSavePath = args[i + 1];
                            i++;
                        }
                    }
                }

                if (selfTest)
                {
                    if (string.IsNullOrEmpty(outDir))
                    {
                        TrySafeStderr("self-test requires outDir");
                        return 1;
                    }
                    try
                    {
                        Directory.CreateDirectory(outDir);
                    }
                    catch
                    {
                    }

                    bool ok = SelfTestRunner.Run(outDir, seedSavePath);
                    return ok ? 0 : 1;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
                {
                    try
                    {
                        MessageBox.Show(e.Exception.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    catch
                    {
                    }
                };

                using (SaveEditorForm form = new SaveEditorForm(_htmlDir, _localAppDataBase))
                {
                    Application.Run(form);
                }
                return 0;
            }
            catch (Exception ex)
            {
                TrySafeStderr(ex.ToString());
                return 1;
            }
        }

        private static void TrySafeStderr(string text)
        {
            try
            {
                Console.Error.WriteLine(text);
            }
            catch
            {
            }
        }

        private static void HookAssemblyResolver()
        {
            lock (_resolveLock)
            {
                if (_resolveHooked)
                {
                    return;
                }
                _resolveHooked = true;
            }
            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            try
            {
                string simpleName;
                try
                {
                    AssemblyName an = new AssemblyName(args.Name);
                    simpleName = an.Name;
                }
                catch
                {
                    return null;
                }

                if (string.Equals(simpleName, "Microsoft.Web.WebView2.Core", StringComparison.OrdinalIgnoreCase))
                {
                    return LoadEmbeddedAssembly(CoreResourceName);
                }
                if (string.Equals(simpleName, "Microsoft.Web.WebView2.WinForms", StringComparison.OrdinalIgnoreCase))
                {
                    return LoadEmbeddedAssembly(WinFormsResourceName);
                }
            }
            catch
            {
            }
            return null;
        }

        private static Assembly LoadEmbeddedAssembly(string fileName)
        {
            byte[] bytes = ReadEmbeddedBytes(fileName);
            if (bytes == null || bytes.Length == 0)
            {
                return null;
            }
            return Assembly.Load(bytes);
        }

        internal static async Task<CoreWebView2> InitializeWebViewCoreAsync(
            WebView2 webView,
            EventHandler<CoreWebView2WebMessageReceivedEventArgs> webMessageHandler,
            EventHandler<CoreWebView2NavigationCompletedEventArgs> navCompletedHandler)
        {
            string userData = UserDataFolder;
            try { Directory.CreateDirectory(userData); } catch { }

            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userData);
            await webView.EnsureCoreWebView2Async(env);

            CoreWebView2 core = webView.CoreWebView2;
            if (core == null)
            {
                return null;
            }

            CoreWebView2Settings settings = core.Settings;
            if (settings != null)
            {
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.IsStatusBarEnabled = false;
                try { settings.AreHostObjectsAllowed = false; } catch { }
            }

            core.NavigationStarting += OnRestrictedNavigationStarting;
            core.NewWindowRequested += OnNewWindowBlocked;
            if (webMessageHandler != null)
            {
                core.WebMessageReceived += webMessageHandler;
            }
            if (navCompletedHandler != null)
            {
                core.NavigationCompleted += navCompletedHandler;
            }

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                HtmlDir,
                CoreWebView2HostResourceAccessKind.Deny);

            return core;
        }

        private static void OnRestrictedNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            try
            {
                Uri uri;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri))
                {
                    e.Cancel = true;
                    return;
                }
                if (!uri.ToString().StartsWith(AllowedUrlPrefix, StringComparison.OrdinalIgnoreCase))
                {
                    e.Cancel = true;
                }
            }
            catch
            {
                e.Cancel = true;
            }
        }

        private static void OnNewWindowBlocked(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
        }

        private static string FindResourceName(string fileName)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            string[] names = asm.GetManifestResourceNames();
            if (names == null)
            {
                return null;
            }

            for (int i = 0; i < names.Length; i++)
            {
                if (string.Equals(names[i], fileName, StringComparison.OrdinalIgnoreCase))
                {
                    return names[i];
                }
            }
            for (int i = 0; i < names.Length; i++)
            {
                if (names[i] != null && names[i].EndsWith("." + fileName, StringComparison.OrdinalIgnoreCase))
                {
                    return names[i];
                }
            }
            for (int i = 0; i < names.Length; i++)
            {
                if (names[i] != null && names[i].IndexOf(fileName, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return names[i];
                }
            }
            return null;
        }

        public static void InitializeWebView2Loader(string localAppData)
        {
            try
            {
                string baseDir = Path.Combine(localAppData, "NextJianghu2SaveEditor");
                string runtimeDir = Path.Combine(baseDir, "runtime-1.0.0");
                Directory.CreateDirectory(runtimeDir);
                string target = Path.Combine(runtimeDir, "WebView2Loader.dll");

                bool needWrite = true;
                if (File.Exists(target))
                {
                    try
                    {
                        FileInfo fi = new FileInfo(target);
                        if (fi.Length > 0)
                        {
                            needWrite = false;
                        }
                    }
                    catch
                    {
                        needWrite = true;
                    }
                }

                if (needWrite)
                {
                    byte[] bytes = ReadEmbeddedBytes(LoaderResourceName);
                    if (bytes != null && bytes.Length > 0)
                    {
                        File.WriteAllBytes(target, bytes);
                    }
                }

                try
                {
                    CoreWebView2Environment.SetLoaderDllFolderPath(runtimeDir);
                }
                catch
                {
                }
            }
            catch
            {
            }
        }

        private static byte[] ReadEmbeddedBytes(string fileName)
        {
            string actual = FindResourceName(fileName);
            if (actual == null)
            {
                return null;
            }
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream(actual))
            {
                if (s == null)
                {
                    return null;
                }
                using (MemoryStream ms = new MemoryStream())
                {
                    byte[] buf = new byte[81920];
                    int read;
                    while ((read = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        ms.Write(buf, 0, read);
                    }
                    return ms.ToArray();
                }
            }
        }

        private static void ExtractHtml()
        {
            try
            {
                Directory.CreateDirectory(_htmlDir);
                byte[] bytes = ReadEmbeddedBytes(HtmlResourceName);
                if (bytes != null && bytes.Length > 0)
                {
                    bool needWrite = true;
                    try
                    {
                        if (File.Exists(_htmlFilePath))
                        {
                            FileInfo fi = new FileInfo(_htmlFilePath);
                            if (fi.Length == bytes.Length)
                            {
                                needWrite = false;
                            }
                        }
                    }
                    catch
                    {
                        needWrite = true;
                    }

                    if (needWrite)
                    {
                        File.WriteAllBytes(_htmlFilePath, bytes);
                    }
                }
            }
            catch
            {
            }
        }

        public static string LocalAppDataBase
        {
            get { return _localAppDataBase; }
        }

        public static string RuntimeDir
        {
            get { return _runtimeDir; }
        }

        public static string HtmlDir
        {
            get { return _htmlDir; }
        }

        public static string HtmlFilePath
        {
            get { return _htmlFilePath; }
        }

        public static string UserDataFolder
        {
            get
            {
                string baseDir = _localAppDataBase;
                if (string.IsNullOrEmpty(baseDir))
                {
                    baseDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "NextJianghu2SaveEditor");
                }
                return Path.Combine(baseDir, "webview2-1.0.0");
            }
        }

        public static string StartUrl
        {
            get { return "https://" + VirtualHost + "/NextJianghu2SaveEditor.html"; }
        }

        public static string AllowedUrlPrefix
        {
            get { return "https://" + VirtualHost + "/"; }
        }
    }

    internal sealed class SaveEditorForm : Form
    {
        private readonly string _htmlDir;
        private readonly string _localAppDataBase;
        private WebView2 _webView;
        private bool _envReady;

        public SaveEditorForm(string htmlDir, string localAppDataBase)
        {
            _htmlDir = htmlDir;
            _localAppDataBase = localAppDataBase;

            Text = Program.AppTitle;
            Width = 1280;
            Height = 840;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 640);

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            Load += OnFormLoad;
        }

        private void OnFormLoad(object sender, EventArgs e)
        {
            InitializeEnvironmentAsync();
        }

        private async void InitializeEnvironmentAsync()
        {
            try
            {
                CoreWebView2 core = await Program.InitializeWebViewCoreAsync(_webView, OnWebMessageReceived, null);
                if (core == null)
                {
                    MessageBox.Show(this, "WebView2 core is not available.", Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                _envReady = true;
                core.Navigate(Program.StartUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        public bool EnvironmentReady
        {
            get { return _envReady; }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string replyJson;
            try
            {
                string json = e.WebMessageAsJson;
                if (json == null)
                {
                    json = e.TryGetWebMessageAsString();
                }
                replyJson = MessageDispatcher.Handle(json);
            }
            catch (Exception ex)
            {
                replyJson = MessageDispatcher.BuildError(ex);
            }

            try
            {
                if (_webView != null && _webView.CoreWebView2 != null)
                {
                    _webView.CoreWebView2.PostWebMessageAsJson(replyJson);
                }
            }
            catch
            {
            }
        }
    }

    internal static class MessageDispatcher
    {
        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = int.MaxValue;
            ser.RecursionLimit = int.MaxValue;
            return ser;
        }

        public static string BuildError(Exception ex)
        {
            string message;
            if (ex == null)
            {
                message = "Unknown error";
            }
            else
            {
                message = ex.Message;
            }
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["type"] = "error";
            map["message"] = message;
            return CreateSerializer().Serialize(map);
        }

        public static string Handle(string json)
        {
            JavaScriptSerializer ser = CreateSerializer();
            Dictionary<string, object> req;
            try
            {
                req = ser.Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Invalid JSON message";
                return ser.Serialize(err);
            }

            if (req == null)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Empty JSON message";
                return ser.Serialize(err);
            }

            string type = GetString(req, "type");
            if (type == null)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Missing type";
                return ser.Serialize(err);
            }

            if (string.Equals(type, "discover", StringComparison.OrdinalIgnoreCase))
            {
                return HandleDiscover(ser);
            }
            if (string.Equals(type, "load", StringComparison.OrdinalIgnoreCase))
            {
                return HandleLoad(ser, req);
            }
            if (string.Equals(type, "save", StringComparison.OrdinalIgnoreCase))
            {
                return HandleSave(ser, req);
            }

            Dictionary<string, object> unknown = new Dictionary<string, object>();
            unknown["type"] = "error";
            unknown["message"] = "Unknown message type: " + type;
            return ser.Serialize(unknown);
        }

        private static string HandleDiscover(JavaScriptSerializer ser)
        {
            List<SaveSlotInfo> slots = SaveStore.DiscoverSaves();
            List<object> list = new List<object>();
            if (slots != null)
            {
                for (int i = 0; i < slots.Count; i++)
                {
                    SaveSlotInfo info = slots[i];
                    if (info == null)
                    {
                        continue;
                    }
                    Dictionary<string, object> m = new Dictionary<string, object>();
                    m["path"] = info.Path;
                    m["name"] = info.Name;
                    m["isAuto"] = info.IsAuto;
                    m["hasHeader"] = info.HasHeader;
                    m["size"] = info.Size;
                    m["modifiedUtc"] = info.ModifiedUtc;
                    m["sha256"] = info.Sha256;
                    list.Add(m);
                }
            }

            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["type"] = "slots";
            reply["slots"] = list;
            return ser.Serialize(reply);
        }

        private static string HandleLoad(JavaScriptSerializer ser, Dictionary<string, object> req)
        {
            string path = GetString(req, "path");
            if (string.IsNullOrEmpty(path))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Missing path";
                return ser.Serialize(err);
            }

            SavePairResult pair = SaveStore.ReadSavePair(path);
            if (pair == null)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Save pair not found";
                return ser.Serialize(err);
            }

            string jsonB64 = ToBase64(pair.JsonBytes);
            string headerB64 = ToBase64(pair.HeaderBytes);

            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["type"] = "loaded";
            reply["path"] = path;
            reply["jsonBase64"] = jsonB64;
            reply["headerBase64"] = headerB64;
            reply["sha256"] = pair.Sha256;
            reply["companionPath"] = pair.CompanionPath;
            return ser.Serialize(reply);
        }

        private static string HandleSave(JavaScriptSerializer ser, Dictionary<string, object> req)
        {
            string path = GetString(req, "path");
            string jsonB64 = GetString(req, "jsonBase64");
            string headerB64 = GetString(req, "headerBase64");
            string expectedSha = GetString(req, "expectedSha256");
            if (expectedSha == null)
            {
                expectedSha = GetString(req, "sha256");
            }

            if (string.IsNullOrEmpty(path))
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Missing path";
                return ser.Serialize(err);
            }
            if (jsonB64 == null)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["type"] = "error";
                err["message"] = "Missing jsonBase64";
                return ser.Serialize(err);
            }

            byte[] jsonBytes = Convert.FromBase64String(jsonB64);
            byte[] headerBytes = null;
            if (!string.IsNullOrEmpty(headerB64))
            {
                headerBytes = Convert.FromBase64String(headerB64);
            }

            SaveResult result = SaveStore.SaveWithBackup(path, jsonBytes, headerBytes, expectedSha);

            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["type"] = "saved";
            reply["path"] = path;
            if (result != null)
            {
                reply["sha256"] = result.NewSha256;
                reply["backupPath"] = result.BackupPath;
                reply["companionBackupPath"] = result.CompanionBackupPath;
                reply["success"] = result.Success;
            }
            else
            {
                reply["sha256"] = null;
                reply["backupPath"] = null;
            }
            return ser.Serialize(reply);
        }

        private static string ToBase64(byte[] data)
        {
            if (data == null)
            {
                return "";
            }
            return Convert.ToBase64String(data);
        }

        private static string GetString(Dictionary<string, object> map, string key)
        {
            if (map == null)
            {
                return null;
            }
            object v;
            if (!map.TryGetValue(key, out v))
            {
                return null;
            }
            if (v == null)
            {
                return null;
            }
            return v as string;
        }
    }

    internal static class SelfTestRunner
    {
        public static bool Run(string outDir, string seedSavePath)
        {
            if (string.IsNullOrEmpty(outDir))
            {
                return false;
            }

            try
            {
                Directory.CreateDirectory(outDir);
            }
            catch
            {
            }

            SelfTestForm form = null;
            ManualResetEventSlim done = new ManualResetEventSlim(false);
            Exception failure = null;
            bool success = false;
            Dictionary<string, object> receipt = null;

            Thread sta = new Thread(delegate()
            {
                try
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);

                    form = new SelfTestForm(outDir, seedSavePath);
                    form.TestFinished += delegate(object s, SelfTestFinishedEventArgs e)
                    {
                        try
                        {
                            if (e.Error != null)
                            {
                                failure = e.Error;
                            }
                            else
                            {
                                success = e.Success;
                                receipt = e.Receipt;
                            }
                        }
                        finally
                        {
                            done.Set();
                            try
                            {
                                if (form != null && form.IsHandleCreated)
                                {
                                    form.BeginInvoke(new Action(delegate() { form.Close(); }));
                                }
                            }
                            catch
                            {
                            }
                        }
                    };

                    Application.Run(form);
                }
                catch (Exception ex)
                {
                    failure = ex;
                    done.Set();
                }
            });
            sta.SetApartmentState(ApartmentState.STA);
            sta.IsBackground = true;
            sta.Start();

            bool completed = done.Wait(TimeSpan.FromSeconds(120));
            if (!completed)
            {
                failure = new TimeoutException("Self-test timed out.");
            }

            try
            {
                if (form != null && form.IsHandleCreated)
                {
                    form.BeginInvoke(new Action(delegate() { form.Close(); }));
                }
            }
            catch
            {
            }

            try
            {
                sta.Join(TimeSpan.FromSeconds(10));
            }
            catch
            {
            }

            Dictionary<string, object> finalReceipt = receipt;
            if (finalReceipt == null)
            {
                finalReceipt = new Dictionary<string, object>();
            }

            bool ok = success && (failure == null);
            if (failure != null)
            {
                finalReceipt["ok"] = false;
                finalReceipt["error"] = failure.Message;
            }
            else
            {
                finalReceipt["ok"] = ok;
            }

            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = int.MaxValue;
                string text = ser.Serialize(finalReceipt);
                File.WriteAllText(Path.Combine(outDir, "receipt.json"), text, new UTF8Encoding(false));
            }
            catch
            {
            }

            return ok;
        }
    }

    internal sealed class SelfTestFinishedEventArgs : EventArgs
    {
        public bool Success;
        public Dictionary<string, object> Receipt;
        public Exception Error;
    }

    internal sealed class SelfTestForm : Form
    {
        private readonly string _outDir;
        private readonly string _seedSavePath;
        private WebView2 _webView;
        private bool _started;
        private bool _finished;
        private int _hanziCount;
        private bool _moneyOk;
        private bool _backupExists;
        private bool _validateOk;
        private string _savedPath;
        private string _backupPath;
        private string _seedUsed;
        private string _webViewVersion;

        public event EventHandler<SelfTestFinishedEventArgs> TestFinished;

        public SelfTestForm(string outDir, string seedSavePath)
        {
            _outDir = outDir;
            _seedSavePath = seedSavePath;

            Text = Program.AppTitle + " (self-test)";
            Width = 1024;
            Height = 720;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            WindowState = FormWindowState.Minimized;
            Opacity = 0.0;
            Location = new Point(-32000, -32000);

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            Load += OnLoadHandler;
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        private async void OnLoadHandler(object sender, EventArgs e)
        {
            try
            {
                CoreWebView2 core = await Program.InitializeWebViewCoreAsync(_webView, null, OnNavigationCompleted);
                if (core == null)
                {
                    FinishWithError(new InvalidOperationException("WebView2 core not available in self-test."));
                    return;
                }
                try { _webViewVersion = core.Environment.BrowserVersionString; } catch { _webViewVersion = ""; }
                core.Navigate(Program.StartUrl);
            }
            catch (Exception ex)
            {
                FinishWithError(ex);
            }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (_started)
            {
                return;
            }
            _started = true;

            if (e == null || !e.IsSuccess)
            {
                FinishWithError(new InvalidOperationException("Navigation failed in self-test."));
                return;
            }

            try
            {
                CoreWebView2 core = _webView.CoreWebView2;

                string outSub = Path.Combine(_outDir, "selftest");
                Directory.CreateDirectory(outSub);
                string targetPath = Path.Combine(outSub, "savefile0.json");
                string companionPath = Path.Combine(outSub, "savefile0");

                string initialSha = "";
                if (!string.IsNullOrEmpty(_seedSavePath) && File.Exists(_seedSavePath))
                {
                    _seedUsed = _seedSavePath;
                    SavePairResult seedPair = SaveStore.ReadSavePair(_seedSavePath);
                    File.WriteAllBytes(targetPath, seedPair.JsonBytes);
                    if (seedPair.HeaderBytes != null && seedPair.HeaderBytes.Length > 0)
                    {
                        File.WriteAllBytes(companionPath, seedPair.HeaderBytes);
                    }
                    initialSha = seedPair.Sha256;
                    string jB64 = Convert.ToBase64String(seedPair.JsonBytes);
                    string hB64 = seedPair.HeaderBytes != null ? Convert.ToBase64String(seedPair.HeaderBytes) : "";
                    await EvalAsync(core, "window.Nj2Ui.loadFromBytes('" + EscapeJs(jB64) + "', '" + EscapeJs(hB64) + "', { filename: 'savefile0.json', source: 'selftest' });");
                }
                else
                {
                    _seedUsed = "demo";
                    await EvalAsync(core, "window.Nj2Ui.loadDemo();");
                }

                await Task.Delay(350);

                string bodyTextJson = await EvalAsync(core, "document.body ? (document.body.innerText || '') : ''");
                string bodyText = DecodeJsString(bodyTextJson);
                _hanziCount = CountHanzi(bodyText);
                if (_hanziCount > 0)
                {
                    FinishWithError(new InvalidOperationException("Hanzi detected in rendered UI: " + _hanziCount));
                    return;
                }

                await EvalAsync(core, "(function(){ var s = window.Nj2Ui.getSession(); var r = window.Nj2EditorCore.applyPreset(s, 'rich_start'); if (!r || !r.ok) throw new Error((r && r.error) || 'preset failed'); window.Nj2Ui.refresh(); return true; })()");
                await Task.Delay(200);

                string exportJson = await EvalAsync(core, "window.Nj2Ui.exportBase64()");
                string exportPayloadText = DecodeJsString(exportJson);
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = int.MaxValue;
                Dictionary<string, object> exported = ser.Deserialize<Dictionary<string, object>>(exportPayloadText);
                if (exported == null || !exported.ContainsKey("jsonBase64"))
                {
                    FinishWithError(new InvalidOperationException("exportBase64 failed in self-test."));
                    return;
                }

                string newJsonB64 = exported["jsonBase64"] as string;
                string newHeaderB64 = exported.ContainsKey("headerBase64") ? (exported["headerBase64"] as string) : null;
                byte[] newJsonBytes = Convert.FromBase64String(newJsonB64);
                byte[] newHeaderBytes = !string.IsNullOrEmpty(newHeaderB64) ? Convert.FromBase64String(newHeaderB64) : null;

                if (!File.Exists(targetPath))
                {
                    // Ensure an original seed file exists on disk so SaveWithBackup produces a real backup.
                    byte[] preBytes = newJsonBytes;
                    if (!string.Equals(_seedUsed, "demo", StringComparison.Ordinal) && File.Exists(_seedUsed))
                    {
                        preBytes = File.ReadAllBytes(_seedUsed);
                    }
                    else
                    {
                        string preJson = await EvalAsync(core, "JSON.stringify(window.Nj2Ui.getSession().originalRoot, null, 2)");
                        string preText = DecodeJsString(preJson);
                        if (!string.IsNullOrEmpty(preText))
                        {
                            preBytes = Encoding.UTF8.GetBytes(preText);
                        }
                    }
                    File.WriteAllBytes(targetPath, preBytes);
                    if (newHeaderBytes != null)
                    {
                        File.WriteAllBytes(companionPath, newHeaderBytes);
                    }
                    SavePairResult prePair = SaveStore.ReadSavePair(targetPath);
                    initialSha = prePair.Sha256;
                }

                SaveResult saveRes = SaveStore.SaveWithBackup(targetPath, newJsonBytes, newHeaderBytes, initialSha);
                _savedPath = targetPath;
                _backupPath = saveRes.BackupPath;
                _backupExists = !string.IsNullOrEmpty(_backupPath) && File.Exists(_backupPath);

                byte[] diskBytes = File.ReadAllBytes(targetPath);
                SaveStore.ValidateSaveBytes(diskBytes);
                _validateOk = true;

                string diskText = Encoding.UTF8.GetString(diskBytes);
                Dictionary<string, object> parsedRoot = ser.Deserialize<Dictionary<string, object>>(diskText);
                _moneyOk = CheckPlayerMoney(parsedRoot, 10000000);

                FinishWithSuccess();
            }
            catch (Exception ex)
            {
                FinishWithError(ex);
            }
        }

        private static bool CheckPlayerMoney(Dictionary<string, object> root, int expected)
        {
            if (root == null || !root.ContainsKey("playerentity")) return false;
            Dictionary<string, object> pe = root["playerentity"] as Dictionary<string, object>;
            if (pe == null) return false;
            foreach (KeyValuePair<string, object> kv in pe)
            {
                Dictionary<string, object> player = kv.Value as Dictionary<string, object>;
                if (player == null || !player.ContainsKey("m_valueBase")) continue;
                Dictionary<string, object> vb = player["m_valueBase"] as Dictionary<string, object>;
                if (vb == null || !vb.ContainsKey("68")) continue;
                int val = Convert.ToInt32(vb["68"], System.Globalization.CultureInfo.InvariantCulture);
                if (val == expected) return true;
            }
            return false;
        }

        private async Task<string> EvalAsync(CoreWebView2 core, string script)
        {
            return await core.ExecuteScriptAsync(script);
        }

        private static string DecodeJsString(string jsonResult)
        {
            if (string.IsNullOrEmpty(jsonResult) || jsonResult == "null") return "";
            try
            {
                JavaScriptSerializer ser = new JavaScriptSerializer();
                ser.MaxJsonLength = int.MaxValue;
                return ser.Deserialize<string>(jsonResult) ?? "";
            }
            catch
            {
                return jsonResult;
            }
        }

        private static string EscapeJs(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            return value.Replace("\\", "\\\\").Replace("'", "\\'");
        }

        private static int CountHanzi(string text)
        {
            if (string.IsNullOrEmpty(text)) return 0;
            int count = 0;
            for (int i = 0; i < text.Length; i++)
            {
                int cp = (int)text[i];
                if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF))
                {
                    count++;
                }
            }
            return count;
        }

        private void FinishWithSuccess()
        {
            if (_finished) return;
            _finished = true;

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = true;
            r["webview2Version"] = _webViewVersion ?? "";
            r["seedUsed"] = _seedUsed ?? "";
            r["backupExists"] = _backupExists;
            r["validateSaveBytes"] = _validateOk;
            r["money"] = _moneyOk;
            r["hanziCount"] = _hanziCount;
            r["savedPath"] = _savedPath ?? "";
            r["backupPath"] = _backupPath ?? "";

            SelfTestFinishedEventArgs args = new SelfTestFinishedEventArgs();
            args.Success = _backupExists && _validateOk && _moneyOk && (_hanziCount == 0);
            args.Receipt = r;
            if (!args.Success)
            {
                args.Error = new InvalidOperationException("One or more self-test assertions failed.");
            }
            EventHandler<SelfTestFinishedEventArgs> h = TestFinished;
            if (h != null) h(this, args);
        }

        private void FinishWithError(Exception ex)
        {
            if (_finished) return;
            _finished = true;

            Dictionary<string, object> r = new Dictionary<string, object>();
            r["ok"] = false;
            r["webview2Version"] = _webViewVersion ?? "";
            r["seedUsed"] = _seedUsed ?? "";
            r["backupExists"] = _backupExists;
            r["validateSaveBytes"] = _validateOk;
            r["money"] = _moneyOk;
            r["hanziCount"] = _hanziCount;

            SelfTestFinishedEventArgs args = new SelfTestFinishedEventArgs();
            args.Success = false;
            args.Error = ex;
            args.Receipt = r;
            EventHandler<SelfTestFinishedEventArgs> h = TestFinished;
            if (h != null) h(this, args);
        }
    }
}
