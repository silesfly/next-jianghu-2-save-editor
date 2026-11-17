using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace NextJianghu2SaveEditor
{
    public sealed class SaveSlotInfo
    {
        public string Path { get; set; }
        public string Name { get; set; }
        public bool IsAuto { get; set; }
        public bool HasHeader { get; set; }
        public long Size { get; set; }
        public DateTime ModifiedUtc { get; set; }
        public string Sha256 { get; set; }
    }

    public sealed class SavePairResult
    {
        public byte[] JsonBytes { get; set; }
        public byte[] HeaderBytes { get; set; }
        public string Sha256 { get; set; }
        public string CompanionPath { get; set; }
    }

    public sealed class SaveResult
    {
        public bool Success { get; set; }
        public string BackupPath { get; set; }
        public string CompanionBackupPath { get; set; }
        public string NewSha256 { get; set; }
    }

    public static class SaveStore
    {
        private const string GameFolderName = "\u4e0b\u4e00\u7ad9\u6c5f\u6e56\u2161";
        private const string SimulateRunningVar = "NJ2_SIMULATE_GAME_RUNNING";
        private const string JsonExtension = ".json";

        private const int MaxSaveBytes = 64 * 1024 * 1024;
        private const int MaxHeaderBytes = 1 * 1024 * 1024;

        private const uint FILE_READ_ATTRIBUTES = 0x0080;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
        private const uint VOLUME_NAME_DOS = 0x00000000;

        private static readonly string[] ReservedNames = new string[]
        {
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
        };

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileTime
        {
            public uint Low;
            public uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public NativeFileTime CreationTime;
            public NativeFileTime LastAccessTime;
            public NativeFileTime LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle hFile,
            out ByHandleFileInformation lpFileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle hFile,
            StringBuilder lpszFilePath,
            uint cchFilePath,
            uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileExW(string lpExistingFileName, string lpNewFileName, uint dwFlags);

        // ---------------------------------------------------------------
        // Path safety
        // ---------------------------------------------------------------

        public static bool HasInvalidColon(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }
            for (int i = 0; i < path.Length; i++)
            {
                if (path[i] != ':')
                {
                    continue;
                }
                bool isDriveLetter = (i == 1) && char.IsLetter(path[0]);
                if (!isDriveLetter)
                {
                    return true;
                }
                if (path.Length <= 2 || (path[2] != '\\' && path[2] != '/'))
                {
                    return true;
                }
            }
            return false;
        }

        public static bool IsReservedDeviceName(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }
            char[] separators = new char[] { '\\', '/', ':', '.' };
            string[] parts = path.Split(separators);
            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i];
                if (string.IsNullOrEmpty(part))
                {
                    continue;
                }
                string candidate = part.TrimEnd(' ');
                for (int r = 0; r < ReservedNames.Length; r++)
                {
                    if (string.Equals(candidate, ReservedNames[r], StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }
            }
            return false;
        }

        private static void EnsureSafePath(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                throw new InvalidDataException("Path is empty.");
            }
            if (HasInvalidColon(path))
            {
                throw new InvalidDataException("Path contains an alternate data stream (colon).");
            }
            if (IsReservedDeviceName(path))
            {
                throw new InvalidDataException("Path contains a reserved device name.");
            }
            string full;
            try
            {
                full = Path.GetFullPath(path);
            }
            catch (Exception ex)
            {
                throw new InvalidDataException("Path is not a valid file path.", ex);
            }
            if (!Path.IsPathRooted(full))
            {
                throw new InvalidDataException("Path is not rooted.");
            }
            string root = Path.GetPathRoot(full);
            if (string.IsNullOrEmpty(root) || root.Length < 2 || root[1] != ':')
            {
                throw new InvalidDataException("Only local drive paths are supported (UNC rejected).");
            }
            if (full.IndexOf("...", StringComparison.Ordinal) >= 0)
            {
                // Conservative: reject suspicious component placeholders.
                throw new InvalidDataException("Path contains a suspicious component.");
            }
        }

        private static SafeFileHandle OpenNoFollow(string path, bool directory)
        {
            uint flags = FILE_FLAG_OPEN_REPARSE_POINT;
            if (directory)
            {
                flags |= FILE_FLAG_BACKUP_SEMANTICS;
            }
            SafeFileHandle handle = CreateFileW(
                path,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                flags,
                IntPtr.Zero);
            if (handle == null || handle.IsInvalid)
            {
                int err = Marshal.GetLastWin32Error();
                if (handle != null)
                {
                    handle.Dispose();
                }
                throw new InvalidDataException("Unable to open handle for '" + path + "' (error " + err.ToString(CultureInfo.InvariantCulture) + ").");
            }
            return handle;
        }

        private static void InspectHandle(SafeFileHandle handle, string path, bool rejectHardLinks)
        {
            ByHandleFileInformation info;
            if (!GetFileInformationByHandle(handle, out info))
            {
                throw new InvalidDataException("GetFileInformationByHandle failed for '" + path + "'.");
            }
            if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            {
                throw new InvalidDataException("Reparse point detected at '" + path + "'.");
            }
            if (rejectHardLinks && info.NumberOfLinks > 1)
            {
                throw new InvalidDataException("Multiple hard links detected at '" + path + "'.");
            }

            StringBuilder buffer = new StringBuilder(1024);
            uint written = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VOLUME_NAME_DOS);
            if (written == 0)
            {
                throw new InvalidDataException("GetFinalPathNameByHandleW failed for '" + path + "'.");
            }
            if (written >= buffer.Capacity)
            {
                buffer = new StringBuilder((int)written + 2);
                written = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, VOLUME_NAME_DOS);
                if (written == 0 || written >= buffer.Capacity)
                {
                    throw new InvalidDataException("GetFinalPathNameByHandleW failed for '" + path + "'.");
                }
            }
            string finalPath = buffer.ToString();
            if (finalPath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase) ||
                finalPath.StartsWith("\\\\.\\", StringComparison.Ordinal))
            {
                throw new InvalidDataException("Device or UNC final path rejected: '" + finalPath + "'.");
            }
        }

        private static List<SafeFileHandle> PinAncestorDirectories(string path)
        {
            EnsureSafePath(path);
            string full = Path.GetFullPath(path);
            string root = Path.GetPathRoot(full);
            List<SafeFileHandle> handles = new List<SafeFileHandle>();
            if (string.IsNullOrEmpty(root))
            {
                throw new InvalidDataException("Cannot determine path root.");
            }
            try
            {
                SafeFileHandle rootHandle = OpenNoFollow(root, true);
                handles.Add(rootHandle);
                InspectHandle(rootHandle, root, false);

                string current = root;
                string rest = full.Substring(root.Length);
                char[] sep = new char[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar };
                string[] parts = rest.Split(sep, StringSplitOptions.RemoveEmptyEntries);
                // All but the last component are ancestors; the last is the leaf itself.
                for (int i = 0; i < parts.Length - 1; i++)
                {
                    current = Path.Combine(current, parts[i]);
                    SafeFileHandle handle = OpenNoFollow(current, true);
                    handles.Add(handle);
                    InspectHandle(handle, current, false);
                }
            }
            catch
            {
                for (int i = 0; i < handles.Count; i++)
                {
                    handles[i].Dispose();
                }
                throw;
            }
            return handles;
        }

        public static void NoLinks(string path)
        {
            EnsureSafePath(path);
            string full = Path.GetFullPath(path);
            List<SafeFileHandle> pinned = PinAncestorDirectories(full);
            try
            {
                bool isDirectory = Directory.Exists(full);
                SafeFileHandle leaf = OpenNoFollow(full, isDirectory);
                try
                {
                    InspectHandle(leaf, full, true);
                }
                finally
                {
                    leaf.Dispose();
                }
            }
            finally
            {
                for (int i = 0; i < pinned.Count; i++)
                {
                    pinned[i].Dispose();
                }
            }
        }

        // ---------------------------------------------------------------
        // Validation
        // ---------------------------------------------------------------

        public static void ValidateSaveBytes(byte[] jsonBytes)
        {
            if (jsonBytes == null || jsonBytes.Length < 2)
            {
                throw new InvalidDataException("Save payload is empty.");
            }
            if (jsonBytes.Length > MaxSaveBytes)
            {
                throw new InvalidDataException("Save payload exceeds " + (MaxSaveBytes / (1024 * 1024)).ToString(CultureInfo.InvariantCulture) + " MiB.");
            }

            int offset = 0;
            if (jsonBytes.Length >= 3 &&
                jsonBytes[0] == 0xEF && jsonBytes[1] == 0xBB && jsonBytes[2] == 0xBF)
            {
                offset = 3;
            }

            string text;
            try
            {
                UTF8Encoding strict = new UTF8Encoding(false, true);
                text = strict.GetString(jsonBytes, offset, jsonBytes.Length - offset);
            }
            catch (Exception ex)
            {
                throw new InvalidDataException("Save payload is not valid UTF-8.", ex);
            }

            object parsed;
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = MaxSaveBytes;
                parsed = serializer.DeserializeObject(text);
            }
            catch (Exception ex)
            {
                throw new InvalidDataException("Save payload is not valid JSON.", ex);
            }

            Dictionary<string, object> root = parsed as Dictionary<string, object>;
            if (root == null)
            {
                throw new InvalidDataException("Save payload root is not a JSON object.");
            }
            if (!root.ContainsKey("playerentity"))
            {
                throw new InvalidDataException("Save payload is missing the 'playerentity' member.");
            }
        }

        public static void ValidateHeaderBytes(byte[] headerBytes)
        {
            if (headerBytes == null || headerBytes.Length == 0)
            {
                throw new InvalidDataException("Header payload is empty.");
            }
            if (headerBytes.Length > MaxHeaderBytes)
            {
                throw new InvalidDataException("Header payload exceeds 1 MiB.");
            }

            UTF8Encoding strict = new UTF8Encoding(false, true);
            int pos = 0;
            int count = 0;
            while (pos < headerBytes.Length)
            {
                if (count >= 11)
                {
                    throw new InvalidDataException("Header payload has more than 11 strings.");
                }
                int length = Read7BitEncodedInt(headerBytes, ref pos);
                if (length < 0 || length > MaxHeaderBytes || length > headerBytes.Length - pos)
                {
                    throw new InvalidDataException("Header string length prefix is out of range.");
                }
                try
                {
                    strict.GetString(headerBytes, pos, length);
                }
                catch (Exception ex)
                {
                    throw new InvalidDataException("Header string is not valid UTF-8.", ex);
                }
                pos += length;
                count++;
            }
            if (count != 10 && count != 11)
            {
                throw new InvalidDataException("Header payload must contain 10 or 11 strings.");
            }
        }

        private static int Read7BitEncodedInt(byte[] buffer, ref int pos)
        {
            int result = 0;
            int shift = 0;
            while (true)
            {
                if (pos >= buffer.Length)
                {
                    throw new InvalidDataException("Truncated 7-bit encoded length prefix.");
                }
                byte b = buffer[pos++];
                result |= (int)(b & 0x7F) << shift;
                if ((b & 0x80) == 0)
                {
                    break;
                }
                shift += 7;
                if (shift >= 35)
                {
                    throw new InvalidDataException("Invalid 7-bit encoded length prefix.");
                }
            }
            if (result < 0)
            {
                throw new InvalidDataException("Invalid 7-bit encoded length prefix.");
            }
            return result;
        }

        public static bool IsGameRunning()
        {
            string flag = Environment.GetEnvironmentVariable(SimulateRunningVar);
            if (string.Equals(flag, "1", StringComparison.Ordinal))
            {
                return true;
            }
            try
            {
                Process[] processes = Process.GetProcesses();
                for (int i = 0; i < processes.Length; i++)
                {
                    try
                    {
                        string name = processes[i].ProcessName;
                        if (!string.IsNullOrEmpty(name) &&
                            name.IndexOf(GameFolderName, StringComparison.Ordinal) >= 0)
                        {
                            return true;
                        }
                    }
                    catch (Exception)
                    {
                        // Access denied / exited process; ignore.
                    }
                    finally
                    {
                        processes[i].Dispose();
                    }
                }
            }
            catch (Exception)
            {
                // Process enumeration best effort.
            }
            return false;
        }

        // ---------------------------------------------------------------
        // Discovery
        // ---------------------------------------------------------------

        public static List<SaveSlotInfo> DiscoverSaves()
        {
            List<SaveSlotInfo> results = new List<SaveSlotInfo>();
            List<string> roots = new List<string>();

            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(profile))
            {
                roots.Add(Path.Combine(profile, "AppData", "LocalLow", "inmotiongame", GameFolderName, "Save2"));
            }

            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            if (string.IsNullOrEmpty(programFiles))
            {
                programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            }
            if (!string.IsNullOrEmpty(programFiles))
            {
                string steamCommon = Path.Combine(programFiles, "Steam", "steamapps", "common",
                    GameFolderName, GameFolderName, GameFolderName + "_Data", "Save2");
                roots.Add(steamCommon);
            }

            for (int i = 0; i < roots.Count; i++)
            {
                ScanRoot(roots[i], false, results);
                ScanRoot(Path.Combine(roots[i], "Auto"), true, results);
            }
            return results;
        }

        private static void ScanRoot(string root, bool isAuto, List<SaveSlotInfo> results)
        {
            try
            {
                if (!Directory.Exists(root))
                {
                    return;
                }
                string[] files = Directory.GetFiles(root, "*" + JsonExtension, SearchOption.TopDirectoryOnly);
                for (int i = 0; i < files.Length; i++)
                {
                    try
                    {
                        SaveSlotInfo info = new SaveSlotInfo();
                        info.Path = files[i];
                        info.Name = Path.GetFileNameWithoutExtension(files[i]);
                        info.IsAuto = isAuto;
                        string companion = StripJsonSuffix(files[i]);
                        info.HasHeader = File.Exists(companion);
                        FileInfo fi = new FileInfo(files[i]);
                        info.Size = fi.Length;
                        info.ModifiedUtc = fi.LastWriteTimeUtc;
                        info.Sha256 = TryHashFile(files[i]);
                        results.Add(info);
                    }
                    catch (Exception)
                    {
                        // Skip entries we cannot inspect.
                    }
                }
            }
            catch (Exception)
            {
                // Skip inaccessible roots.
            }
        }

        private static string StripJsonSuffix(string path)
        {
            if (path.EndsWith(JsonExtension, StringComparison.OrdinalIgnoreCase))
            {
                return path.Substring(0, path.Length - JsonExtension.Length);
            }
            return path;
        }

        private static string TryHashFile(string path)
        {
            try
            {
                using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] hash = sha.ComputeHash(fs);
                        return ToHex(hash);
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ---------------------------------------------------------------
        // Read
        // ---------------------------------------------------------------

        public static SavePairResult ReadSavePair(string jsonPath)
        {
            if (string.IsNullOrEmpty(jsonPath))
            {
                throw new InvalidDataException("Save path is empty.");
            }
            NoLinks(jsonPath);

            byte[] jsonBytes = File.ReadAllBytes(jsonPath);
            ValidateSaveBytes(jsonBytes);

            string companion = StripJsonSuffix(jsonPath);
            byte[] headerBytes = null;
            if (File.Exists(companion))
            {
                NoLinks(companion);
                headerBytes = File.ReadAllBytes(companion);
                ValidateHeaderBytes(headerBytes);
            }

            SavePairResult result = new SavePairResult();
            result.JsonBytes = jsonBytes;
            result.HeaderBytes = headerBytes;
            result.CompanionPath = headerBytes != null ? companion : null;
            result.Sha256 = ComputeSha256(jsonBytes);
            return result;
        }

        // ---------------------------------------------------------------
        // Write
        // ---------------------------------------------------------------

        public static SaveResult SaveWithBackup(string jsonPath, byte[] newJsonBytes, byte[] newHeaderBytes, string expectedSha256)
        {
            if (IsGameRunning())
            {
                throw new IOException("The game appears to be running. Close it before saving.");
            }
            if (string.IsNullOrEmpty(jsonPath))
            {
                throw new InvalidDataException("Save path is empty.");
            }
            NoLinks(jsonPath);

            ValidateSaveBytes(newJsonBytes);
            bool writeHeader = newHeaderBytes != null;
            if (writeHeader)
            {
                ValidateHeaderBytes(newHeaderBytes);
            }

            if (!string.IsNullOrEmpty(expectedSha256))
            {
                string actual;
                using (FileStream fs = new FileStream(jsonPath, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    using (SHA256 sha = SHA256.Create())
                    {
                        actual = ToHex(sha.ComputeHash(fs));
                    }
                }
                if (!string.Equals(actual, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("Save file changed on disk (SHA-256 mismatch).");
                }
            }

            string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            string rand = NewRandomToken();
            string pid = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            string suffix = stamp + "-" + pid + "-" + rand;

            string companion = StripJsonSuffix(jsonPath);
            bool hasCompanion = File.Exists(companion);

            List<string> ownPending = new List<string>();
            SaveResult result = new SaveResult();
            try
            {
                result.BackupPath = MakeBackup(jsonPath, suffix);
                if (hasCompanion)
                {
                    result.CompanionBackupPath = MakeBackup(companion, suffix);
                }

                WriteAtomically(jsonPath, newJsonBytes, ownPending);
                if (writeHeader)
                {
                    WriteAtomically(companion, newHeaderBytes, ownPending);
                }

                result.NewSha256 = ComputeSha256(newJsonBytes);
                result.Success = true;
                return result;
            }
            catch (Exception)
            {
                for (int i = 0; i < ownPending.Count; i++)
                {
                    try
                    {
                        if (File.Exists(ownPending[i]))
                        {
                            File.Delete(ownPending[i]);
                        }
                    }
                    catch (Exception)
                    {
                        // Best effort cleanup of our own pending files only.
                    }
                }
                throw;
            }
        }

        private static string MakeBackup(string source, string suffix)
        {
            string backup = source + ".backup-" + suffix + ".bak";
            File.Copy(source, backup, false);
            using (FileStream fs = new FileStream(backup, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete))
            {
                using (SHA256 sha = SHA256.Create())
                {
                    sha.ComputeHash(fs);
                }
            }
            return backup;
        }

        private static void WriteAtomically(string target, byte[] bytes, List<string> ownPending)
        {
            string pending = target + ".pending-" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                + "-" + NewRandomToken();
            ownPending.Add(pending);
            using (FileStream fs = new FileStream(pending, FileMode.CreateNew, FileAccess.Write,
                FileShare.None))
            {
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
            if (!MoveFileExW(pending, target, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            {
                int err = Marshal.GetLastWin32Error();
                throw new IOException("Atomic replace failed (error " + err.ToString(CultureInfo.InvariantCulture) + ").");
            }
        }

        // ---------------------------------------------------------------
        // Utilities
        // ---------------------------------------------------------------

        private static string NewRandomToken()
        {
            byte[] raw = new byte[8];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(raw);
            }
            return ToHex(raw);
        }

        private static string ComputeSha256(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                return ToHex(sha.ComputeHash(bytes));
            }
        }

        private static string ToHex(byte[] bytes)
        {
            if (bytes == null)
            {
                return null;
            }
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++)
            {
                sb.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
            }
            return sb.ToString();
        }
    }
}
