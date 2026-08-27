using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Talkeando.Client;

/// Minimal v1 screen-share viewer: a dedicated window per watched stream,
/// not an embedded WebView2 tile. Chosen over compositing video into the
/// DOM because that would need pixel-accurate native/WebView2 layout sync
/// this session had no way to validate end-to-end — see
/// SDD/27-decisions.md ADR-003 and SDD/31-implementation-status.md for the
/// follow-up task to move this into an embedded tile.
public partial class ScreenShareViewerWindow : Window
{
    private WriteableBitmap? _bitmap;

    public ScreenShareViewerWindow()
    {
        InitializeComponent();
    }

    /// Called from `RtcEngine.RemoteVideoFrameReceived` (already decoded to
    /// BGRA — `PixelFormats.Bgra32` is a byte-for-byte match, no conversion
    /// needed). Safe to call from any thread.
    public void UpdateFrame(uint width, uint height, byte[] bgra)
    {
        Dispatcher.Invoke(() =>
        {
            if (_bitmap is null || _bitmap.PixelWidth != (int)width || _bitmap.PixelHeight != (int)height)
            {
                _bitmap = new WriteableBitmap((int)width, (int)height, 96, 96, PixelFormats.Bgra32, null);
                FrameImage.Source = _bitmap;
                WaitingText.Visibility = Visibility.Collapsed;
            }
            var stride = _bitmap.PixelWidth * 4;
            _bitmap.WritePixels(new Int32Rect(0, 0, _bitmap.PixelWidth, _bitmap.PixelHeight), bgra, stride, 0);
        });
    }
}
