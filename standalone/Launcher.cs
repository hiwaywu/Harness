// DSH-NoPolicy standalone launcher.
//
// One exe = this stub + an appended zip of dist\dsh-nopolicy + a trailer:
//   [stub][zip bytes][build id: 64 ascii bytes][zip length: int64 LE][magic "DSHNP001"]
//
// Behaviour:
//   * Installs to a FIXED folder (%LOCALAPPDATA%\Programs\DSH-NoPolicy, or DSH_NOPOLICY_TARGET),
//     so DSH_HOME (<install>\home) and Electron userData (<install>\userdata) never move, no matter
//     where this exe is run from or moved to.
//   * If <install>\.build-id equals this exe's build id, it only launches the app: no re-extract.
//   * Otherwise (first run / upgrade): stops copies running from <install>, deletes
//     <install>\resources, extracts every app file (overwrite), then seeds home\ from seed\:
//       - always overwrite: prompts\anchor.md, anchor-plugin.md, plugin-en.md, plugin-zh.md
//       - everything else : only created when absent (default.md, prompt-active.txt,
//         anchor-active.txt, prompt-map.json, sessions, storages, .credentials.yaml ... are
//         never overwritten)
//     then writes the desktop shortcut (pointing at the installed app) and .build-id, and launches.
//
// Archive bytes are written to disk exactly as stored (deflate is lossless); app.asar and
// app.asar.unpacked are never re-encoded.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DeepSeek Harness (No Policy)")]
[assembly: System.Reflection.AssemblyProduct("DeepSeek Harness (No Policy)")]

static class Launcher
{
    const string Magic = "DSHNP001";
    const string AppExe = "DeepSeek Harness.exe";
    const string ShortcutName = "DeepSeek Harness (No Policy).lnk";
    static readonly HashSet<string> AlwaysOverwrite = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "prompts/anchor.md", "prompts/anchor-plugin.md", "prompts/plugin-en.md", "prompts/plugin-zh.md"
    };
    // Belt and braces: these are also protected by the "only when absent" default.
    static readonly string[] NeverOverwritePrefixes = {
        "sessions/", "storages/", ".credentials.yaml", "prompt-active.txt", "anchor-active.txt", "prompt-map.json"
    };

    static string Target()
    {
        string t = (Environment.GetEnvironmentVariable("DSH_NOPOLICY_TARGET") ?? "").Trim();
        if (t.Length == 0)
            t = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "DSH-NoPolicy");
        return Path.GetFullPath(t);
    }

    [STAThread]
    static int Main(string[] args)
    {
        bool quiet = Array.IndexOf(args, "--install-only") >= 0;
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string target = Target();
        string buildId;
        long zipStart, zipLen;
        try { ReadTrailer(self, out buildId, out zipStart, out zipLen); }
        catch (Exception e) { return Fail("This exe is damaged (no payload): " + e.Message, quiet); }

        string idFile = Path.Combine(target, ".build-id");
        string app = Path.Combine(target, AppExe);
        bool current = File.Exists(app) && File.Exists(Path.Combine(target, "resources", "app.asar"))
            && File.Exists(idFile) && File.ReadAllText(idFile).Trim() == buildId;

        if (!current)
        {
            Exception error = null;
            if (quiet) { try { Install(self, target, buildId, zipStart, zipLen, null); } catch (Exception e) { error = e; } }
            else error = InstallWithProgress(self, target, buildId, zipStart, zipLen);
            if (error != null) return Fail("Install failed: " + error.Message, quiet);
        }
        try { WriteShortcut(target); } catch { }
        if (quiet) return 0;
        var psi = new ProcessStartInfo(app) { WorkingDirectory = target, UseShellExecute = false };
        Process.Start(psi);
        return 0;
    }

    static int Fail(string msg, bool quiet)
    {
        if (quiet) Console.Error.WriteLine(msg);
        else MessageBox.Show(msg, "DeepSeek Harness (No Policy)", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }

    static void ReadTrailer(string self, out string buildId, out long zipStart, out long zipLen)
    {
        using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            var t = new byte[80];
            fs.Seek(-80, SeekOrigin.End);
            ReadFully(fs, t, 0, 80);
            if (Encoding.ASCII.GetString(t, 72, 8) != Magic) throw new InvalidDataException("magic mismatch");
            buildId = Encoding.ASCII.GetString(t, 0, 64).Trim();
            zipLen = BitConverter.ToInt64(t, 64);
            zipStart = fs.Length - 80 - zipLen;
            if (zipStart <= 0) throw new InvalidDataException("bad payload length");
        }
    }

    static void ReadFully(Stream s, byte[] b, int off, int n)
    {
        while (n > 0) { int r = s.Read(b, off, n); if (r <= 0) throw new EndOfStreamException(); off += r; n -= r; }
    }

    static Exception InstallWithProgress(string self, string target, string buildId, long zipStart, long zipLen)
    {
        Application.EnableVisualStyles();
        var form = new Form {
            Text = "DeepSeek Harness (No Policy)", Width = 460, Height = 140, FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, StartPosition = FormStartPosition.CenterScreen, ControlBox = false
        };
        try { form.Icon = Icon.ExtractAssociatedIcon(self); } catch { }
        var label = new Label { Left = 16, Top = 14, Width = 410, Text = "Installing / updating ..." };
        var bar = new ProgressBar { Left = 16, Top = 44, Width = 410, Height = 22, Maximum = 1000 };
        form.Controls.Add(label); form.Controls.Add(bar);
        Exception error = null;
        form.Shown += delegate {
            var th = new Thread(delegate () {
                try {
                    Install(self, target, buildId, zipStart, zipLen, delegate (string text, double frac) {
                        try { form.BeginInvoke((MethodInvoker)delegate { label.Text = text; bar.Value = Math.Max(0, Math.Min(1000, (int)(frac * 1000))); }); } catch { }
                    });
                } catch (Exception e) { error = e; }
                try { form.BeginInvoke((MethodInvoker)delegate { form.Close(); }); } catch { }
            });
            th.IsBackground = true;
            th.Start();
        };
        Application.Run(form);
        return error;
    }

    static void Install(string self, string target, string buildId, long zipStart, long zipLen, Action<string, double> progress)
    {
        if (progress == null) progress = delegate { };
        progress("Closing running copy ...", 0);
        StopRunning(target);

        Directory.CreateDirectory(target);
        string idFile = Path.Combine(target, ".build-id");
        if (File.Exists(idFile)) File.Delete(idFile);   // an interrupted upgrade reruns next time
        string res = Path.Combine(target, "resources");
        progress("Removing old app files ...", 0);
        for (int i = 0; Directory.Exists(res); i++)
        {
            try { Directory.Delete(res, true); }
            catch { if (i >= 20) throw; Thread.Sleep(500); }
        }
        // leftovers from the WinRAR-SFX installer
        foreach (var junk in new[] { "presetup.cmd", "setup.cmd" })
            try { File.Delete(Path.Combine(target, junk)); } catch { }

        string home = Path.Combine(target, "home");
        using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var sub = new SubStream(fs, zipStart, zipLen))
        using (var zip = new ZipArchive(sub, ZipArchiveMode.Read))
        {
            long total = 0, done = 0;
            foreach (var e in zip.Entries) total += e.Length;
            var buf = new byte[1 << 20];
            foreach (var e in zip.Entries)
            {
                string name = e.FullName.Replace('\\', '/');
                if (name.EndsWith("/")) continue;
                if (name.Contains("..")) throw new InvalidDataException("bad entry " + name);
                string dest;
                if (name.StartsWith("seed/", StringComparison.OrdinalIgnoreCase))
                {
                    string rel = name.Substring(5);
                    dest = Path.Combine(home, rel.Replace('/', Path.DirectorySeparatorChar));
                    bool overwrite = AlwaysOverwrite.Contains(rel);
                    if (!overwrite && File.Exists(dest)) { done += e.Length; continue; }
                    if (!overwrite && IsProtected(rel) && File.Exists(dest)) { done += e.Length; continue; }
                }
                else dest = Path.Combine(target, name.Replace('/', Path.DirectorySeparatorChar));

                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                using (var src = e.Open())
                using (var outf = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    int r;
                    while ((r = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        outf.Write(buf, 0, r);
                        done += r;
                    }
                }
                File.SetLastWriteTimeUtc(dest, e.LastWriteTime.UtcDateTime);
                progress("Installing ... " + (done >> 20) + " / " + (total >> 20) + " MB", total > 0 ? (double)done / total : 1);
            }
        }
        File.WriteAllText(idFile, buildId);
        progress("Starting ...", 1);
    }

    static bool IsProtected(string rel)
    {
        foreach (var p in NeverOverwritePrefixes)
            if (rel.Equals(p, StringComparison.OrdinalIgnoreCase) || rel.StartsWith(p, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    static void StopRunning(string target)
    {
        string prefix = target.TrimEnd('\\') + "\\";
        var victims = new List<Process>();
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                string path = p.MainModule.FileName;
                if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) victims.Add(p);
            }
            catch { }
        }
        foreach (var p in victims) { try { p.Kill(); } catch { } }
        foreach (var p in victims) { try { p.WaitForExit(10000); } catch { } }
        if (victims.Count > 0) Thread.Sleep(1000);
    }

    static void WriteShortcut(string target)
    {
        string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), ShortcutName);
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(t);
        dynamic s = shell.CreateShortcut(lnk);
        s.TargetPath = Path.Combine(target, AppExe);
        s.WorkingDirectory = target;
        s.Description = "DeepSeek Harness without the host policy layer";
        s.Save();
    }
}

/// Read-only, seekable window over [start, start+length) of another stream.
sealed class SubStream : Stream
{
    readonly Stream inner; readonly long start, length; long pos;
    public SubStream(Stream inner, long start, long length) { this.inner = inner; this.start = start; this.length = length; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position { get { return pos; } set { pos = value; } }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count)
    {
        long left = length - pos;
        if (left <= 0) return 0;
        if (count > left) count = (int)left;
        inner.Position = start + pos;
        int r = inner.Read(buffer, offset, count);
        pos += r;
        return r;
    }
    public override long Seek(long offset, SeekOrigin origin)
    {
        if (origin == SeekOrigin.Begin) pos = offset;
        else if (origin == SeekOrigin.Current) pos += offset;
        else pos = length + offset;
        return pos;
    }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
