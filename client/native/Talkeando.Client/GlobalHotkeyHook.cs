using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Tupi.Client;

/// <summary>
/// Low-level global Windows hook for background Push-to-Talk (PTT) and Toggle Mute.
/// Works across games, browser, and background apps without requiring window focus.
/// </summary>
public sealed class GlobalHotkeyHook : IDisposable
{
    public event Action<string, bool>? KeyEvent;

    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;

    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP = 0x0208;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WM_XBUTTONUP = 0x020C;

    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    private readonly LowLevelProc _keyboardProc;
    private readonly LowLevelProc _mouseProc;
    private IntPtr _keyboardHook = IntPtr.Zero;
    private IntPtr _mouseHook = IntPtr.Zero;
    private readonly HashSet<int> _pressedKeys = new();
    private bool _disposed;

    public GlobalHotkeyHook()
    {
        _keyboardProc = KeyboardHookCallback;
        _mouseProc = MouseHookCallback;
        InstallHooks();
    }

    private void InstallHooks()
    {
        using var curProcess = Process.GetCurrentProcess();
        using var curModule = curProcess.MainModule;
        var hModule = curModule != null && !string.IsNullOrEmpty(curModule.ModuleName)
            ? GetModuleHandle(curModule.ModuleName)
            : IntPtr.Zero;
        _keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, hModule, 0);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hModule, 0);
    }

    private IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var msg = wParam.ToInt32();
            bool isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            bool isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if (isDown || isUp)
            {
                var vkCode = Marshal.ReadInt32(lParam);
                var code = MapVkToDomCode(vkCode);
                var isTransition = isDown ? _pressedKeys.Add(vkCode) : _pressedKeys.Remove(vkCode);
                if (isTransition && !string.IsNullOrEmpty(code))
                {
                    try
                    {
                        KeyEvent?.Invoke(code, isDown);
                    }
                    catch (Exception ex)
                    {
                        DebugLog.Write($"GlobalHotkeyHook exception: {ex}");
                    }
                }
            }
        }
        return CallNextHookEx(_keyboardHook, nCode, wParam, lParam);
    }

    private IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var msg = wParam.ToInt32();
            if (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP)
            {
                var mouseData = Marshal.ReadInt32(lParam, 8); // mouseData is at offset 8 in MSLLHOOKSTRUCT
                var xButton = (mouseData >> 16) & 0xFFFF;
                var code = xButton == 1 ? "Mouse4" : (xButton == 2 ? "Mouse5" : null);
                if (code != null)
                {
                    KeyEvent?.Invoke(code, msg == WM_XBUTTONDOWN);
                }
            }
            else if (msg == WM_MBUTTONDOWN || msg == WM_MBUTTONUP)
            {
                KeyEvent?.Invoke("Mouse3", msg == WM_MBUTTONDOWN);
            }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    public static string MapVkToDomCode(int vk)
    {
        if (vk >= 0x41 && vk <= 0x5A) // A-Z
            return $"Key{(char)vk}";
        if (vk >= 0x30 && vk <= 0x39) // 0-9
            return $"Digit{(char)vk}";
        if (vk >= 0x70 && vk <= 0x87) // F1-F24
            return $"F{vk - 0x70 + 1}";
        if (vk >= 0x60 && vk <= 0x69) // NumPad 0-9
            return $"Numpad{vk - 0x60}";

        return vk switch
        {
            0x20 => "Space",
            0x14 => "CapsLock",
            0x09 => "Tab",
            0x0D => "Enter",
            0x1B => "Escape",
            0x08 => "Backspace",
            0x10 or 0xA0 => "ShiftLeft",
            0xA1 => "ShiftRight",
            0x11 or 0xA2 => "ControlLeft",
            0xA3 => "ControlRight",
            0x12 or 0xA4 => "AltLeft",
            0xA5 => "AltRight",
            0x2D => "Insert",
            0x2E => "Delete",
            0x24 => "Home",
            0x23 => "End",
            0x21 => "PageUp",
            0x22 => "PageDown",
            0x25 => "ArrowLeft",
            0x26 => "ArrowUp",
            0x27 => "ArrowRight",
            0x28 => "ArrowDown",
            0xC0 => "Backquote",
            0xBD => "Minus",
            0xBB => "Equal",
            0xDB => "BracketLeft",
            0xDD => "BracketRight",
            0xDC => "Backslash",
            0xBA => "Semicolon",
            0xDE => "Quote",
            0xBC => "Comma",
            0xBE => "Period",
            0xBF => "Slash",
            _ => $"VK_{vk:X2}"
        };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        if (_keyboardHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_keyboardHook);
            _keyboardHook = IntPtr.Zero;
        }

        if (_mouseHook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);
}
