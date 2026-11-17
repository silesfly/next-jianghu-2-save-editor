using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Runtime.InteropServices;

namespace NextJianghu2SaveEditor.Tests
{
    public static class SaveStoreTests
    {
        private static int _passed;
        private static int _failed;
        private static readonly List<string> _failures = new List<string>();

        [DllImport("Kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLinkW(string lpFileName, string lpExistingFileName, IntPtr lpSecurityAttributes);

        public static int Main()
        {
            try
            {
                TestHasInvalidColon();
                TestIsReservedDeviceName();
                TestValidateSaveBytes();
                TestValidateHeaderBytes();
                TestReadSavePairAndSaveWithBackup();
                TestGameRunningBlocksSave();
                TestHardLinkRejection();
            }
            catch (Exception ex)
            {
                Fail("Unexpected test harness exception: " + ex);
            }

            Console.WriteLine("PASS: " + _passed + "/" + (_passed + _failed));
            if (_failed > 0)
            {
                foreach (string failure in _failures)
                {
                    Console.WriteLine("FAIL: " + failure);
                }
                return 1;
            }

            return 0;
        }

        private static void Check(bool condition, string message)
        {
            if (condition)
            {
                _passed++;
            }
            else
            {
                Fail(message);
            }
        }

        private static void Fail(string message)
        {
            _failed++;
            _failures.Add(message);
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try
            {
                action();
                Fail(message + " (no exception was thrown)");
            }
            catch (T)
            {
                _passed++;
            }
            catch (Exception ex)
            {
                Fail(message + " (wrong exception type: " + ex.GetType().FullName + ")");
            }
        }

        private static void TestHasInvalidColon()
        {
            Check(SaveStore.HasInvalidColon("C:\\dir\\save.json:stream"),
                "HasInvalidColon should reject an alternate data stream path.");
            Check(!SaveStore.HasInvalidColon("C:\\dir\\save.json"),
                "HasInvalidColon should accept a normal path.");
        }

        private static void TestIsReservedDeviceName()
        {
            Check(SaveStore.IsReservedDeviceName("C:\\tmp\\CON"),
                "IsReservedDeviceName should reject CON.");
            Check(SaveStore.IsReservedDeviceName("C:\\tmp\\NUL.json"),
                "IsReservedDeviceName should reject NUL.json.");
            Check(SaveStore.IsReservedDeviceName("C:\\tmp\\COM1\\save.json"),
                "IsReservedDeviceName should reject COM1 in a path segment.");
            Check(!SaveStore.IsReservedDeviceName("C:\\tmp\\savefile0.json"),
                "IsReservedDeviceName should accept savefile0.json.");
        }

        private static void TestValidateSaveBytes()
        {
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateSaveBytes(null); },
                "ValidateSaveBytes should reject null bytes.");

            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateSaveBytes(new byte[0]); },
                "ValidateSaveBytes should reject an empty byte array.");

            byte[] invalidUtf8 = new byte[] { 0xFF, 0xFE, 0xFD };
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateSaveBytes(invalidUtf8); },
                "ValidateSaveBytes should reject invalid UTF-8.");

            byte[] emptyObject = Encoding.UTF8.GetBytes("{}");
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateSaveBytes(emptyObject); },
                "ValidateSaveBytes should reject JSON without playerentity.");

            string minimalJson = "{\"playerentity\":{\"1\":{\"m_valueBase\":{\"68\":100}}}}";
            byte[] minimalBytes = Encoding.UTF8.GetBytes(minimalJson);
            try
            {
                SaveStore.ValidateSaveBytes(minimalBytes);
                _passed++;
            }
            catch (Exception ex)
            {
                Fail("ValidateSaveBytes should accept a minimal playerentity save. Exception: " + ex.GetType().FullName);
            }
        }

        private static void TestValidateHeaderBytes()
        {
            byte[] header10 = MakeHeaderBytes(10);
            byte[] header11 = MakeHeaderBytes(11);

            try
            {
                SaveStore.ValidateHeaderBytes(header10);
                _passed++;
            }
            catch (Exception ex)
            {
                Fail("ValidateHeaderBytes should accept a 10-string header. Exception: " + ex.GetType().FullName);
            }

            try
            {
                SaveStore.ValidateHeaderBytes(header11);
                _passed++;
            }
            catch (Exception ex)
            {
                Fail("ValidateHeaderBytes should accept an 11-string header. Exception: " + ex.GetType().FullName);
            }

            byte[] truncated = new byte[header10.Length - 1];
            Array.Copy(header10, truncated, truncated.Length);
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateHeaderBytes(truncated); },
                "ValidateHeaderBytes should reject a truncated header.");

            byte[] header9 = MakeHeaderBytes(9);
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateHeaderBytes(header9); },
                "ValidateHeaderBytes should reject a 9-string header.");

            byte[] header12 = MakeHeaderBytes(12);
            AssertThrows<InvalidDataException>(
                delegate { SaveStore.ValidateHeaderBytes(header12); },
                "ValidateHeaderBytes should reject a 12-string header.");
        }

        private static byte[] MakeHeaderBytes(int stringCount)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                for (int i = 0; i < stringCount; i++)
                {
                    string value = "header_string_" + i.ToString();
                    byte[] utf8 = Encoding.UTF8.GetBytes(value);
                    Write7BitEncodedInt(stream, utf8.Length);
                    stream.Write(utf8, 0, utf8.Length);
                }
                return stream.ToArray();
            }
        }

        private static void Write7BitEncodedInt(Stream stream, int value)
        {
            uint v = (uint)value;
            while (v >= 0x80)
            {
                stream.WriteByte((byte)(v | 0x80));
                v >>= 7;
            }
            stream.WriteByte((byte)v);
        }

        private static void TestReadSavePairAndSaveWithBackup()
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "nj2_save_store_test_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);

            try
            {
                string jsonPath = Path.Combine(tempDir, "savefile0.json");
                string companionPath = Path.Combine(tempDir, "savefile0");

                string originalJson = "{\"playerentity\":{\"1\":{\"m_valueBase\":{\"68\":100}}}}";
                byte[] originalJsonBytes = Encoding.UTF8.GetBytes(originalJson);
                byte[] originalHeaderBytes = MakeHeaderBytes(11);

                File.WriteAllBytes(jsonPath, originalJsonBytes);
                File.WriteAllBytes(companionPath, originalHeaderBytes);

                string originalSha = ComputeSha256Hex(originalJsonBytes);

                SavePairResult pair = SaveStore.ReadSavePair(jsonPath);
                Check(pair != null, "ReadSavePair should return a non-null result.");
                if (pair != null)
                {
                    Check(pair.Sha256 != null && pair.Sha256.Equals(originalSha, StringComparison.OrdinalIgnoreCase),
                        "ReadSavePair Sha256 should match the JSON file hash.");
                    Check(pair.HeaderBytes != null,
                        "ReadSavePair HeaderBytes should not be null.");
                    Check(pair.HeaderBytes != null && ByteArraysEqual(pair.HeaderBytes, originalHeaderBytes),
                        "ReadSavePair HeaderBytes should match the companion file bytes.");
                    Check(pair.JsonBytes != null && ByteArraysEqual(pair.JsonBytes, originalJsonBytes),
                        "ReadSavePair JsonBytes should match the JSON file bytes.");
                    Check(pair.CompanionPath != null &&
                          pair.CompanionPath.Equals(companionPath, StringComparison.OrdinalIgnoreCase),
                        "ReadSavePair CompanionPath should point to the companion file.");
                }

                string updatedJson = "{\"playerentity\":{\"1\":{\"m_valueBase\":{\"68\":200}}}}";
                byte[] updatedJsonBytes = Encoding.UTF8.GetBytes(updatedJson);
                byte[] updatedHeaderBytes = MakeHeaderBytes(10);

                AssertThrows<InvalidDataException>(
                    delegate
                    {
                        SaveStore.SaveWithBackup(jsonPath, updatedJsonBytes, updatedHeaderBytes, new string('0', 64));
                    },
                    "SaveWithBackup should reject an incorrect expectedSha256.");

                SaveResult saveResult = SaveStore.SaveWithBackup(jsonPath, updatedJsonBytes, updatedHeaderBytes, originalSha);
                Check(saveResult != null, "SaveWithBackup should return a non-null result.");
                if (saveResult != null)
                {
                    Check(saveResult.Success, "SaveWithBackup Success should be true.");
                    Check(saveResult.NewSha256 != null &&
                          saveResult.NewSha256.Equals(ComputeSha256Hex(updatedJsonBytes), StringComparison.OrdinalIgnoreCase),
                        "SaveWithBackup NewSha256 should match the updated JSON.");
                    Check(saveResult.BackupPath != null && File.Exists(saveResult.BackupPath),
                        "SaveWithBackup BackupPath should exist.");
                    Check(saveResult.CompanionBackupPath != null && File.Exists(saveResult.CompanionBackupPath),
                        "SaveWithBackup CompanionBackupPath should exist.");

                    if (saveResult.BackupPath != null && File.Exists(saveResult.BackupPath))
                    {
                        Check(ByteArraysEqual(File.ReadAllBytes(saveResult.BackupPath), originalJsonBytes),
                            "SaveWithBackup JSON backup should contain the original JSON bytes.");
                    }

                    if (saveResult.CompanionBackupPath != null && File.Exists(saveResult.CompanionBackupPath))
                    {
                        Check(ByteArraysEqual(File.ReadAllBytes(saveResult.CompanionBackupPath), originalHeaderBytes),
                            "SaveWithBackup companion backup should contain the original header bytes.");
                    }
                }

                Check(File.Exists(jsonPath), "Updated JSON file should exist.");
                Check(File.Exists(companionPath), "Updated companion file should exist.");
                if (File.Exists(jsonPath))
                {
                    Check(ByteArraysEqual(File.ReadAllBytes(jsonPath), updatedJsonBytes),
                        "JSON file should contain the updated bytes.");
                }
                if (File.Exists(companionPath))
                {
                    Check(ByteArraysEqual(File.ReadAllBytes(companionPath), updatedHeaderBytes),
                        "Companion file should contain the updated header bytes.");
                }

                string[] jsonBackups = Directory.GetFiles(tempDir, "savefile0.json.backup-*.bak");
                string[] companionBackups = Directory.GetFiles(tempDir, "savefile0.backup-*.bak");
                Check(jsonBackups.Length > 0, "A .backup-*.bak file should exist for the JSON save.");
                Check(companionBackups.Length > 0, "A .backup-*.bak file should exist for the companion header.");
            }
            finally
            {
                TryDeleteDirectory(tempDir);
            }
        }

        private static void TestGameRunningBlocksSave()
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "nj2_save_game_running_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);

            try
            {
                string jsonPath = Path.Combine(tempDir, "savefile0.json");
                string companionPath = Path.Combine(tempDir, "savefile0");
                string json = "{\"playerentity\":{\"1\":{\"m_valueBase\":{\"68\":100}}}}";
                byte[] jsonBytes = Encoding.UTF8.GetBytes(json);
                byte[] headerBytes = MakeHeaderBytes(11);
                File.WriteAllBytes(jsonPath, jsonBytes);
                File.WriteAllBytes(companionPath, headerBytes);

                string expectedSha = ComputeSha256Hex(jsonBytes);

                Environment.SetEnvironmentVariable("NJ2_SIMULATE_GAME_RUNNING", "1");
                try
                {
                    Check(SaveStore.IsGameRunning(), "IsGameRunning should return true when NJ2_SIMULATE_GAME_RUNNING is 1.");

                    AssertThrows<IOException>(
                        delegate
                        {
                            SaveStore.SaveWithBackup(jsonPath, jsonBytes, headerBytes, expectedSha);
                        },
                        "SaveWithBackup should throw IOException when the game is running.");
                }
                finally
                {
                    Environment.SetEnvironmentVariable("NJ2_SIMULATE_GAME_RUNNING", null);
                }

                Check(!SaveStore.IsGameRunning(), "IsGameRunning should return false after clearing NJ2_SIMULATE_GAME_RUNNING.");
            }
            finally
            {
                Environment.SetEnvironmentVariable("NJ2_SIMULATE_GAME_RUNNING", null);
                TryDeleteDirectory(tempDir);
            }
        }

        private static void TestHardLinkRejection()
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "nj2_save_hardlink_" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);

            try
            {
                string originalPath = Path.Combine(tempDir, "original.json");
                string linkPath = Path.Combine(tempDir, "link.json");
                File.WriteAllText(originalPath, "{\"playerentity\":{\"1\":{\"m_valueBase\":{\"68\":100}}}}");

                bool created = CreateHardLinkW(linkPath, originalPath, IntPtr.Zero);
                if (!created)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 1 || error == 5 || error == 50)
                    {
                        _passed++;
                        return;
                    }

                    Fail("CreateHardLinkW failed with Win32 error " + error.ToString() + ".");
                    return;
                }

                Check(File.Exists(linkPath), "Hard link file should exist.");

                AssertThrows<InvalidDataException>(
                    delegate { SaveStore.NoLinks(linkPath); },
                    "NoLinks should reject a hard-linked file.");
            }
            finally
            {
                TryDeleteDirectory(tempDir);
            }
        }

        private static string ComputeSha256Hex(byte[] bytes)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(bytes);
                StringBuilder builder = new StringBuilder(hash.Length * 2);
                for (int i = 0; i < hash.Length; i++)
                {
                    builder.Append(hash[i].ToString("x2"));
                }
                return builder.ToString();
            }
        }

        private static bool ByteArraysEqual(byte[] a, byte[] b)
        {
            if (a == null || b == null)
            {
                return a == b;
            }
            if (a.Length != b.Length)
            {
                return false;
            }
            for (int i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i])
                {
                    return false;
                }
            }
            return true;
        }

        private static void TryDeleteDirectory(string path)
        {
            try
            {
                if (path != null && Directory.Exists(path))
                {
                    Directory.Delete(path, true);
                }
            }
            catch
            {
                // Best-effort cleanup only.
            }
        }
    }
}
