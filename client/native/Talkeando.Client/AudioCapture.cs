using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace Talkeando.Client;

/// WASAPI process-loopback capture (Windows 10 build 19041+ — matches this
/// project's target framework).
///
///  - include mode: capture only the audio rendered by a target process
///    tree ("share this game's sound").
///  - exclude mode: capture everything the system renders EXCEPT a process
///    tree ("share the whole screen, but not our own call audio, so the
///    remote voices don't echo back").
///
/// Emits interleaved signed-16-bit PCM at 48 kHz stereo, one buffer per
/// WASAPI packet (~10 ms).
public sealed class AudioCapture : IDisposable
{
    public const int SampleRate = 48000;
    public const int Channels = 2;
    private const int BytesPerFrame = Channels * 2;

    public const int ModeIncludeTree = 0;
    public const int ModeExcludeTree = 1;

    // ---- interop --------------------------------------------------------
    private const string VirtualLoopbackDevice = "VAD\\Process_Loopback";
    private static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    private const ushort WAVE_FORMAT_PCM = 1;
    private const ushort VT_BLOB = 65;
    private const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateEventW(IntPtr attrs, bool manualReset, bool initialState, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    // Marker — the completion handler must be agile.
    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint numBufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariantBlob
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public int cbSize;
        [FieldOffset(16)] public IntPtr pData;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct WaveFormatEx
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    private sealed class ActivateHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEventSlim Done = new(false);
        public IAudioClient? Client;
        public Exception? Error;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                op.GetActivateResult(out int hr, out object iface);
                if (hr != 0) Error = new COMException("ActivateAudioInterface result", hr);
                else Client = (IAudioClient)iface;
            }
            catch (Exception ex) { Error = ex; }
            finally { Done.Set(); }
        }
    }

    // ---- lifecycle ----------------------------------------------------
    private Thread? _thread;
    private volatile bool _running;
    private IntPtr _sampleEvent;
    private Action<byte[]>? _onPcm;

    public bool IsRunning => _running;

    public void Start(uint targetProcessId, int loopbackMode, Action<byte[]> onPcm)
    {
        Stop();
        _onPcm = onPcm;
        _running = true;
        _thread = new Thread(() => Run(targetProcessId, loopbackMode)) { IsBackground = true, Name = "audio-capture" };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    public void Stop()
    {
        _running = false;
        _thread?.Join(800);
        _thread = null;
        _onPcm = null;
    }

    private void Run(uint targetProcessId, int loopbackMode)
    {
        IntPtr pActivation = IntPtr.Zero, pPropVariant = IntPtr.Zero, pFormat = IntPtr.Zero;
        IAudioClient? client = null;
        IAudioCaptureClient? capture = null;
        try
        {
            var activation = new AudioClientActivationParams
            {
                ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                TargetProcessId = targetProcessId,
                ProcessLoopbackMode = loopbackMode,
            };
            pActivation = Marshal.AllocHGlobal(Marshal.SizeOf<AudioClientActivationParams>());
            Marshal.StructureToPtr(activation, pActivation, false);

            var propVariant = new PropVariantBlob
            {
                vt = VT_BLOB,
                cbSize = Marshal.SizeOf<AudioClientActivationParams>(),
                pData = pActivation,
            };
            pPropVariant = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariantBlob>());
            Marshal.StructureToPtr(propVariant, pPropVariant, false);

            var handler = new ActivateHandler();
            ActivateAudioInterfaceAsync(VirtualLoopbackDevice, IID_IAudioClient, pPropVariant, handler, out _);
            if (!handler.Done.Wait(3000)) throw new TimeoutException("ActivateAudioInterfaceAsync did not complete in 3s");
            if (handler.Error is not null) throw handler.Error;
            client = handler.Client ?? throw new InvalidOperationException("no audio client");

            var format = new WaveFormatEx
            {
                wFormatTag = WAVE_FORMAT_PCM,
                nChannels = Channels,
                nSamplesPerSec = SampleRate,
                wBitsPerSample = 16,
                nBlockAlign = BytesPerFrame,
                nAvgBytesPerSec = SampleRate * BytesPerFrame,
                cbSize = 0,
            };
            pFormat = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());
            Marshal.StructureToPtr(format, pFormat, false);

            const long bufferDuration = 2_000_000; // 200 ms in 100-ns units
            int hr = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                bufferDuration, 0, pFormat, IntPtr.Zero);
            if (hr != 0) throw new COMException("IAudioClient.Initialize", hr);

            _sampleEvent = CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
            if (_sampleEvent == IntPtr.Zero) throw new InvalidOperationException("CreateEvent failed");
            hr = client.SetEventHandle(_sampleEvent);
            if (hr != 0) throw new COMException("IAudioClient.SetEventHandle", hr);

            hr = client.GetService(IID_IAudioCaptureClient, out object service);
            if (hr != 0) throw new COMException("IAudioClient.GetService", hr);
            capture = (IAudioCaptureClient)service;

            hr = client.Start();
            if (hr != 0) throw new COMException("IAudioClient.Start", hr);
            DebugLog.Write($"AudioCapture: started (pid={targetProcessId}, mode={loopbackMode})");

            var loggedFirst = false;
            while (_running)
            {
                WaitForSingleObject(_sampleEvent, 200);
                while (_running)
                {
                    if (capture.GetNextPacketSize(out uint packetFrames) != 0 || packetFrames == 0) break;
                    if (capture.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _) != 0) break;
                    int bytes = (int)frames * BytesPerFrame;
                    if (bytes > 0)
                    {
                        var buffer = new byte[bytes];
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data != IntPtr.Zero)
                            Marshal.Copy(data, buffer, 0, bytes);
                        _onPcm?.Invoke(buffer);
                        if (!loggedFirst) { DebugLog.Write($"AudioCapture: first packet {bytes} bytes"); loggedFirst = true; }
                    }
                    capture.ReleaseBuffer(frames);
                }
            }
        }
        catch (Exception ex)
        {
            DebugLog.Write($"AudioCapture failed: {ex}");
        }
        finally
        {
            try { client?.Stop(); } catch { /* best effort */ }
            if (capture is not null) Marshal.ReleaseComObject(capture);
            if (client is not null) Marshal.ReleaseComObject(client);
            if (_sampleEvent != IntPtr.Zero) { CloseHandle(_sampleEvent); _sampleEvent = IntPtr.Zero; }
            if (pFormat != IntPtr.Zero) Marshal.FreeHGlobal(pFormat);
            if (pPropVariant != IntPtr.Zero) Marshal.FreeHGlobal(pPropVariant);
            if (pActivation != IntPtr.Zero) Marshal.FreeHGlobal(pActivation);
        }
    }

    public void Dispose() => Stop();
}
