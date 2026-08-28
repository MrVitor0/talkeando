using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace Tupi.Client;

/// Windows.Graphics.Capture backend. Captures fullscreen-exclusive games and
/// GPU-composited windows that the GDI path renders black, and pulls the
/// cursor natively. Downside: on Windows 10 WGC always draws its own yellow
/// capture border (`IsBorderRequired = false` is Windows 11+ only) — accepted
/// as the trade for game capture.
///
/// Hand-rolled D3D11 interop (no SharpDX/Vortice dependency): the WGC surface
/// is a GPU texture, so each frame is copied to a CPU-readable staging
/// texture and mapped to bytes, then handed to ScreenCapture's shared
/// downscale/hash/JPEG pipeline.
public sealed class WgcCapture : IDisposable
{
    private static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid IDirect3DDxgiInterfaceAccessIid = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");
    private static readonly Guid ID3D11Texture2DIid = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C");
    private static readonly Guid IDXGIDeviceIid = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");

    private const int DXGI_FORMAT_B8G8R8A8_UNORM = 87;
    private const int D3D_DRIVER_TYPE_HARDWARE = 1;
    private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    private const uint D3D11_SDK_VERSION = 7;
    private const uint D3D11_USAGE_STAGING = 3;
    private const uint D3D11_CPU_ACCESS_READ = 0x20000;
    private const uint D3D11_MAP_READ = 1;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(
        IntPtr pAdapter, int driverType, IntPtr software, uint flags,
        IntPtr pFeatureLevels, uint featureLevels, uint sdkVersion,
        out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);

    [DllImport("d3d11.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("combase.dll", PreserveSig = false)]
    private static extern void RoGetActivationFactory(
        [MarshalAs(UnmanagedType.HString)] string activatableClassId,
        [In] ref Guid iid,
        [MarshalAs(UnmanagedType.IInspectable)] out object factory);

    [DllImport("user32.dll")] private static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr result);
        [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr result);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct D3D11_TEXTURE2D_DESC
    {
        public uint Width, Height, MipLevels, ArraySize, Format;
        public uint SampleCount, SampleQuality;
        public uint Usage, BindFlags, CPUAccessFlags, MiscFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct D3D11_MAPPED_SUBRESOURCE { public IntPtr pData; public uint RowPitch; public uint DepthPitch; }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CreateTexture2DFn(IntPtr self, ref D3D11_TEXTURE2D_DESC desc, IntPtr initData, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int MapFn(IntPtr self, IntPtr resource, uint sub, uint mapType, uint mapFlags, out D3D11_MAPPED_SUBRESOURCE mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void UnmapFn(IntPtr self, IntPtr resource, uint sub);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void CopyResourceFn(IntPtr self, IntPtr dst, IntPtr src);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetInterfaceFn(IntPtr self, ref Guid iid, out IntPtr obj);

    private static T VTable<T>(IntPtr comObj, int slot) where T : Delegate
    {
        var vtbl = Marshal.ReadIntPtr(comObj);
        return Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size));
    }

    // ---- state -------------------------------------------------------------
    private IntPtr _devicePtr, _contextPtr;
    private IDirect3DDevice? _rtDevice;
    private GraphicsCaptureItem? _item;
    private Direct3D11CaptureFramePool? _framePool;
    private GraphicsCaptureSession? _session;
    private IntPtr _stagingTex;
    private int _stagingW, _stagingH;

    private CreateTexture2DFn? _createTex;
    private MapFn? _map;
    private UnmapFn? _unmap;
    private CopyResourceFn? _copy;

    private Action<Bitmap>? _onBitmap;
    private int _minIntervalMs;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private long _lastEmitMs = long.MinValue;
    private volatile bool _running;
    private int _processing;
    private bool _loggedFirst;

    /// Returns false (and cleans up) if this source can't be captured with
    /// WGC — the caller should then fall back to the GDI path.
    public bool TryStart(string sourceId, int fps, Action<Bitmap> onBitmap)
    {
        _onBitmap = onBitmap;
        _minIntervalMs = Math.Max(1, 1000 / Math.Clamp(fps, 5, 60));
        try
        {
            if (!GraphicsCaptureSession.IsSupported()) { DebugLog.Write("WGC: not supported on this OS"); return false; }

            var item = CreateItem(sourceId);
            if (item is null) { DebugLog.Write($"WGC: no capture item for '{sourceId}'"); return false; }
            _item = item;

            D3D11CreateDevice(IntPtr.Zero, D3D_DRIVER_TYPE_HARDWARE, IntPtr.Zero, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                IntPtr.Zero, 0, D3D11_SDK_VERSION, out _devicePtr, out _, out _contextPtr);
            if (_devicePtr == IntPtr.Zero) { DebugLog.Write("WGC: D3D11CreateDevice failed"); return false; }

            _createTex = VTable<CreateTexture2DFn>(_devicePtr, 5);
            _map = VTable<MapFn>(_contextPtr, 14);
            _unmap = VTable<UnmapFn>(_contextPtr, 15);
            _copy = VTable<CopyResourceFn>(_contextPtr, 47);

            Guid dxgiIid = IDXGIDeviceIid;
            Marshal.QueryInterface(_devicePtr, ref dxgiIid, out var dxgiDevice);
            CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out var inspectable);
            Marshal.Release(dxgiDevice);
            _rtDevice = MarshalInspectable<IDirect3DDevice>.FromAbi(inspectable);
            Marshal.Release(inspectable);

            var size = item.Size;
            if (size.Width <= 0 || size.Height <= 0) size = new SizeInt32 { Width = 1920, Height = 1080 };
            _framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                _rtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
            _framePool.FrameArrived += OnFrameArrived;

            _session = _framePool.CreateCaptureSession(item);
            try { _session.IsCursorCaptureEnabled = true; } catch { /* older builds */ }
            TrySetBorderless(_session);
            item.Closed += (_, _) => _running = false;

            _running = true;
            _session.StartCapture();
            DebugLog.Write($"WGC: started for '{sourceId}' ({size.Width}x{size.Height})");
            return true;
        }
        catch (Exception ex)
        {
            DebugLog.Write($"WGC: TryStart failed: {ex}");
            Cleanup();
            return false;
        }
    }

    private static void TrySetBorderless(GraphicsCaptureSession session)
    {
        // IsBorderRequired only exists on Windows 11 (build 22000+).
        try
        {
            var prop = session.GetType().GetProperty("IsBorderRequired");
            prop?.SetValue(session, false);
        }
        catch { /* Windows 10: the yellow border stays */ }
    }

    public bool IsRunning => _running;

    private GraphicsCaptureItem? CreateItem(string sourceId)
    {
        Guid interopIid = typeof(IGraphicsCaptureItemInterop).GUID;
        RoGetActivationFactory("Windows.Graphics.Capture.GraphicsCaptureItem", ref interopIid, out object factory);
        var interop = (IGraphicsCaptureItemInterop)factory;
        Guid itemIid = GraphicsCaptureItemIid;

        if (sourceId.StartsWith("window:") && long.TryParse(sourceId.Substring("window:".Length), out var h))
        {
            if (interop.CreateForWindow(new IntPtr(h), ref itemIid, out var ptr) != 0 || ptr == IntPtr.Zero) return null;
            var item = GraphicsCaptureItem.FromAbi(ptr);
            Marshal.Release(ptr);
            return item;
        }
        if (sourceId.StartsWith("screen:"))
        {
            var which = sourceId.Substring("screen:".Length);
            if (which == "all") return null; // virtual desktop — GDI handles this
            if (!int.TryParse(which, out var idx)) return null;
            var screens = System.Windows.Forms.Screen.AllScreens;
            if (idx < 0 || idx >= screens.Length) return null;
            var b = screens[idx].Bounds;
            var hMon = MonitorFromPoint(new POINT(b.X + b.Width / 2, b.Y + b.Height / 2), MONITOR_DEFAULTTONEAREST);
            if (hMon == IntPtr.Zero) return null;
            if (interop.CreateForMonitor(hMon, ref itemIid, out var ptr) != 0 || ptr == IntPtr.Zero) return null;
            var item = GraphicsCaptureItem.FromAbi(ptr);
            Marshal.Release(ptr);
            return item;
        }
        return null;
    }

    private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
    {
        if (!_running) return;
        var nowMs = _clock.ElapsedMilliseconds;
        if (nowMs - _lastEmitMs < _minIntervalMs) { using var drop = sender.TryGetNextFrame(); return; }
        if (Interlocked.Exchange(ref _processing, 1) == 1) { using var drop = sender.TryGetNextFrame(); return; }
        try
        {
            using var frame = sender.TryGetNextFrame();
            if (frame is null) return;
            _lastEmitMs = nowMs;

            var size = frame.ContentSize;
            if (size.Width <= 0 || size.Height <= 0) return;

            if (size.Width != _stagingW || size.Height != _stagingH)
            {
                sender.Recreate(_rtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                RecreateStaging(size.Width, size.Height);
            }

            var surfaceAbi = MarshalInspectable<IDirect3DSurface>.FromManaged(frame.Surface);
            Guid accessIid = IDirect3DDxgiInterfaceAccessIid;
            Marshal.QueryInterface(surfaceAbi, ref accessIid, out var accessPtr);
            var getInterface = VTable<GetInterfaceFn>(accessPtr, 3);
            Guid texIid = ID3D11Texture2DIid;
            getInterface(accessPtr, ref texIid, out var frameTex);
            Marshal.Release(accessPtr);
            Marshal.Release(surfaceAbi);

            _copy!(_contextPtr, _stagingTex, frameTex);
            Marshal.Release(frameTex);

            if (_map!(_contextPtr, _stagingTex, 0, D3D11_MAP_READ, 0, out var mapped) != 0) return;
            try
            {
                using var bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
                var bd = bmp.LockBits(new Rectangle(0, 0, size.Width, size.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                var rowBytes = size.Width * 4;
                unsafe
                {
                    for (var y = 0; y < size.Height; y++)
                    {
                        Buffer.MemoryCopy(
                            (byte*)mapped.pData + (long)y * mapped.RowPitch,
                            (byte*)bd.Scan0 + (long)y * bd.Stride,
                            rowBytes, rowBytes);
                    }
                }
                bmp.UnlockBits(bd);
                if (!_loggedFirst) { DebugLog.Write($"WGC: first frame {size.Width}x{size.Height}"); _loggedFirst = true; }
                _onBitmap?.Invoke(bmp);
            }
            finally { _unmap!(_contextPtr, _stagingTex, 0); }
        }
        catch (Exception ex)
        {
            if (!_loggedFirst) { DebugLog.Write($"WGC: frame failed: {ex}"); _loggedFirst = true; }
        }
        finally { Interlocked.Exchange(ref _processing, 0); }
    }

    private void RecreateStaging(int w, int h)
    {
        if (_stagingTex != IntPtr.Zero) { Marshal.Release(_stagingTex); _stagingTex = IntPtr.Zero; }
        var desc = new D3D11_TEXTURE2D_DESC
        {
            Width = (uint)w, Height = (uint)h, MipLevels = 1, ArraySize = 1,
            Format = DXGI_FORMAT_B8G8R8A8_UNORM, SampleCount = 1, SampleQuality = 0,
            Usage = D3D11_USAGE_STAGING, BindFlags = 0, CPUAccessFlags = D3D11_CPU_ACCESS_READ, MiscFlags = 0,
        };
        _createTex!(_devicePtr, ref desc, IntPtr.Zero, out _stagingTex);
        _stagingW = w; _stagingH = h;
    }

    public void Stop()
    {
        _running = false;
        Cleanup();
    }

    private void Cleanup()
    {
        try { _session?.Dispose(); } catch { }
        try { if (_framePool != null) _framePool.FrameArrived -= OnFrameArrived; _framePool?.Dispose(); } catch { }
        _session = null;
        _framePool = null;
        _item = null;
        if (_stagingTex != IntPtr.Zero) { Marshal.Release(_stagingTex); _stagingTex = IntPtr.Zero; }
        _stagingW = _stagingH = 0;
        if (_contextPtr != IntPtr.Zero) { Marshal.Release(_contextPtr); _contextPtr = IntPtr.Zero; }
        if (_devicePtr != IntPtr.Zero) { Marshal.Release(_devicePtr); _devicePtr = IntPtr.Zero; }
        _rtDevice = null;
        _loggedFirst = false;
    }

    public void Dispose() => Stop();
}
